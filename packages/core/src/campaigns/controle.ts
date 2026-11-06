import { randomUUID } from "node:crypto";
import type { Campaign } from "@prisma/client";
import { db } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { effectiveDailyLimit } from "../channels-limit/service";
import { configDoTimeComCache, proximoSlotDeEnvio } from "../motor-do-dia/send-window";
import { CampaignNotFound, getCampaign, lerEstadoDaLista, reaplicarRegraJaConversou, type CampaignDTO } from "./service";
import type { RegraJaConversou } from "./schema";
import { agendarTick } from "./queue";
import { escopoCampanha } from "./escopo";
import { assertOwned } from "../tenancy/assert-owned";
import type { UsoDoEscopo } from "../tenancy/escopo";

/**
 * Campanhas — iniciar, pausar, retomar, cancelar e previsão de término
 * (produto §A.2). O envio em si é do worker (A.3): aqui só se liga/desliga a
 * CORRENTE de ticks. `tickToken` identifica a corrente válida — pausar zera o
 * token (o tick que já estava agendado acha outro token e sai sem enviar);
 * retomar cria um token novo.
 *
 * Iniciar, retomar e liberar segurados DISPARAM envio em massa
 * (`campaigns.start`). Decisão do dono (27/09): vale para admin E member — o
 * ritmo, a janela, o teto diário e os freios seguram o volume. Pausar
 * (`campaigns.write`) também é de quem opera: parar nunca depende de um admin.
 */

/** Não dá para iniciar/retomar: o motivo vai para a tela. */
export class CampaignNaoPodeIniciar extends Error {
  constructor(readonly motivos: string[]) {
    super(`CampaignNaoPodeIniciar: ${motivos.join("; ")}.`);
    this.name = "CampaignNaoPodeIniciar";
  }
}

/** Mudança de estado impossível (ex.: retomar campanha concluída). */
export class CampaignEstadoInvalido extends Error {
  constructor(readonly status: string, acao: string) {
    super(`CampaignEstadoInvalido: não dá para ${acao} uma campanha "${status}".`);
    this.name = "CampaignEstadoInvalido";
  }
}

async function campanhaDoTime(id: string, uso: UsoDoEscopo = {}): Promise<Campaign> {
  // F3: e do escopo de quem pede (as dele + as compartilhadas; o sistema vê todas).
  const c = await db().campaign.findFirst({ where: { AND: [{ id }, escopoCampanha()] } });
  if (!c) throw new CampaignNotFound(id);
  // Escrita: com "Ver de todos" em Campanhas, lê a do colega mas não altera.
  if (uso.escrita) await assertOwned("campaign", id);
  return c;
}

/** Pré-requisitos de envio: conta conectada e livre, mensagem, lista pronta, fila. */
async function conferirParaEnviar(c: Campaign): Promise<void> {
  const motivos: string[] = [];
  const conta = c.channelAccountId
    ? await db().channelAccount.findUnique({ where: { id: c.channelAccountId }, select: { status: true, paused: true } })
    : null;
  if (!conta) motivos.push("escolha o número que envia");
  else if (conta.status !== "connected") motivos.push("o número está desconectado");
  else if (conta.paused) motivos.push("o número está pausado");
  if (!c.mensagem) motivos.push("escreva a mensagem");
  const lista = lerEstadoDaLista(c.listaOrigem);
  if (lista?.estado === "processando") motivos.push("a lista ainda está sendo montada");
  if (lista?.estado === "erro") motivos.push("a lista deu erro: monte de novo");
  // O histórico do celular é POR NÚMERO: lista checada com outra conta não vale
  // para a que envia (auditoria do #108).
  if (lista?.contaDaChecagem && c.channelAccountId && lista.contaDaChecagem !== c.channelAccountId) {
    motivos.push("a lista foi checada com outro número: monte a lista de novo");
  }
  const naFila = await db().campaignRecipient.count({ where: { campaignId: c.id, status: "queued" } });
  if (naFila === 0) motivos.push("ninguém na fila");
  if (!c.textoRetomada) {
    const retomada = await db().campaignRecipient.count({ where: { campaignId: c.id, status: "queued", motivo: "retomada" } });
    if (retomada > 0) motivos.push("escreva o texto de retomada para quem já conversou");
  }
  if (motivos.length) throw new CampaignNaoPodeIniciar(motivos);
}

