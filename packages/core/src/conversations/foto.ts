import { env } from "@crmagro/config";
import { db } from "@crmagro/db";
import { baixarFotoDePerfil, fetchEvolutionProfilePictureUrl, type FotoBaixada } from "@crmagro/channels";
import { valorDe, numeroDe } from "../contacts/identificadores-cifra";
import { logger } from "../logger/index";
import { escopoConversa } from "./escopo";
import { ehLid } from "./nome";

/**
 * Foto de perfil do WhatsApp de quem está na conversa, para a tela de Conversas (lista, cabeçalho e o pop-up).
 *
 * O endereço da foto é do CDN do WhatsApp e expira em horas, e a imagem é dado de uma pessoa: o servidor busca na
 * hora do pedido e devolve os bytes, sem gravar nada (nem a imagem, nem o endereço). Quem guarda por um tempo é o
 * navegador de quem pediu (`Cache-Control: private`, definido pela rota).
 *
 * Só vê a foto quem vê a conversa (`escopoConversa`). Conversa fora do escopo, de outro canal ou sem número dá
 * `sem_foto`, igual a quem não tem foto: a resposta não conta se a conversa existe.
 */

export type FotoDaConversa =
  /** Achou a foto. */
  | { estado: "ok"; foto: FotoBaixada }
  /** Não há foto para mostrar (escondida, não tem, conversa sem telefone, canal sem foto). Vale por um tempo. */
  | { estado: "sem_foto" }
  /** Não deu para perguntar agora (WhatsApp desconectado ou sem resposta). Tentar de novo logo. */
  | { estado: "indisponivel" };

/** A tela pede a foto de todas as conversas da lista ao mesmo tempo: segura o excesso para não rajar o WhatsApp. */
const MAX_BUSCAS_SIMULTANEAS = 4;
let buscando = 0;
const esperando: Array<() => void> = [];

async function comVaga<T>(fn: () => Promise<T>): Promise<T> {
  if (buscando >= MAX_BUSCAS_SIMULTANEAS) await new Promise<void>((liberar) => esperando.push(liberar));
  else buscando++;
  try {
    return await fn();
  } finally {
    const proxima = esperando.shift();
    if (proxima) proxima(); // a vaga passa direto para quem esperava
    else buscando--;
  }
}

/** Roda em runWithTeam. */
export async function fotoDaConversa(conversationId: string): Promise<FotoDaConversa> {
  const prisma = db();
  const c = await prisma.conversation.findFirst({
    where: { id: conversationId, canal: "whatsapp", AND: [escopoConversa()] },
    select: {
      externalNumber: true,
      externalNumberCifrado: true,
      channelAccount: { select: { provider: true, externalId: true, status: true } },
      contact: {
        select: { identifiers: { where: { canal: "whatsapp" }, select: { valor: true, valorCifrado: true, isPrimary: true } } },
      },
    },
  });
  if (!c?.channelAccount) return { estado: "sem_foto" };
  // Só a Evolution sabe buscar a foto de um número.
  if (c.channelAccount.provider !== "evolution" || !c.channelAccount.externalId) return { estado: "sem_foto" };

  const idents = c.contact?.identifiers ?? [];
  const principal = idents.find((i) => i.isPrimary) ?? idents[0];
  const externo = numeroDe(c, "externalNumber", "conversation");
  const numero = (principal ? valorDe(principal) : null) ?? (ehLid(externo) ? null : externo);
  if (!numero) return { estado: "sem_foto" };
  if (c.channelAccount.status !== "connected") return { estado: "indisponivel" };

  const instance = c.channelAccount.externalId;
  try {
    return await comVaga(async () => {
      const url = await fetchEvolutionProfilePictureUrl({
        apiUrl: env.EVOLUTION_API_URL,
        apiKey: env.EVOLUTION_API_KEY,
        instance,
        numero,
      });
      if (!url) return { estado: "sem_foto" } as const;
      const foto = await baixarFotoDePerfil(url);
      return foto ? ({ estado: "ok", foto } as const) : ({ estado: "sem_foto" } as const);
    });
  } catch (e) {
    logger.warn({ conversationId, err: e instanceof Error ? e.message : String(e) }, "[conversas] não deu para buscar a foto do contato");
    return { estado: "indisponivel" };
  }
}
