import type { Prisma } from "@prisma/client";
import { basePrisma } from "@crmagro/db";
import { env } from "@crmagro/config";
import { descobrirTelefoneDoLid, phoneVariants } from "@crmagro/channels";
import { logger } from "../logger/index";
import { nomeSugeridoDaConversa } from "./nome";
import { lerParesLid } from "./lid-mapa";
import { ondeConversaPorNumero, ondeIdentificadorExato } from "../contacts/identificadores-cifra";

/**
 * Revisão (SÓ LEITURA) das conversas "sem número" (`…@lid`): lista as que já têm
 * par com número, para o dono revisar ANTES de qualquer unificação. Usada pelo
 * script `script de operação`; roda cruzando times (`basePrisma`,
 * sem contexto), por isso o `teamId` é conferido linha a linha.
 *
 * Não grava nada em lugar nenhum: todas as leituras do banco rodam em transação
 * `READ ONLY` (o Postgres recusa qualquer escrita) e a Evolution só é LIDA
 * (`findMessages`), nunca recebe mensagem para enviar. Nada é unificado aqui:
 * quem unifica é a pessoa, conversa a conversa, pelo menu "Unificar com o
 * contato".
 */

export type DestinoDoPar =
  /**
   * Existe um contato com esse número. Se ele já tem conversa nesta conta
   * (`conversationId`), unificar junta as duas; senão, a conversa sem número
   * passa a ser a conversa do contato.
   */
  | { tipo: "contato"; nome: string; conversationId: string | null; mensagens: number }
  /** Existe uma conversa solta (sem contato) com esse número nesta conta. */
  | { tipo: "conversa_solta"; conversationId: string; mensagens: number }
  /** Ninguém com esse número: unificar só daria o número à conversa sem número. */
  | { tipo: "nenhum" };

export type LinhaLid = {
  teamId: string;
  time: string;
  conversationId: string;
  conta: string;
  /** Nome da agenda ou do perfil (nunca número). */
  nome: string | null;
  /** Final do código anônimo, só para diferenciar linhas. */
  lidFinal: string;
  mensagens: number;
  ultimaEm: Date | null;
  telefone: string | null;
  fonte: "mapa" | "evolution" | null;
  destino: DestinoDoPar;
};

export type RevisaoLid = {
  /** Número descoberto E contato ou conversa do número: candidatas a unificar. */
  comPar: LinhaLid[];
  /** Número descoberto, sem ninguém com esse número: unificar só revelaria o número. */
  soNumero: LinhaLid[];
  /** Sem número descoberto (só existe o @lid). */
  semNumero: LinhaLid[];
  /** A Evolution falhou nesta quantidade de consultas (o número pode existir). */
  consultasComFalha: number;
};

/** Executa `fn` numa transação READ ONLY: qualquer escrita dentro dela é recusada pelo Postgres. */
export async function somenteLeitura<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return basePrisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return fn(tx);
    },
    { timeout: 60_000 },
  );
}

/** "+5566999998888" → "+5566…8888": o dono reconhece, e o log não vaza o número inteiro. */
export function mascararTelefone(telefone: string): string {
  const d = telefone.replace(/\D/g, "");
  return d.length <= 8 ? "…" + d.slice(-4) : `+${d.slice(0, 4)}…${d.slice(-4)}`;
}

/** Prazo entre consultas à Evolution e limite de falhas seguidas antes de desistir. */
const PAUSA_ENTRE_CONSULTAS_MS = 150;
const FALHAS_SEGUIDAS_MAX = 5;