/** Começa a enviar (ou agenda para `iniciaEm`). Só de rascunho. */
export async function startCampaign(id: string, agora = new Date()): Promise<CampaignDTO> {
  requireCan("campaigns.start");
  const c = await campanhaDoTime(id, { escrita: true });
  if (c.status !== "draft") throw new CampaignEstadoInvalido(c.status, "iniciar");
  // Quem ficou como "retomada" de uma regra antiga (trocada sem reaplicar)
  // segue a regra atual: sem isso a campanha pedia texto de retomada com a
  // regra "Nenhuma" escolhida.
  if (c.regraJaConversou !== "retomada") await reaplicarRegraJaConversou(id, c.regraJaConversou as RegraJaConversou);
  await conferirParaEnviar(c);
  const previsao = await estimate(id, agora);
  const token = randomUUID();
  const agendada = c.iniciaEm && c.iniciaEm.getTime() > agora.getTime();
  // Transição condicional: dois cliques em "Iniciar" → uma corrente só.
  const { count } = await db().campaign.updateMany({
    where: { id, status: "draft" },
    data: {
      status: agendada ? "scheduled" : "sending",
      tickToken: token,
      iniciadaEm: agora,
      enviadosNoLote: 0,
      falhasSeguidas: 0,
      pausadoMotivo: null,
      terminoPrevisto: previsao.terminoPrevisto,
      etapa: 4,
    },
  });
  if (count !== 1) throw new CampaignEstadoInvalido("draft→?", "iniciar");
  try {
    await agendarTick({
      teamId: c.teamId,
      campaignId: id,
      token,
      seq: 0,
      delayMs: agendada ? c.iniciaEm!.getTime() - agora.getTime() : 0,
    });
  } catch (e) {
    // Fila fora: não deixa "enviando" sem tick nenhum — volta ao rascunho.
    await db().campaign.updateMany({ where: { id, tickToken: token }, data: { status: "draft", tickToken: null, iniciadaEm: null } });
    throw e;
  }
  return getCampaign(id);
}

/**
 * Pausa (manual ou freio do worker). Zera o token: o tick agendado sai sem
 * enviar. O destinatário que estiver no meio do envio termina normalmente.
 */
export async function pauseCampaign(id: string, motivo: string): Promise<CampaignDTO> {
  requireCan("campaigns.write");
  const c = await campanhaDoTime(id, { escrita: true });
  const { count } = await db().campaign.updateMany({
    where: { id, status: { in: ["sending", "scheduled"] } },
    data: { status: "paused", pausadoMotivo: motivo.slice(0, 200), tickToken: null },
  });
  if (count !== 1) throw new CampaignEstadoInvalido(c.status, "pausar");
  return getCampaign(id);
}

/** Retoma uma campanha pausada: corrente nova, contador de falhas zerado. */
export async function resumeCampaign(id: string, agora = new Date()): Promise<CampaignDTO> {
  requireCan("campaigns.start");
  const c = await campanhaDoTime(id, { escrita: true });
  if (c.status !== "paused") throw new CampaignEstadoInvalido(c.status, "retomar");
  await conferirParaEnviar(c);
  const token = randomUUID();
  const { count } = await db().campaign.updateMany({
    where: { id, status: "paused" },
    data: {
      status: "sending",
      tickToken: token,
      pausadoMotivo: null,
      falhasSeguidas: 0,
      terminoPrevisto: (await estimate(id, agora)).terminoPrevisto,
    },
  });
  if (count !== 1) throw new CampaignEstadoInvalido(c.status, "retomar");
  try {
    await agendarTick({ teamId: c.teamId, campaignId: id, token, seq: 0, delayMs: 0 });
  } catch (e) {
    // Fila fora: volta a pausada, com o motivo, em vez de "enviando" sem tick.
    await db().campaign.updateMany({
      where: { id, tickToken: token },
      data: { status: "paused", tickToken: null, pausadoMotivo: "fila indisponível, tente de novo" },
    });
    throw e;
  }
  return getCampaign(id);
}

/** Cancela: ninguém mais recebe; quem estava na fila ou segurado vira "pulado". */
export async function cancelCampaign(id: string): Promise<CampaignDTO> {
  requireCan("campaigns.write");
  const c = await campanhaDoTime(id, { escrita: true });
  const prisma = db();
  const { count } = await prisma.campaign.updateMany({
    where: { id, status: { in: ["draft", "scheduled", "sending", "paused"] } },
    data: { status: "canceled", tickToken: null, concluidaEm: new Date() },
  });
  if (count !== 1) throw new CampaignEstadoInvalido(c.status, "cancelar");
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: id, status: { in: ["queued", "held"] } },
    data: { status: "skipped", motivo: "campanha cancelada" },
  });
  return getCampaign(id);
}

