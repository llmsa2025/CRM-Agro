import { randomUUID } from "node:crypto";
import type { Campaign } from "@prisma/client";
import { db } from "@crmagro/db";
import { isChannelSendFailed } from "@crmagro/channels";
import { consumeSendQuota, devolverCotaDeEnvio } from "../channels-limit/service";
import { reservarEnvioAoContato, devolverEnvioAoContato } from "../flows/limites";
import { adiamentoPorJustica, reservarVezDoTime } from "../flows/justica";
import { getNextCallSlot } from "../motor-do-dia/business-hours";
import { configDoTimeComCache, janelaDeEnvioLigada, proximoSlotDeEnvio } from "../motor-do-dia/send-window";
import { toBusinessHoursOptions, type TeamConfigDTO } from "../motor-do-dia/team-config";
import { zonedParts, zonedTimeToUtc } from "../motor-do-dia/tz";
import { getWhatsAppNumber, sendMessage, sendTyping, startConversationWithContact } from "../conversations/service";
import { redisEstado } from "../shared/redis-cache";
import { publishRealtime } from "../events/redis-bus";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { textoParaContato } from "./service";
import { carregarVariaveis } from "./variaveis";
import { agendarTick, type CampaignJob } from "./queue";

/**
 * Um TICK da campanha (worker, produto §A.3): no máximo UM envio e o
 * agendamento do próximo. Roda no contexto do time (`runAsSystem`).
 *
 * Controle de ritmo NÃO é reimplementado — o envio passa pelo que o motor já usa:
 * janela do time (item 1.3), limite de 3 envios automáticos por contato em
 * 24 h (item 1.4), cota por número com aquecimento (`consumeSendQuota`, que
 * também segura a conta pausada/caída) e as MARCAS de fase do item 1.2. A
 * campanha só acrescenta o próprio ritmo: janela e almoço dela, intervalo
 * sorteado, lotes com pausa, limite diário e os freios.
 *
 * Idempotência por destinatário:
 * - o claim é condicional (`queued → sending`, count 1): dois ticks nunca pegam
 *   o mesmo destinatário;
 * - `enviandoEm` é gravado (condicional) logo ANTES de chamar o canal; um
 *   `sending` achado depois com `enviandoEm` e sem `sent` é INCERTO → segura
 *   (`held`), nunca reenvia sozinho; sem `enviandoEm`, volta para a fila;
 * - só uma corrente de ticks vale (`tickToken`), e só um tick por campanha roda
 *   de cada vez (trava `campanha:tick:<id>` com token).
 *
 * Justiça e número compartilhado:
 * - cada tick pede a vez no MESMO balde por time do motor (item 1.9): um time
 *   com dezenas de campanhas não atrasa a campanha do vizinho;
 * - o intervalo mínimo vale POR NÚMERO (`campanha:espaco:<conta>`): duas
 *   campanhas no mesmo número não somam o ritmo.
 */

/** O contato pediu para sair entre o claim e o envio: não envia (antes da marca). */
class PediuParaSairNoMeio extends Error {
  constructor() {
    super("PediuParaSairNoMeio: o contato pediu para sair antes do envio.");
    this.name = "PediuParaSairNoMeio";
  }
}

/** Tick ocupado (outro da mesma campanha segura a trava): o BullMQ tenta de novo. */
export class TickOcupado extends Error {
  constructor(campaignId: string) {
    super(`TickOcupado: campanha ${campaignId} já tem um tick rodando.`);
    this.name = "TickOcupado";
  }
}

export type DesfechoDoTick =
  | "corrente_morta"
  | "aguardando_inicio"
  | "fora_da_janela"
  | "pausa_de_lote"
  | "limite_diario"
  | "freio"
  | "sem_fila"
  | "concluida"
  | "enviado"
  | "adiado"
  | "pulado"
  | "falhou"
  | "incerto";