export async function listarConversasLidParaRevisao(
  opts: { teamId?: string; consultarEvolution?: boolean; pausaMs?: number } = {},
): Promise<RevisaoLid> {
  const pausa = opts.pausaMs ?? PAUSA_ENTRE_CONSULTAS_MS;
  const dormir = (ms: number) => (ms > 0 ? new Promise<void>((ok) => setTimeout(ok, ms)) : Promise.resolve());

  // 1) As conversas sem número e o que o mapa já sabe (uma leitura, READ ONLY).
  const { convs, mapa } = await somenteLeitura(async (tx) => {
    const convs = await tx.conversation.findMany({
      where: {
        canal: "whatsapp",
        contactId: null,
        externalNumber: { endsWith: "@lid" },
        ...(opts.teamId ? { teamId: opts.teamId } : {}),
      },
      select: {
        id: true,
        teamId: true,
        channelAccountId: true,
        externalNumber: true,
        externalName: true,
        nomeAgenda: true,
        lastMessageAt: true,
        team: { select: { name: true } },
        channelAccount: { select: { label: true, externalId: true, provider: true } },
        _count: { select: { messages: true } },
      },
      orderBy: [{ teamId: "asc" }, { lastMessageAt: { sort: "desc", nulls: "last" } }],
    });
    // Mapa por time (o mesmo @lid em dois times são pares independentes).
    const mapa = new Map<string, { telefone: string }>();
    for (const teamId of new Set(convs.map((c) => c.teamId))) {
      const lids = convs.filter((c) => c.teamId === teamId).map((c) => c.externalNumber!);
      for (const [lid, par] of await lerParesLid(tx, teamId, lids)) mapa.set(`${teamId}|${lid}`, par);
    }
    return { convs, mapa };
  });

  // 2) O que o mapa não sabe, pergunta ao banco da Evolution (SÓ leitura, uma
  //    conversa por vez, com pausa). Falhas seguidas demais: para de tentar.
  const achados = new Map<string, string>();
  let consultasComFalha = 0;
  let falhasSeguidas = 0;
  if (opts.consultarEvolution !== false) {
    for (const c of convs) {
      const chave = `${c.teamId}|${c.externalNumber}`;
      const instance = c.channelAccount?.provider === "evolution" ? c.channelAccount.externalId : null;
      if (mapa.has(chave) || achados.has(chave) || !instance) continue;
      if (falhasSeguidas >= FALHAS_SEGUIDAS_MAX) {
        consultasComFalha++;
        continue;
      }
      try {
        const telefone = await descobrirTelefoneDoLid({
          apiUrl: env.EVOLUTION_API_URL,
          apiKey: env.EVOLUTION_API_KEY,
          instance,
          lid: c.externalNumber!,
        });
        falhasSeguidas = 0;
        if (telefone) achados.set(chave, telefone);
      } catch (e) {
        falhasSeguidas++;
        consultasComFalha++;
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[wa-lid] consulta à Evolution falhou na revisão");
      }
      await dormir(pausa);
    }
  }

  // 3) Para cada número achado, quem é o dono dele neste time (READ ONLY de novo).
  const linhas = await somenteLeitura(async (tx) => {
    const out: LinhaLid[] = [];
    for (const c of convs) {
      const chave = `${c.teamId}|${c.externalNumber}`;
      const doMapa = mapa.get(chave)?.telefone ?? null;
      const daEvolution = achados.get(chave) ?? null;
      const telefone = doMapa ?? daEvolution;
      let destino: DestinoDoPar = { tipo: "nenhum" };
      if (telefone) {
        const variantes = phoneVariants(telefone);
        const dono = await tx.channelIdentifier.findFirst({
          where: { teamId: c.teamId, ...ondeIdentificadorExato(c.teamId, "whatsapp", variantes) },
          select: { contactId: true, contact: { select: { nome: true } } },
        });
        if (dono) {
          const daConta = await tx.conversation.findFirst({
            where: { teamId: c.teamId, contactId: dono.contactId, canal: "whatsapp", channelAccountId: c.channelAccountId },
            select: { id: true, _count: { select: { messages: true } } },
          });
          destino = { tipo: "contato", nome: dono.contact.nome, conversationId: daConta?.id ?? null, mensagens: daConta?._count.messages ?? 0 };
        } else {
          const solta = await tx.conversation.findFirst({
            where: { teamId: c.teamId, channelAccountId: c.channelAccountId, contactId: null, ...ondeConversaPorNumero(c.teamId, variantes) },
            select: { id: true, _count: { select: { messages: true } } },
          });
          if (solta) destino = { tipo: "conversa_solta", conversationId: solta.id, mensagens: solta._count.messages };
        }
      }
      out.push({
        teamId: c.teamId,
        time: c.team.name,
        conversationId: c.id,
        conta: c.channelAccount?.label ?? "(sem conta)",
        nome: nomeSugeridoDaConversa({ nomeAgenda: c.nomeAgenda, externalName: c.externalName }),
        lidFinal: `…${c.externalNumber!.replace(/@.+$/, "").slice(-4)}`,
        mensagens: c._count.messages,
        ultimaEm: c.lastMessageAt,
        telefone,
        fonte: doMapa ? "mapa" : daEvolution ? "evolution" : null,
        destino,
      });
    }
    return out;
  });

  return {
    comPar: linhas.filter((l) => l.telefone && l.destino.tipo !== "nenhum"),
    soNumero: linhas.filter((l) => l.telefone && l.destino.tipo === "nenhum"),
    semNumero: linhas.filter((l) => !l.telefone),
    consultasComFalha,
  };
}