// ─── Previsão ───────────────────────────────────────────────────────────────

const minutosDe = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));

/** Minutos de envio por dia na janela da campanha (sem o almoço). */
export function minutosDeJanela(c: Pick<Campaign, "janelaInicio" | "janelaFim" | "pausaAlmocoInicio" | "pausaAlmocoFim">): number {
  const total = minutosDe(c.janelaFim) - minutosDe(c.janelaInicio);
  const almoco =
    c.pausaAlmocoInicio && c.pausaAlmocoFim ? minutosDe(c.pausaAlmocoFim) - minutosDe(c.pausaAlmocoInicio) : 0;
  return Math.max(0, total - almoco);
}

/**
 * Quantas mensagens cabem num dia pelo RITMO: intervalo médio entre envios +
 * pausa média a cada lote, dentro da janela.
 */
export function capacidadePeloRitmo(
  c: Pick<
    Campaign,
    | "janelaInicio"
    | "janelaFim"
    | "pausaAlmocoInicio"
    | "pausaAlmocoFim"
    | "intervaloMinS"
    | "intervaloMaxS"
    | "loteTamanho"
    | "pausaLoteMinM"
    | "pausaLoteMaxM"
  >,
): number {
  const intervalo = (c.intervaloMinS + c.intervaloMaxS) / 2;
  const pausaPorEnvio = (((c.pausaLoteMinM + c.pausaLoteMaxM) / 2) * 60) / Math.max(1, c.loteTamanho);
  return Math.max(1, Math.floor((minutosDeJanela(c) * 60) / (intervalo + pausaPorEnvio)));
}

/** `tetoDaConta`: quanto o número que envia pode mandar hoje (aquecimento ou teto manual); null sem número. */
export type Previsao = { naFila: number; porDia: number; dias: number; terminoPrevisto: Date | null; tetoDaConta: number | null };

/**
 * Previsão de término: fila ÷ envios por dia. Por dia = o MENOR entre o ritmo
 * da campanha, o `limiteDiario` dela e o teto da conta (aquecimento — a mesma
 * conta do `consumeSendQuota`). Os dias andam pelos dias úteis/feriados do
 * time. Estimativa: não conta respostas, falhas nem outros envios da conta.
 */
export async function estimate(id: string, agora = new Date()): Promise<Previsao> {
  const prisma = db();
  const c = await campanhaDoTime(id);
  const naFila = await prisma.campaignRecipient.count({ where: { campaignId: id, status: "queued" } });
  const conta = c.channelAccountId
    ? await prisma.channelAccount.findUnique({
        where: { id: c.channelAccountId },
        select: { id: true, dailyLimit: true, warmupStartedAt: true, paused: true, createdAt: true, canal: true },
      })
    : null;
  const tetos = [capacidadePeloRitmo(c)];
  if (c.limiteDiario) tetos.push(c.limiteDiario);
  const tetoDaConta = conta ? effectiveDailyLimit(conta, agora) : null;
  // Limite da campanha preenchido substitui o teto do número (consumeSendQuota com `limite`).
  if (tetoDaConta !== null && !c.limiteDiario) tetos.push(tetoDaConta);
  const porDia = Math.max(1, Math.min(...tetos));
  if (naFila === 0) return { naFila, porDia, dias: 0, terminoPrevisto: null, tetoDaConta };
  const dias = Math.ceil(naFila / porDia);
  // Anda `dias` aberturas de janela a partir de agora, ou da data de início
  // quando ela ainda não chegou (pula fim de semana e feriado).
  const cfg = await configDoTimeComCache(agora.getTime());
  const inicio = c.iniciaEm && c.iniciaEm > agora ? c.iniciaEm : agora;
  let dia = proximoSlotDeEnvio(inicio, cfg);
  for (let i = 1; i < dias; i++) dia = proximoSlotDeEnvio(new Date(dia.getTime() + 24 * 3_600_000), cfg);
  // Termina perto do fim da janela da campanha no último dia.
  const terminoPrevisto = new Date(dia.getTime() + minutosDeJanela(c) * 60_000);
  return { naFila, porDia, dias, terminoPrevisto, tetoDaConta };
}