/** `sending` parado há mais que isto é de um tick que morreu no meio. */
export const CLAIM_VENCIDO_MS = 10 * 60_000;
/** Só avalia o freio de saídas com uma base mínima de envios. */
export const BASE_MINIMA_FREIO_SAIDAS = 20;
/** Tentativas de "não saiu, repetível" antes de `failed` (backoff do item 1.2). */
export const BACKOFF_CAMPANHA_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
/**
 * Espaço mínimo entre mensagens de campanha do MESMO número (todas as
 * campanhas dele): guarda "livre a partir de" (ms, relógio de quem chama) e só
 * libera quem chegar depois. 0 = pode; > 0 = ms a esperar.
 */
const ESPACO_LUA = `
local livre = tonumber(redis.call('GET', KEYS[1]) or '0')
local agora = tonumber(ARGV[1])
if livre > agora then return livre - agora end
redis.call('SET', KEYS[1], tostring(agora + tonumber(ARGV[2])), 'PX', tonumber(ARGV[2]) + 60000)
return 0
`;
/** Solta o espaço reservado quando nada saiu (só se ainda for a MESMA reserva). */
const SOLTAR_ESPACO_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const chaveEspaco = (contaId: string) => `campanha:espaco:${contaId}`;

/** Próximo tick quando NADA saiu (pulado/falhou/adiado curto): sem o intervalo. */
const PROXIMO_SEM_ENVIO_MS = 5_000;
/** "Digitando…" antes da mensagem. */
const DIGITANDO_MIN_MS = 2_000;
const DIGITANDO_MAX_MS = 5_000;
const TRAVA_TICK_MS = 2 * 60_000;

const sorteio = (min: number, max: number, aleatorio: () => number) => min + Math.round(aleatorio() * Math.max(0, max - min));

type Ritmo = Pick<
  Campaign,
  | "janelaInicio"
  | "janelaFim"
  | "pausaAlmocoInicio"
  | "pausaAlmocoFim"
  | "intervaloMinS"
  | "intervaloMaxS"
  | "pausaLoteMinM"
  | "pausaLoteMaxM"
>;

/**
 * Próximo instante em que a campanha pode enviar: dentro da janela DELA (os dois
 * turnos, sem o almoço), num dia útil e sem feriado do time, E dentro da janela
 * de envio do time (item 1.3) quando ligada. O próprio `agora` se já pode.
 */
export function proximaJanelaDaCampanha(agora: Date, c: Ritmo, cfg: TeamConfigDTO): Date {
  const base = { ...toBusinessHoursOptions(cfg), respectBusinessHours: true };
  const turnos: Array<[string, string]> =
    c.pausaAlmocoInicio && c.pausaAlmocoFim
      ? [
          [c.janelaInicio, c.pausaAlmocoInicio],
          [c.pausaAlmocoFim, c.janelaFim],
        ]
      : [[c.janelaInicio, c.janelaFim]];
  const daCampanha = (d: Date) =>
    new Date(
      Math.min(
        ...turnos.map(([ini, fim]) => getNextCallSlot(d, { ...base, businessHourStart: ini, businessHourEnd: fim }).getTime()),
      ),
    );
  let s = daCampanha(agora);
  if (!janelaDeEnvioLigada()) return s;
  // As duas janelas juntas: anda até um instante que as duas aceitam.
  for (let i = 0; i < 8; i++) {
    const t = proximoSlotDeEnvio(s, cfg);
    if (t.getTime() === s.getTime()) return s;
    s = daCampanha(t);
  }
  return s;
}

