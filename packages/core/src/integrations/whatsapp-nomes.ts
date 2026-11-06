import { z } from "zod";
import { env } from "@crmagro/config";
import { basePrisma, db, runAsSystem } from "@crmagro/db";
import {
  fetchEvolutionContacts,
  fetchEvolutionInstance,
  phoneVariants,
  type ContatoDaAgenda,
  type InstanciaEvolution,
} from "@crmagro/channels";
import { logger } from "../logger/index";
import { ehLid, nomeDePessoaValido, PREFIXO_ROTULO_LID_ANTIGO } from "../conversations/nome";
import { gravarNoMetaDaConta, type ContaWhatsAppJob } from "./meta-da-conta";
import { numeroDe, valorDe } from "../contacts/identificadores-cifra";

/**
 * Nomes das conversas do WhatsApp (pedido do dono, 28/09). Roda no WORKER, por
 * conta, dentro do job do histórico (`whatsapp-historico.ts`):
 *
 * 1. LIMPA o que ficou errado: conversas com o nome do PRÓPRIO dono da conta
 *    (o `profileName` da instância) — o webhook gravava o pushName de toda
 *    mensagem, inclusive das enviadas pelo celular, em que o pushName é o dele
 *    —, "Você", número no lugar do nome e o rótulo antigo das conversas `@lid`.
 * 2. Lê a AGENDA do celular (`findContacts` da Evolution) e grava o nome salvo
 *    em `Conversation.nomeAgenda` (nível 2 da ordem; ver `conversations/nome.ts`).
 *
 * Não mexe em `Contact.nome`: o cadastro é do usuário (ver o PR do 28/09 — os
 * contatos que herdaram o nome do dono precisam de revisão à mão).
 */

/** De quanto em quanto tempo a agenda é relida (o job do histórico passa a cada minuto). */
export const NOMES_WHATSAPP_INTERVALO_MS = 6 * 60 * 60_000;

const estadoNomesSchema = z.object({
  sincronizadoEm: z.string().datetime(),
  /** Conversas que receberam (ou trocaram) o nome da agenda nesta rodada. */
  agenda: z.number().int().nonnegative(),
  /** Contatos que a Evolution devolveu (0 = agenda desligada na Evolution). */
  contatosNaAgenda: z.number().int().nonnegative(),
  /** Conversas cujo nome errado (do dono, "Você", número) foi apagado. */
  limpas: z.number().int().nonnegative(),
});
export type EstadoNomesWhatsApp = z.infer<typeof estadoNomesSchema>;

export function lerEstadoNomes(meta: unknown): EstadoNomesWhatsApp | null {
  const p = estadoNomesSchema.safeParse((meta as { whatsappNomes?: unknown } | null)?.whatsappNomes);
  return p.success ? p.data : null;
}

/**
 * Apaga o `externalName` errado das conversas da conta (e das órfãs do time,
 * que ficaram sem conta ao desconectar um número). Critérios, todos seguros:
 * - igual ao nome do perfil do DONO da instância — exceto a conversa com o
 *   próprio número do dono ("mensagem para mim"), em que o nome é dele mesmo;
 * - "Você" (pushName que a Evolution grava na mensagem enviada pela API);
 * - só dígitos/pontuação (a Evolution põe o número quando não sabe o nome);
 * - o rótulo antigo das conversas `@lid` da importação do histórico.
 * Idempotente. Devolve quantas conversas foram limpas.
 */
export async function limparNomesErrados(
  conta: ContaWhatsAppJob,
  dono: Pick<InstanciaEvolution, "nomeDoPerfil" | "numeroDoDono">,
): Promise<number> {
  const nomeDono = dono.nomeDoPerfil?.trim() || null;
  const numerosDoDono = phoneVariants(dono.numeroDoDono);
  // Raw SQL por causa do regex; `teamId` explícito (AGENTS.md §12 f).
  return basePrisma.$executeRaw`
    UPDATE "Conversation"
    SET "externalName" = NULL, "updatedAt" = NOW()
    WHERE "teamId" = ${conta.teamId}
      AND "canal" = 'whatsapp'
      AND ("channelAccountId" = ${conta.accountId} OR "channelAccountId" IS NULL)
      AND "externalName" IS NOT NULL
      AND (
        (
          ${nomeDono}::text IS NOT NULL
          AND btrim("externalName") = ${nomeDono}::text
          AND ("externalNumber" IS NULL OR NOT ("externalNumber" = ANY(${numerosDoDono}::text[])))
        )
        OR lower(btrim("externalName")) IN ('você', 'voce')
        OR btrim("externalName") ~ '^[+0-9 ().-]*$'
        OR "externalName" LIKE ${`${PREFIXO_ROTULO_LID_ANTIGO}%`}
      )
  `;
}

/**
 * Grava o nome da AGENDA nas conversas da conta. Casa o telefone com e sem o
 * nono dígito (`phoneVariants`) — pelo número do contato cadastrado ou pelo
 * `externalNumber` — e a conversa `@lid` pelo próprio id. Nunca APAGA um nome
 * já gravado: a lista da Evolution pode vir parcial (ou vazia, com a agenda
 * desligada lá), e sumir com o nome seria pior que mantê-lo.
 */
