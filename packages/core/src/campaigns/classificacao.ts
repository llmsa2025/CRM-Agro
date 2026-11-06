import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { historicoNaoConfiavel, REGRA_CONTEUDO_NAO_CONFIAVEL } from "../ai/guardas";
import { chamarIa, IaChamadaFalhou, provedoresConectados, textoDaResposta } from "../ai/provedores";
import { enfileirarJobDeIa } from "../ai/queue";
import { getAiMode } from "../integrations/service";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";

/**
 * Classificação da RESPOSTA de campanha (produto §A.5, 2ª metade).
 *
 * Quando o contato responde a uma campanha, a IA do time lê a mensagem que ele
 * recebeu e a que ele mandou e diz o que foi:
 *  - `interessada` → `Contact.interesse = interessado` (só se ainda estava
 *    "não avaliado": nunca desfaz a qualificação de um humano);
 *  - `pediu_depois` → compromisso `follow_up` na Agenda na data que ele pediu
 *    (`quandoVoltar`), quando a data é clara;
 *  - `duvida` → fica para o vendedor responder;
 *  - `saiu` → só SUGESTÃO: nota no histórico "IA sugere: pediu para sair" e
 *    a classificação no destinatário. O opt-out de verdade só com um humano
 *    confirmando (`marcarOptOut`, #112). A regra de opt-out do inbound (N12) já
 *    trata o "pare/sair" explícito ANTES daqui, sem IA;
 *  - `outro` → tratamento manual.
 *
 * Roda num job de SEGUNDO PLANO (fila `ai`, prioridade baixa): chamar a IA
 * dentro do processamento da mensagem recebida seguraria a fila `inbound`.
 * Quem registra a resposta da campanha (A.2b, `registrarRespostaDeCampanha`)
 * chama `agendarClassificacaoDaResposta`.
 *
 * Governança: `aiMode = off` (padrão), sem provedor conectado ou cota do dia
 * esgotada → `outro`, sem chamar a IA. A resposta do contato é conteúdo de
 * TERCEIROS: entra delimitada (`<historico_nao_confiavel>`) e a saída da IA é
 * validada por zod — qualquer coisa fora do formato vira `outro`.
 *
 * Idempotente: o destinatário só é classificado uma vez (compare-and-set em
 * `classificacao IS NULL`); job repetido, retry ou reentrega não duplicam
 * compromisso, nota nem interesse.
 */

export const CLASSES_DE_RESPOSTA = ["interessada", "pediu_depois", "duvida", "saiu", "outro"] as const;
export type ClasseDeResposta = (typeof CLASSES_DE_RESPOSTA)[number];

export const JOB_CLASSIFICAR_RESPOSTA = "classificar-resposta";

export type ClassificacaoJob = {
  kind: typeof JOB_CLASSIFICAR_RESPOSTA;
  teamId: string;
  recipientId: string;
  /** Message RECEBIDA (a resposta do contato). */
  messageId: string;
};

/** Classificações por time por dia (a IA é paga pelo time; teto contra rajada). */
export function limiteDeClassificacaoPorDia(): number {
  return Number(process.env.AI_CLASSIFICACAO_POR_DIA ?? 500);
}

/** Tentativas do job na fila `ai` (passadas a `enfileirarJobDeIa`). */
const TENTATIVAS_DO_JOB = 3;

/** Prazo para pôr o job na fila sem segurar quem chamou (o inbound). */
const PRAZO_ENFILEIRAR_MS = 3_000;

/** Até quanto tempo à frente um "me chama em…" vira compromisso. */
const RETORNO_MAX_DIAS = 366;

/**
 * Agenda a classificação da resposta (chamado por quem registra a resposta da
 * campanha). Um job por destinatário+mensagem (jobId determinístico: a mesma
 * resposta reentregue não enfileira de novo). Não lança: a resposta já foi
 * registrada; sem Redis, o destinatário fica sem classificação (a tela mostra
 * como "a classificar" e o vendedor trata).
 */
export async function agendarClassificacaoDaResposta(input: { recipientId: string; messageId: string }): Promise<void> {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("classificação sem time no contexto");
  const job: ClassificacaoJob = { kind: JOB_CLASSIFICAR_RESPOSTA, teamId, ...input };
  let prazo: ReturnType<typeof setTimeout> | undefined;
  try {
    // A conexão da fila espera o Redis voltar sem prazo (`maxRetriesPerRequest:
    // null`); aqui, dentro do inbound, uma queda curta não pode segurar a
    // mensagem recebida — 3 s e segue sem classificação.
    await Promise.race([
      enfileirarJobDeIa(job, { jobId: `classificar_${input.recipientId}_${input.messageId}`, tentativas: TENTATIVAS_DO_JOB }),
      new Promise<never>((_, rejeitar) => {
        prazo = setTimeout(() => rejeitar(new Error("Redis sem resposta em 3 s")), PRAZO_ENFILEIRAR_MS);
      }),
    ]);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), recipientId: input.recipientId },
      "[campanha] não deu para agendar a classificação da resposta",
    );
  } finally {
    clearTimeout(prazo);
  }
}