/** Início do dia (fuso do time) — para o limite diário da campanha. */
function inicioDoDia(agora: Date, tz: string): Date {
  const p = zonedParts(agora, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

type Opcoes = { agora?: Date; aleatorio?: () => number };

/**
 * Processa um tick. Devolve o desfecho (log/testes). Agenda o próximo tick da
 * corrente, exceto quando a corrente acabou (morta, pausada, concluída).
 */
export async function processarTickDaCampanha(
  job: Extract<CampaignJob, { kind: "tick" }>,
  opts: Opcoes = {},
): Promise<DesfechoDoTick> {
  // Envia em nome do time: o worker roda como sistema (§12h).
  requireCan("campaigns.start");
  const trava = `campanha:tick:${job.campaignId}`;
  const meu = randomUUID();
  if ((await redisEstado().set(trava, meu, "PX", TRAVA_TICK_MS, "NX")) !== "OK") throw new TickOcupado(job.campaignId);
  try {
    const r = await tick(job, opts);
    // A tela "Em andamento" relê quando algo mudou (envio, freio, fim).
    if (MUDOU_A_TELA.has(r.desfecho)) {
      publishRealtime({ type: "campaign:changed", campaignId: job.campaignId, desfecho: r.desfecho }, job.teamId);
    }
    if (r.proximoEmMs !== null) {
      await agendarTick({ teamId: job.teamId, campaignId: job.campaignId, token: job.token, seq: job.seq + 1, delayMs: r.proximoEmMs });
    }
    return r.desfecho;
  } finally {
    await redisEstado()
      .eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`, 1, trava, meu)
      .catch(() => undefined); // expira sozinha
  }
}

type Resultado = { desfecho: DesfechoDoTick; proximoEmMs: number | null };

/** Desfechos que mudam números ou estado na tela (os outros só reagendam). */
const MUDOU_A_TELA: ReadonlySet<DesfechoDoTick> = new Set(["enviado", "pulado", "falhou", "incerto", "freio", "concluida"]);

async function pausarPorFreio(c: Campaign, motivo: string): Promise<Resultado> {
  // Condicional ao token: um "Retomar" no meio não é desfeito pelo freio velho.
  await db().campaign.updateMany({
    where: { id: c.id, tickToken: c.tickToken, status: { in: ["sending", "scheduled"] } },
    data: { status: "paused", pausadoMotivo: motivo, tickToken: null },
  });
  logger.warn({ campaignId: c.id, motivo }, "[campanha] freio automático — campanha pausada");
  return { desfecho: "freio", proximoEmMs: null };
}

async function tick(job: Extract<CampaignJob, { kind: "tick" }>, opts: Opcoes): Promise<Resultado> {
  const prisma = db();
  const agora = opts.agora ?? new Date();
  const aleatorio = opts.aleatorio ?? Math.random;
  const c = await prisma.campaign.findUnique({ where: { id: job.campaignId } });
  if (!c || c.tickToken !== job.token || (c.status !== "sending" && c.status !== "scheduled")) {
    return { desfecho: "corrente_morta", proximoEmMs: null };
  }
  // Vez do time no balde do motor (item 1.9): sem ficha, espera ~5 s.
  const vez = await reservarVezDoTime(job.teamId, { agora: agora.getTime() });
  if (vez > 0) return { desfecho: "adiado", proximoEmMs: adiamentoPorJustica(vez) };
  if (c.status === "scheduled") {
    if (c.iniciaEm && c.iniciaEm > agora) return { desfecho: "aguardando_inicio", proximoEmMs: c.iniciaEm.getTime() - agora.getTime() };
    await prisma.campaign.updateMany({ where: { id: c.id, tickToken: job.token }, data: { status: "sending" } });
  }

  // Claims de tick que morreu no meio (processo caiu): incerto segura, o resto volta.
  const vencido = new Date(agora.getTime() - CLAIM_VENCIDO_MS);
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: c.id, status: "sending", reservadoEm: { lt: vencido }, enviandoEm: { not: null } },
    data: { status: "held", motivo: "resultado incerto, conferir no WhatsApp" },
  });
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: c.id, status: "sending", reservadoEm: { lt: vencido }, enviandoEm: null },
    data: { status: "queued", reservadoEm: null },
  });

  // Freios.
  if (c.falhasSeguidas >= c.freioFalhasSeq) return pausarPorFreio(c, `${c.falhasSeguidas} falhas seguidas`);
  const grupos = await prisma.campaignRecipient.groupBy({
    by: ["status"],
    where: { campaignId: c.id, status: { in: ["sent", "delivered", "read", "replied", "opted_out"] } },
    _count: { _all: true },
  });
  const saiu = grupos.reduce((n, g) => n + g._count._all, 0);
  const saidas = grupos.find((g) => g.status === "opted_out")?._count._all ?? 0;
  if (saiu >= BASE_MINIMA_FREIO_SAIDAS && (saidas / saiu) * 100 > c.freioSaidasPct) {
    return pausarPorFreio(c, `pedidos de saída acima de ${c.freioSaidasPct}% (${saidas} de ${saiu})`);
  }
  const conta = c.channelAccountId
    ? await prisma.channelAccount.findUnique({ where: { id: c.channelAccountId }, select: { id: true, status: true, paused: true } })
    : null;
  if (!conta) return pausarPorFreio(c, "o número que envia não existe mais");
  // Pausa MANUAL ou pela saúde do número (taxa de erro) → a campanha para e
  // alguém olha. Queda da conexão NÃO pausa: a cota adia (~10 min / ~45 min).
  if (conta.paused && conta.status !== "disconnected") return pausarPorFreio(c, "o número foi pausado (saúde do número)");

  // Janela da campanha + janela do time (item 1.3).
  const cfg = await configDoTimeComCache(agora.getTime());
  const abre = proximaJanelaDaCampanha(agora, c, cfg);
  if (abre.getTime() > agora.getTime()) {
    return { desfecho: "fora_da_janela", proximoEmMs: abre.getTime() - agora.getTime() + sorteio(0, 10 * 60_000, aleatorio) };
  }

  // Pausa de lote.
  if (c.enviadosNoLote >= c.loteTamanho) {
    await prisma.campaign.updateMany({ where: { id: c.id, tickToken: job.token }, data: { enviadosNoLote: 0 } });
    return { desfecho: "pausa_de_lote", proximoEmMs: sorteio(c.pausaLoteMinM, c.pausaLoteMaxM, aleatorio) * 60_000 };
  }

  // Limite diário da campanha (a cota do número vale por cima).
  if (c.limiteDiario) {
    const hoje = await prisma.campaignRecipient.count({ where: { campaignId: c.id, sentAt: { gte: inicioDoDia(agora, cfg.timezone) } } });
    if (hoje >= c.limiteDiario) {
      const amanha = proximaJanelaDaCampanha(new Date(inicioDoDia(agora, cfg.timezone).getTime() + 24 * 3_600_000), c, cfg);
      return { desfecho: "limite_diario", proximoEmMs: amanha.getTime() - agora.getTime() + sorteio(0, 30 * 60_000, aleatorio) };
    }
  }

  // Próximo da fila (ordem de criação), claim condicional.
  const proximo = await prisma.campaignRecipient.findFirst({
    where: { campaignId: c.id, status: "queued", OR: [{ scheduledAt: null }, { scheduledAt: { lte: agora } }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, contactId: true, telefone: true, motivo: true, tentativas: true },
  });
  if (!proximo) {
    const depois = await prisma.campaignRecipient.findFirst({
      where: { campaignId: c.id, status: "queued" },
      orderBy: { scheduledAt: "asc" },
      select: { scheduledAt: true },
    });
    if (depois?.scheduledAt) return { desfecho: "sem_fila", proximoEmMs: Math.max(PROXIMO_SEM_ENVIO_MS, depois.scheduledAt.getTime() - agora.getTime()) };
    const emCurso = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: "sending" } });
    if (emCurso > 0) return { desfecho: "sem_fila", proximoEmMs: CLAIM_VENCIDO_MS };
    await prisma.campaign.updateMany({
      where: { id: c.id, tickToken: job.token },
      data: { status: "done", concluidaEm: agora, tickToken: null },
    });
    return { desfecho: "concluida", proximoEmMs: null };
  }
  // Espaço mínimo do NÚMERO (outra campanha dele pode ter acabado de enviar).
  const espacoMs = c.intervaloMinS * 1000;
  let esperaEspaco = 0;
  try {
    esperaEspaco = Number(await redisEstado().eval(ESPACO_LUA, 1, chaveEspaco(conta.id), String(agora.getTime()), String(espacoMs))) || 0;
  } catch {
    esperaEspaco = 0; // Redis fora: a trava do tick também depende dele; segue pelo intervalo da campanha
  }
  if (esperaEspaco > 0) return { desfecho: "adiado", proximoEmMs: esperaEspaco + sorteio(0, 15_000, aleatorio) };
  const soltarEspaco = () =>
    redisEstado()
      .eval(SOLTAR_ESPACO_LUA, 1, chaveEspaco(conta.id), String(agora.getTime() + espacoMs))
      .catch(() => undefined);

  const { count: peguei } = await prisma.campaignRecipient.updateMany({
    where: { id: proximo.id, status: "queued" },
    data: { status: "sending", reservadoEm: agora, enviandoEm: null },
  });
  if (peguei !== 1) {
    await soltarEspaco();
    return { desfecho: "sem_fila", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }

  const r = await enviar(c, conta.id, { ...proximo, claimEm: agora }, agora, aleatorio);
  // Nada saiu (pulado, adiado, falhou sem sair): o número fica livre de novo.
  // Enviado ou incerto: o espaço vale.
  if (r.desfecho !== "enviado" && r.desfecho !== "incerto") await soltarEspaco();
  return r;
}

type Destinatario = {
  id: string;
  contactId: string;
  telefone: string | null;
  motivo: string | null;
  tentativas: number;
  /** Instante do claim: toda escrita no destinatário confere que o claim ainda é ESTE. */
  claimEm: Date;
};

/** Volta o destinatário para a fila (nada saiu) — opcionalmente só depois de `em`. */
async function voltarParaFila(r: Destinatario, em: Date | null, dados: { tentativas?: number } = {}) {
  await db().campaignRecipient.updateMany({
    where: { id: r.id, status: "sending", reservadoEm: r.claimEm },
    data: { status: "queued", reservadoEm: null, enviandoEm: null, scheduledAt: em, ...dados },
  });
}

async function finalizar(r: Destinatario, status: "skipped" | "failed" | "held", motivo: string) {
  await db().campaignRecipient.updateMany({
    where: { id: r.id, status: "sending", reservadoEm: r.claimEm },
    data: { status, motivo: motivo.slice(0, 200) },
  });
}

async function contarFalha(c: Campaign) {
  await db().campaign.updateMany({ where: { id: c.id, tickToken: c.tickToken }, data: { falhasSeguidas: { increment: 1 } } });
}

async function enviar(c: Campaign, contaId: string, r: Destinatario, agora: Date, aleatorio: () => number): Promise<Resultado> {
  const prisma = db();
  // O contato pode ter pedido para sair depois da lista montada.
  const contato = await prisma.contact.findUnique({ where: { id: r.contactId }, select: { relacionamentoStatus: true } });
  if (!contato) {
    await finalizar(r, "skipped", "contato excluído");
    return { desfecho: "pulado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }
  if (contato.relacionamentoStatus === "opt_out") {
    await finalizar(r, "skipped", "pediu para sair");
    return { desfecho: "pulado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }
  const numero = r.telefone ?? (await getWhatsAppNumber(r.contactId));
  if (!numero) {
    await finalizar(r, "skipped", "sem número de WhatsApp");
    return { desfecho: "pulado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }
  if (!c.mensagem) return pausarPorFreio(c, "a campanha está sem mensagem");
  const vars = (await carregarVariaveis([r.contactId])).get(r.contactId);
  const msg = vars ? textoParaContato(c, r, vars, agora) : null;
  if (!msg) {
    // Retomada sem texto de retomada: segura (nunca a mensagem fria).
    await finalizar(r, "held", "sem texto de retomada");
    return { desfecho: "pulado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }

  // Conversa ANTES da cota (item 1.2): falha aqui não gasta envio do dia.
  let conversationId: string;
  try {
    ({ conversationId } = await startConversationWithContact(contaId, r.contactId));
  } catch (e) {
    await voltarParaFila(r, new Date(agora.getTime() + BACKOFF_CAMPANHA_MS[0]));
    await contarFalha(c);
    logger.warn({ campaignId: c.id, recipientId: r.id, err: e instanceof Error ? e.message : String(e) }, "[campanha] conversa não abriu — de volta à fila");
    return { desfecho: "adiado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }

  // Limite por contato (item 1.4) e cota do número com aquecimento — as MESMAS
  // do motor. Sem vez → volta para a fila e o tick espera.
  const vez = await reservarEnvioAoContato(r.contactId);
  if (!vez.ok) {
    await voltarParaFila(r, new Date(agora.getTime() + vez.esperaMs));
    return { desfecho: "adiado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }
  // Limite por dia da campanha preenchido: vale no lugar do aquecimento do número.
  const cota = await consumeSendQuota(contaId, agora, { limite: c.limiteDiario });
  if (!cota.allowed) {
    await devolverEnvioAoContato(r.contactId);
    await voltarParaFila(r, null);
    return { desfecho: "adiado", proximoEmMs: cota.retryAfterMs };
  }

  // "Digitando…" 2–5 s (best-effort; presença nunca derruba o envio).
  await sendTyping(conversationId, sorteio(DIGITANDO_MIN_MS, DIGITANDO_MAX_MS, aleatorio)).catch(() => undefined);

  let providerMessageId: string | null = null;
  try {
    const m = await sendMessage(conversationId, msg.texto, {
      antesDeEnviar: async () => {
        // Último instante antes do canal: o "pare" pode ter chegado durante o
        // "digitando" (o opt-out do A.5 deixa o `sending` para o worker).
        const agoraContato = await prisma.contact.findUnique({ where: { id: r.contactId }, select: { relacionamentoStatus: true } });
        if (agoraContato?.relacionamentoStatus === "opt_out") throw new PediuParaSairNoMeio();
        // Marca de fase: a partir daqui, um erro é INCERTO. Condicional: se o
        // claim foi perdido (vencido e reciclado), NÃO envia.
        const { count } = await prisma.campaignRecipient.updateMany({
          where: { id: r.id, status: "sending", reservadoEm: r.claimEm, enviandoEm: null },
          data: { enviandoEm: new Date() },
        });
        if (count !== 1) throw new Error("ClaimPerdido: destinatário não está mais reservado para este tick");
      },
      depoisDeEnviar: async (pid) => {
        providerMessageId = pid;
        await prisma.campaignRecipient.updateMany({
          where: { id: r.id, status: "sending", reservadoEm: r.claimEm },
          data: { status: "sent", sentAt: new Date(), providerMessageId: pid, variacao: msg.variacao },
        });
      },
    });
    await prisma.campaignRecipient.updateMany({ where: { id: r.id }, data: { messageId: m.id } });
  } catch (e) {
    return tratarFalha(c, contaId, r, e, providerMessageId !== null, agora, { providerMessageId, variacao: msg.variacao });
  }
  await prisma.campaign.updateMany({
    where: { id: c.id },
    data: { enviadosNoLote: { increment: 1 }, falhasSeguidas: 0, ultimoEnvioEm: agora },
  });
  return { desfecho: "enviado", proximoEmMs: sorteio(c.intervaloMinS, c.intervaloMaxS, aleatorio) * 1000 };
}

/**
 * Falha no envio, na ordem do item 1.2: já saiu → segue (só o registro local
 * falhou); incerto → segura; não saiu → devolve cota e limite e repete com
 * backoff (5/15/60 min) ou falha de vez; erro antes da marca → volta à fila.
 */
async function tratarFalha(
  c: Campaign,
  contaId: string,
  r: Destinatario,
  e: unknown,
  saiu: boolean,
  agora: Date,
  envio: { providerMessageId: string | null; variacao: number } = { providerMessageId: null, variacao: 0 },
): Promise<Resultado> {
  const prisma = db();
  const erro = e instanceof Error ? e.message : String(e);
  if (e instanceof PediuParaSairNoMeio) {
    // Nada saiu: devolve cota e limite e pula (o opt-out já pulou o resto).
    await devolverCotaDeEnvio(contaId, agora).catch(() => undefined);
    await devolverEnvioAoContato(r.contactId);
    await finalizar(r, "skipped", "pediu para sair");
    return { desfecho: "pulado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }
  if (saiu) {
    // Saiu. Se o que falhou foi justamente gravar o `sent` (no gancho), tenta
    // de novo aqui (auditoria do #125) — senão o destinatário ficava `sending`
    // e virava "incerto" para revisão humana à toa. Idempotente pelo claim.
    await prisma.campaignRecipient
      .updateMany({
        where: { id: r.id, status: "sending", reservadoEm: r.claimEm },
        data: { status: "sent", sentAt: agora, providerMessageId: envio.providerMessageId, variacao: envio.variacao },
      })
      .catch((e2) => logger.error({ recipientId: r.id, err: e2 instanceof Error ? e2.message : String(e2) }, "[campanha] enviado, mas não consegui gravar o 'enviado'"));
    logger.warn({ campaignId: c.id, recipientId: r.id, err: erro }, "[campanha] enviado, mas o registro local falhou");
    return { desfecho: "enviado", proximoEmMs: c.intervaloMinS * 1000 };
  }
  const atual = await prisma.campaignRecipient.findUnique({ where: { id: r.id }, select: { enviandoEm: true, reservadoEm: true } });
  // Claim perdido (vencido e reciclado por outro tick): não é mais nosso — nada a fazer.
  if (atual?.reservadoEm?.getTime() !== r.claimEm.getTime()) return { desfecho: "adiado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  const passouDaMarca = Boolean(atual?.enviandoEm);

  if (isChannelSendFailed(e) && e.outcome === "not_sent") {
    await devolverCotaDeEnvio(contaId, agora).catch(() => undefined);
    await devolverEnvioAoContato(r.contactId);
    await contarFalha(c);
    if (e.retryable && r.tentativas < BACKOFF_CAMPANHA_MS.length) {
      await voltarParaFila(r, new Date(agora.getTime() + BACKOFF_CAMPANHA_MS[r.tentativas]!), { tentativas: r.tentativas + 1 });
      return { desfecho: "adiado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
    }
    await finalizar(r, "failed", `não saiu: ${erro}`);
    return { desfecho: "falhou", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }
  if ((isChannelSendFailed(e) && e.outcome === "unknown") || passouDaMarca) {
    // Pode ter saído: NUNCA reenvia sozinho. Cota e limite ficam gastos.
    await contarFalha(c);
    await finalizar(r, "held", "resultado incerto, conferir no WhatsApp");
    logger.warn({ campaignId: c.id, recipientId: r.id, err: erro }, "[campanha] envio incerto — segurado para revisão");
    return { desfecho: "incerto", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
  }
  // Erro antes da marca (ex.: conversa, claim perdido): nada saiu.
  await devolverCotaDeEnvio(contaId, agora).catch(() => undefined);
  await devolverEnvioAoContato(r.contactId);
  await voltarParaFila(r, new Date(agora.getTime() + BACKOFF_CAMPANHA_MS[0]));
  await contarFalha(c);
  logger.warn({ campaignId: c.id, recipientId: r.id, err: erro }, "[campanha] falha antes do envio — de volta à fila");
  return { desfecho: "adiado", proximoEmMs: PROXIMO_SEM_ENVIO_MS };
}