export async function aplicarNomesDaAgenda(
  conta: ContaWhatsAppJob,
  contatos: ContatoDaAgenda[],
  numeroDoDono: string | null,
): Promise<number> {
  const doDono = new Set(phoneVariants(numeroDoDono));
  const porChave = new Map<string, string>();
  for (const c of contatos) {
    const nome = nomeDePessoaValido(c.nome);
    if (!nome) continue;
    if (c.numero) {
      if (doDono.has(c.numero)) continue; // o próprio dono na agenda
      for (const v of phoneVariants(c.numero)) if (!porChave.has(v)) porChave.set(v, nome);
    } else if (!porChave.has(c.jid)) {
      porChave.set(c.jid, nome);
    }
  }
  if (porChave.size === 0) return 0;

  return runAsSystem(conta.teamId, async () => {
    const prisma = db();
    const conversas = await prisma.conversation.findMany({
      where: { channelAccountId: conta.accountId, canal: "whatsapp" },
      select: {
        id: true,
        externalNumber: true,
        externalNumberCifrado: true,
        nomeAgenda: true,
        contact: { select: { identifiers: { where: { canal: "whatsapp" }, select: { valor: true, valorCifrado: true, isPrimary: true } } } },
      },
    });
    const nomeDe = (numero: string): string | undefined =>
      ehLid(numero) ? porChave.get(numero) : phoneVariants(numero).map((v) => porChave.get(v)).find(Boolean);
    let gravadas = 0;
    for (const c of conversas) {
      const idents = [...(c.contact?.identifiers ?? [])].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      const numeroDaConversa = numeroDe(c, "externalNumber", "conversation");
      const numeros = [...idents.flatMap((i) => valorDe(i) ?? []), ...(numeroDaConversa ? [numeroDaConversa] : [])];
      const nome = numeros.map(nomeDe).find(Boolean);
      if (!nome || nome === c.nomeAgenda) continue;
      await prisma.conversation.updateMany({ where: { id: c.id, teamId: conta.teamId }, data: { nomeAgenda: nome } });
      gravadas++;
    }
    return gravadas;
  });
}

/**
 * Uma rodada por conta: limpa os nomes errados e aplica a agenda. Sem `forcar`,
 * respeita o intervalo (`NOMES_WHATSAPP_INTERVALO_MS`). Devolve null quando não
 * rodou (conta desconectada/excluída, instância sumiu da Evolution, intervalo).
 * Erro de rede/HTTP da Evolution lança (quem chama registra e segue).
 */
export async function sincronizarNomesWhatsApp(
  conta: ContaWhatsAppJob,
  opts: { forcar?: boolean; agora?: Date } = {},
): Promise<EstadoNomesWhatsApp | null> {
  const agora = opts.agora ?? new Date();
  const row = await basePrisma.channelAccount.findFirst({
    where: {
      id: conta.accountId, teamId: conta.teamId, externalId: conta.instance,
      provider: "evolution", canal: "whatsapp", status: "connected",
    },
    select: { meta: true },
  });
  if (!row) return null;
  const anterior = lerEstadoNomes(row.meta);
  if (!opts.forcar && anterior && agora.getTime() - Date.parse(anterior.sincronizadoEm) < NOMES_WHATSAPP_INTERVALO_MS) {
    return null;
  }

  const evo = { apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance: conta.instance };
  const instancia = await fetchEvolutionInstance(evo);
  if (!instancia) {
    logger.warn({ accountId: conta.accountId }, "[wa-nomes] instância não existe na Evolution — nomes não sincronizados");
    return null;
  }
  const limpas = await limparNomesErrados(conta, instancia);
  const contatos = await fetchEvolutionContacts(evo);
  const agenda = await aplicarNomesDaAgenda(conta, contatos, instancia.numeroDoDono);

  // Só DIAGNÓSTICO (leitura): contatos do time que herdaram o nome do dono —
  // pelo "Cadastrar contato", que pré-preenchia o nome exibido. Não alteramos
  // cadastro em massa; o número vai para o log para revisão à mão.
  if (instancia.nomeDoPerfil) {
    const suspeitos = await basePrisma.contact.count({
      where: { teamId: conta.teamId, nome: instancia.nomeDoPerfil },
    });
    if (suspeitos > 0) {
      logger.warn({ accountId: conta.accountId, contatos: suspeitos }, "[wa-nomes] contatos com o nome do dono da conta — revisar à mão");
    }
  }

  const estado: EstadoNomesWhatsApp = {
    sincronizadoEm: agora.toISOString(),
    agenda,
    contatosNaAgenda: contatos.length,
    limpas,
  };
  await gravarNoMetaDaConta(conta, "whatsappNomes", estado);
  logger.info({ accountId: conta.accountId, ...estado }, "[wa-nomes] nomes das conversas sincronizados");
  return estado;
}