// ─── IA ─────────────────────────────────────────────────────────────────────

const respostaDaIaSchema = z.object({
  classe: z.enum(CLASSES_DE_RESPOSTA),
  quandoVoltar: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});
export type ClassificacaoDaIa = { classe: ClasseDeResposta; quandoVoltar: string | null };

// en-CA → "AAAA-MM-DD" no fuso de São Paulo (formatador criado uma vez).
const DIA_SP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

const SISTEMA = [
  "Você classifica a RESPOSTA de um contato a uma mensagem de prospecção enviada por WhatsApp por uma empresa do agronegócio.",
  "Classes:",
  "- interessada: quer saber mais, pede preço/proposta/visita, faz pergunta de compra ou aceita conversar;",
  "- pediu_depois: não agora, mas pede para ser procurado mais tarde (\"me chama semana que vem\", \"depois da colheita\");",
  "- duvida: pergunta quem é, do que se trata ou pede esclarecimento, sem sinal claro de interesse;",
  "- saiu: pede para não ser mais contatado, sair da lista ou parar as mensagens, ou recusa de forma definitiva e hostil;",
  "- outro: qualquer outra coisa (cumprimento, emoji, áudio sem texto, assunto alheio, resposta automática).",
  "Na dúvida entre saiu e outra classe, NÃO use saiu.",
  "Responda SOMENTE um JSON, sem texto em volta: {\"classe\": \"<classe>\", \"quandoVoltar\": \"AAAA-MM-DD\" | null}.",
  "quandoVoltar só em pediu_depois e só quando a resposta indicar uma data ou prazo claro; calcule a partir de HOJE; senão null.",
  REGRA_CONTEUDO_NAO_CONFIAVEL,
].join("\n");

/** Extrai o 1º objeto JSON da resposta (a IA às vezes cerca com ```json). */
function jsonDaResposta(texto: string): unknown {
  const ini = texto.indexOf("{");
  const fim = texto.lastIndexOf("}");
  if (ini < 0 || fim <= ini) return null;
  try {
    return JSON.parse(texto.slice(ini, fim + 1));
  } catch {
    return null;
  }
}

/**
 * Chama a IA do time (com o fallback entre provedores do item 3.5). `null` =
 * sem provedor. Resposta fora do formato → `outro`. Falha transitória (429/5xx)
 * é relançada para o retry do job.
 */
export async function classificarComIa(input: {
  enviada: string;
  recebida: string;
  hoje?: Date;
}): Promise<ClassificacaoDaIa | null> {
  const candidatos = await provedoresConectados();
  if (candidatos.length === 0) return null;
  const hoje = DIA_SP.format(input.hoje ?? new Date());
  const usuario = [
    `HOJE: ${hoje}`,
    "",
    "Mensagem ENVIADA pela empresa:",
    input.enviada.trim().slice(0, 2000) || "(sem texto)",
    "",
    "RESPOSTA do contato:",
    historicoNaoConfiavel(input.recebida.trim().slice(0, 2000)),
  ].join("\n");
  const { data } = await chamarIa(
    candidatos,
    { max_tokens: 200, temperature: 0, system: SISTEMA, messages: [{ role: "user", content: usuario }] },
    { timeoutMs: 30_000 },
  );
  const parsed = respostaDaIaSchema.safeParse(jsonDaResposta(textoDaResposta(data)));
  if (!parsed.success) {
    logger.warn({}, "[campanha] IA devolveu classificação fora do formato — fica como outro");
    return { classe: "outro", quandoVoltar: null };
  }
  const quando = parsed.data.classe === "pediu_depois" ? dataDeRetornoValida(parsed.data.quandoVoltar, hoje) : null;
  return { classe: parsed.data.classe, quandoVoltar: quando };
}

/** Só datas reais, a partir de amanhã e até ~1 ano (a IA pode errar a conta). */
function dataDeRetornoValida(data: string | null | undefined, hoje: string): string | null {
  if (!data) return null;
  const d = new Date(`${data}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== data) return null;
  const base = new Date(`${hoje}T12:00:00.000Z`).getTime();
  const dias = (d.getTime() - base) / 86_400_000;
  return dias >= 1 && dias <= RETORNO_MAX_DIAS ? data : null;
}

/**
 * Consome 1 classificação da cota do dia do time. Redis fora → nega (a IA é
 * paga; sem como contar, não chama).
 */
async function consumirCotaDeClassificacao(teamId: string, agora: Date): Promise<boolean> {
  const chave = `ai:classificacao:${teamId}:${DIA_SP.format(agora)}`;
  try {
    const res = await redisEstado().multi().incr(chave).expire(chave, 2 * 86_400).exec();
    const usadas = Number(res?.[0]?.[1]);
    return Number.isFinite(usadas) && usadas <= limiteDeClassificacaoPorDia();
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e), teamId }, "[campanha] cota de classificação indisponível");
    return false;
  }
}

/** Devolve 1 da cota (a chamada não chegou a ser respondida). Redis fora → segue. */
async function devolverCotaDeClassificacao(teamId: string, agora: Date): Promise<void> {
  try {
    await redisEstado().decr(`ai:classificacao:${teamId}:${DIA_SP.format(agora)}`);
  } catch {
    /* sem Redis: a cota fica 1 a mais — só limita antes */
  }
}

/**
 * Conta as falhas transitórias da IA para este destinatário (o worker passa
 * só os dados do job, não o nº da tentativa). Redis fora → trata como a última
 * (melhor `outro` do que um destinatário sem classificação para sempre).
 */
async function contarFalhaTransitoria(recipientId: string): Promise<number> {
  const chave = `ai:classificacao:falhas:${recipientId}`;
  try {
    const res = await redisEstado().multi().incr(chave).expire(chave, 86_400).exec();
    const n = Number(res?.[0]?.[1]);
    return Number.isFinite(n) ? n : TENTATIVAS_DO_JOB;
  } catch {
    return TENTATIVAS_DO_JOB;
  }
}

// ─── Processamento (worker) ─────────────────────────────────────────────────

export type DesfechoDaClassificacao =
  | { status: "classificado"; classe: ClasseDeResposta; via: "ia" | "regra" | "sem_ia" | "cota" }
  | { status: "ja_classificado" | "sem_destinatario" };

/**
 * Classifica a resposta e aplica os efeitos. Roda no contexto do time
 * (`runAsSystem(job.teamId)` no worker). Lança só em falha transitória da IA
 * (o job tenta de novo).
 */
export async function processarClassificacao(job: ClassificacaoJob, opts: { agora?: Date } = {}): Promise<DesfechoDaClassificacao> {
  // Escreve no destinatário, no contato, na Agenda e no histórico (§12h). O
  // worker entra como sistema do time; contexto sem papel é negado.
  requireCan("contacts.write");
  const prisma = db();
  const agora = opts.agora ?? new Date();
  const dest = await prisma.campaignRecipient.findUnique({
    where: { id: job.recipientId },
    select: {
      id: true,
      status: true,
      classificacao: true,
      contactId: true,
      campaignId: true,
      messageId: true,
      campaign: { select: { nome: true, mensagem: true } },
    },
  });
  if (!dest) return { status: "sem_destinatario" };
  if (dest.classificacao) return { status: "ja_classificado" };

  // A regra de opt-out do inbound (N12) já decidiu: não gasta IA.
  if (dest.status === "opted_out") return gravar(dest, { classe: "saiu", quandoVoltar: null }, "regra", agora, null);

  const [recebida, enviada] = await Promise.all([
    prisma.message.findUnique({ where: { id: job.messageId }, select: { conteudo: true } }),
    dest.messageId ? prisma.message.findUnique({ where: { id: dest.messageId }, select: { conteudo: true } }) : null,
  ]);
  const textoRecebido = recebida?.conteudo?.trim() ?? "";

  if ((await getAiMode()) === "off" || !textoRecebido) {
    return gravar(dest, { classe: "outro", quandoVoltar: null }, "sem_ia", agora, textoRecebido);
  }
  if (!(await consumirCotaDeClassificacao(job.teamId, agora))) {
    return gravar(dest, { classe: "outro", quandoVoltar: null }, "cota", agora, textoRecebido);
  }

  let ia: ClassificacaoDaIa | null;
  try {
    ia = await classificarComIa({
      enviada: enviada?.conteudo ?? dest.campaign.mensagem ?? "",
      recebida: textoRecebido,
      hoje: agora,
    });
  } catch (e) {
    if (e instanceof IaChamadaFalhou && e.transitorio) {
      // A IA não respondeu: a chamada não conta na cota do dia.
      await devolverCotaDeClassificacao(job.teamId, agora);
      // Retry do job (3 tentativas). Na última, o destinatário não fica "a
      // classificar" para sempre: vira `outro` e vai para o vendedor.
      if ((await contarFalhaTransitoria(dest.id)) < TENTATIVAS_DO_JOB) throw e;
      logger.warn({ recipientId: dest.id }, "[campanha] IA indisponível em todas as tentativas — fica como outro");
      return gravar(dest, { classe: "outro", quandoVoltar: null }, "sem_ia", agora, textoRecebido);
    }
    logger.warn({ err: e instanceof Error ? e.message : String(e), recipientId: dest.id }, "[campanha] IA falhou — fica como outro");
    ia = { classe: "outro", quandoVoltar: null };
  }
  if (!ia) return gravar(dest, { classe: "outro", quandoVoltar: null }, "sem_ia", agora, textoRecebido);
  return gravar(dest, ia, "ia", agora, textoRecebido);
}

type Destinatario = { id: string; contactId: string; campaignId: string; campaign: { nome: string } };

/** Grava a classificação (CAS) e, só se foi agora, os efeitos — numa transação. */
async function gravar(
  dest: Destinatario,
  r: ClassificacaoDaIa,
  via: "ia" | "regra" | "sem_ia" | "cota",
  agora: Date,
  textoRecebido: string | null,
): Promise<DesfechoDaClassificacao> {
  const prisma = db();
  const ok = await prisma.$transaction(async (tx) => {
    const { count } = await tx.campaignRecipient.updateMany({
      where: { id: dest.id, classificacao: null },
      data: { classificacao: r.classe },
    });
    if (count !== 1) return false;
    if (via !== "ia") return true; // sem IA: só a classificação (regra/manual)
    const trecho = textoRecebido ? `"${textoRecebido.slice(0, 200)}"` : null;
    if (r.classe === "interessada") {
      await tx.contact.updateMany({ where: { id: dest.contactId, interesse: "nao_avaliado" }, data: { interesse: "interessado" } });
    }
    if (r.classe === "pediu_depois" && r.quandoVoltar) {
      await tx.appointment.create({
        data: tenantData<Prisma.AppointmentUncheckedCreateInput>({
          contactId: dest.contactId,
          tipo: "follow_up",
          titulo: "Retomar contato (pediu para depois)",
          descricao: [`Campanha "${dest.campaign.nome}"`, trecho, "sugerido pela IA ao classificar a resposta"].filter(Boolean).join(" · "),
          // 09:00 em São Paulo (UTC-3, sem horário de verão desde 2019).
          inicio: new Date(`${r.quandoVoltar}T12:00:00.000Z`),
        }),
      });
    }
    if (r.classe === "saiu") {
      await tx.activity.create({
        data: {
          contactId: dest.contactId,
          tipo: "note",
          conteudo: ["IA sugere: pediu para sair", trecho, `campanha "${dest.campaign.nome}"`, "confirme no contato para parar os envios"]
            .filter(Boolean)
            .join(" · "),
          meta: { sugestaoOptOut: true, recipientId: dest.id, campaignId: dest.campaignId },
        } as never,
      });
    }
    return true;
  });
  if (!ok) return { status: "ja_classificado" };
  logger.info({ recipientId: dest.id, classe: r.classe, via, em: agora.toISOString() }, "[campanha] resposta classificada");
  return { status: "classificado", classe: r.classe, via };
}

// ─── Tela ───────────────────────────────────────────────────────────────────

/**
 * Sugestões de saída ainda sem decisão: a IA disse `saiu`, e o contato não foi
 * marcado opt-out. A tela mostra "Confirmar: pediu para sair" (→ `marcarOptOut`)
 * ou "Não pediu" (→ `corrigirClassificacao`).
 */
export async function listarSugestoesDeSaida(campaignId?: string) {
  const prisma = db();
  const rows = await prisma.campaignRecipient.findMany({
    where: {
      classificacao: "saiu",
      status: { not: "opted_out" },
      contact: { relacionamentoStatus: { not: "opt_out" } },
      ...(campaignId ? { campaignId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      campaignId: true,
      repliedAt: true,
      campaign: { select: { nome: true } },
      contact: { select: { id: true, nome: true } },
    },
  });
  return rows.map((r) => ({
    recipientId: r.id,
    campaignId: r.campaignId,
    campanha: r.campaign.nome,
    contactId: r.contact.id,
    contactNome: r.contact.nome,
    repliedAt: r.repliedAt?.toISOString() ?? null,
  }));
}

/** O vendedor corrige a classificação (ex.: a IA sugeriu "saiu" e não era). */
export async function corrigirClassificacao(recipientId: string, classe: ClasseDeResposta): Promise<void> {
  requireCan("contacts.write");
  const valida = z.enum(CLASSES_DE_RESPOSTA).parse(classe);
  const { count } = await db().campaignRecipient.updateMany({ where: { id: recipientId }, data: { classificacao: valida } });
  if (count !== 1) throw new DestinatarioNaoEncontrado(recipientId);
}

export class DestinatarioNaoEncontrado extends Error {
  constructor(id: string) {
    super(`destinatário de campanha não encontrado: ${id}`);
    this.name = "DestinatarioNaoEncontrado";
  }
}
