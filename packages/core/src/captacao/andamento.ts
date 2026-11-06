import { randomUUID } from "node:crypto";
import { db, getCurrentTeamId, runAsSystem } from "@crmagro/db";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { removerDaFilaDaConta } from "../relay/hub";
import { donoPadrao } from "../tenancy/escopo";
import { requireCan } from "../auth/authz";
import {
  estadoEmAndamento,
  lerStatusCaptura,
  mensagemDaCaptura,
  novoStatusCaptura,
  pedirParadaDaCaptura,
  salvarStatusCaptura,
  statusParaATela,
  type OrigemCaptura,
  type StatusCaptura,
} from "./status";

/**
 * Estado, em Redis, do que está ANDANDO na Captação (por time, tipo e pessoa).
 *
 * Serve a três coisas:
 *  1. a tela saber, ao abrir ou recarregar (ou numa segunda aba), se já existe uma
 *     busca em andamento e em que ponto está: o botão "Buscar" fica desativado por
 *     isso, não por um estado só do navegador;
 *  2. o servidor recusar uma segunda busca do mesmo tipo (`adquirirCapturaAtiva`);
 *  3. expirar, sem depender de ninguém rodar, a busca do Instagram que a extensão
 *     nunca pegou ou que parou de dar sinal (`encerrarSeVencida`, na leitura).
 *
 * Chaves (nunca cruzam time, e o ponteiro é por pessoa, porque cada pessoa tem a
 * própria extensão, conta e fila):
 *  - `captacao:ativa:{teamId}:{origem}:{ownerId}`  = lote da última busca desta pessoa
 *  - `captacao:ig:{teamId}:{lote}`                 = registro da busca do Instagram pela extensão
 *  - `captacao:ig-lock:{teamId}:{lote}`            = trava curta de quem altera o status do lote
 */

/** Uma busca do Instagram que a extensão não pegou em tanto tempo vira "interrompida". */
export const CAPTURA_IG_PENDENTE_MS = 10 * 60_000;
/** Busca do Instagram "rodando" sem nenhum sinal da extensão (lote, batida) há tanto tempo. */
export const CAPTURA_IG_SEM_SINAL_MS = 5 * 60_000;
/** Maps e CNPJ (worker): só para a tela não ficar presa num status que ficou para trás. */
export const CAPTURA_WORKER_SEM_SINAL_MS = 30 * 60_000;

const PONTEIRO_TTL_S = 6 * 60 * 60;
export const REGISTRO_TTL_S = 3 * 24 * 60 * 60;
const TRAVA_TTL_MS = 15_000;

const ativaKey = (teamId: string, origem: OrigemCaptura, ownerId: string | null) =>
  `captacao:ativa:${teamId}:${origem}:${ownerId ?? "-"}`;
const registroIgKey = (teamId: string, lote: string) => `captacao:ig:${teamId}:${lote}`;
const travaKey = (teamId: string, lote: string) => `captacao:ig-lock:${teamId}:${lote}`;

/** O que o servidor guarda de uma busca do Instagram entregue à extensão (nunca vai para a tela). */
export type RegistroIg = {
  lote: string;
  /** Quem pediu, e o ÚNICO token que pode mandar lotes para este lote. */
  ownerId: string;
  accountId: string;
  jobId: string;
  /** Texto exato que entrou na fila da conta (para tirar dela se ninguém pegar). */
  payload: string;
  perfil: string;
  limite: number;
  criadoEm: number;
  expiraEm: number;
};

export async function lerRegistroIg(teamId: string, lote: string): Promise<RegistroIg | null> {
  try {
    const raw = await redisEstado().get(registroIgKey(teamId, lote));
    return raw ? (JSON.parse(raw) as RegistroIg) : null;
  } catch (err) {
    logger.warn({ lote, err: err instanceof Error ? err.message : String(err) }, "[captura] não li o registro do lote");
    return null;
  }
}

export async function salvarRegistroIg(teamId: string, reg: RegistroIg): Promise<void> {
  await redisEstado().set(registroIgKey(teamId, reg.lote), JSON.stringify(reg), "EX", REGISTRO_TTL_S);
}

/** Chave do conjunto de @ já vistos no lote (dedupe entre lotes de envio da extensão). */
export const vistosIgKey = (teamId: string, lote: string) => `captacao:ig-vistos:${teamId}:${lote}`;
export const VISTOS_TTL_S = REGISTRO_TTL_S;

// --- Ponteiro "busca ativa" -------------------------------------------------

/** Reserva em andamento, sem status ainda: dentro deste prazo conta como busca andando (senão dois cliques passavam). */
const RESERVA_MS = 30_000;

/** O ponteiro guarda `lote|hora` (a hora diz há quanto tempo a reserva existe, se o status ainda não foi gravado). */
const valorDoPonteiro = (lote: string, agora: number) => `${lote}|${agora}`;
function lerPonteiro(valor: string | null): { lote: string; em: number } | null {
  if (!valor) return null;
  const [lote, em] = valor.split("|");
  return lote ? { lote, em: Number(em) || 0 } : null;
}

/** Aponta a busca desta pessoa para `lote` (Maps e CNPJ: o worker segue como sempre). */
export async function marcarCapturaAtiva(teamId: string, origem: OrigemCaptura, ownerId: string | null, lote: string): Promise<void> {
  try {
    await redisEstado().set(ativaKey(teamId, origem, ownerId), valorDoPonteiro(lote, Date.now()), "EX", PONTEIRO_TTL_S);
  } catch (err) {
    logger.warn({ lote, err: err instanceof Error ? err.message : String(err) }, "[captura] não marquei a busca ativa");
  }
}

/**
 * Reserva a vaga da busca (uma por pessoa e tipo) de forma atômica: `SET NX`. Se já há
 * um ponteiro, só o toma quando a busca apontada NÃO está mais andando. Devolve
 * `null` se conseguiu, ou o status da busca que está andando.
 */
export async function adquirirCapturaAtiva(
  teamId: string,
  origem: OrigemCaptura,
  ownerId: string | null,
  lote: string,
  agora = Date.now(),
): Promise<StatusCaptura | null> {
  const r = redisEstado();
  const chave = ativaKey(teamId, origem, ownerId);
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if ((await r.set(chave, valorDoPonteiro(lote, agora), "EX", PONTEIRO_TTL_S, "NX")) === "OK") return null;
    const atual = lerPonteiro(await r.get(chave));
    if (!atual) continue; // o ponteiro sumiu entre o SET e o GET: tenta de novo
    const st = await statusVivo(teamId, atual.lote, agora);
    if (st && capturaEmAndamento(st, agora)) return st;
    // Sem status ainda, mas a reserva é de agora: outra requisição está montando a busca.
    if (!st && agora - atual.em < RESERVA_MS) return novoStatusCaptura({ lote: atual.lote, origem, estado: "na_fila" });
    // Ponteiro de uma busca que já acabou (ou sumiu): só o apaga se ainda for o MESMO valor,
    // para não derrubar o de uma requisição que acabou de reservar.
    await liberarCapturaAtiva(teamId, origem, ownerId, atual.lote);
  }
  // Perdeu a corrida: outra requisição acabou de reservar. Trata como "já tem busca andando".
  const atual = lerPonteiro(await r.get(chave));
  const st = atual ? await statusVivo(teamId, atual.lote, agora) : null;
  return st ?? novoStatusCaptura({ lote: atual?.lote ?? lote, origem, estado: "na_fila" });
}

/** Solta a vaga, mas só se ainda for deste lote (não derruba a busca de outra requisição). */
export async function liberarCapturaAtiva(teamId: string, origem: OrigemCaptura, ownerId: string | null, lote: string): Promise<void> {
  try {
    await redisEstado().eval(
      "local v = redis.call('get', KEYS[1]); if v and string.sub(v, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '|' then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      ativaKey(teamId, origem, ownerId),
      lote,
    );
  } catch (err) {
    logger.warn({ lote, err: err instanceof Error ? err.message : String(err) }, "[captura] não liberei a busca ativa");
  }
}

// --- Regras puras de "está andando?" ----------------------------------------

/**
 * A busca ainda está andando? Estado "na fila" ou "rodando" E com sinal recente: um status que
 * ficou para trás (extensão que fechou, worker que caiu) não pode prender o botão para sempre.
 * A janela de cada caso está nas constantes acima. Pura: `agora` vem de fora (teste).
 */
export function capturaEmAndamento(st: Pick<StatusCaptura, "estado" | "origem" | "atualizadoEm">, agora: number): boolean {
  if (!estadoEmAndamento(st.estado)) return false;
  const ultimo = Date.parse(st.atualizadoEm);
  if (!Number.isFinite(ultimo)) return false;
  const janela =
    st.origem === "instagram"
      ? st.estado === "na_fila"
        ? CAPTURA_IG_PENDENTE_MS
        : CAPTURA_IG_SEM_SINAL_MS
      : CAPTURA_WORKER_SEM_SINAL_MS;
  return agora - ultimo <= janela;
}

// --- Trava curta por lote ---------------------------------------------------

export class LoteOcupado extends Error {
  constructor() {
    super("outra requisição está mexendo neste lote");
    this.name = "LoteOcupado";
  }
}

const espera = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Serializa quem altera o status de um lote (a extensão mandando lote, a expiração
 * na leitura): leitura-modifica-grava sem trava perdia contagem. Espera até 5 s;
 * passou disso, lança `LoteOcupado` (a extensão tenta de novo).
 */
export async function comTravaDoLote<T>(teamId: string, lote: string, fn: () => Promise<T>): Promise<T> {
  const r = redisEstado();
  const chave = travaKey(teamId, lote);
  const dono = randomUUID();
  const limite = Date.now() + 5_000;
  while ((await r.set(chave, dono, "PX", TRAVA_TTL_MS, "NX")) !== "OK") {
    if (Date.now() > limite) throw new LoteOcupado();
    await espera(50);
  }
  try {
    return await fn();
  } finally {
    await r
      .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, chave, dono)
      .catch(() => undefined);
  }
}

// --- Leitura com expiração --------------------------------------------------

/** Quantos rascunhos o lote tem DE FATO no banco (o contador do status pode ficar atrás). */
async function rascunhosDoLote(teamId: string, lote: string): Promise<number | null> {
  try {
    return await runAsSystem(teamId, () => db().prospectDraft.count({ where: { lote } }));
  } catch (err) {
    logger.warn({ lote, err: err instanceof Error ? err.message : String(err) }, "[captura] não contei os rascunhos do lote");
    return null;
  }
}

/**
 * Status do lote; se for uma busca do Instagram pela extensão que VENCEU (ninguém
 * pegou em 10 min, ou parou de dar sinal há 5), fecha como `interrompida` com o
 * motivo `extensao_offline`, tira a tarefa da fila da conta (para uma extensão que
 * abrir depois não a executar) e devolve o status já fechado. É por isso que o
 * botão volta sozinho: não há processo nenhum esperando o prazo.
 */
export async function statusVivo(teamId: string, lote: string, agora = Date.now()): Promise<StatusCaptura | null> {
  const st = await lerStatusCaptura(teamId, lote);
  if (!st || st.origem !== "instagram" || !estadoEmAndamento(st.estado) || capturaEmAndamento(st, agora)) return st;
  try {
    return await comTravaDoLote(teamId, lote, async () => {
      // Releitura dentro da trava: a extensão pode ter mandado lote nesse meio tempo.
      const atual = await lerStatusCaptura(teamId, lote);
      if (!atual || !estadoEmAndamento(atual.estado) || capturaEmAndamento(atual, agora)) return atual;
      const reg = await lerRegistroIg(teamId, lote);
      if (atual.estado === "na_fila" && reg) await removerDaFilaDaConta(teamId, reg.accountId, reg.payload);
      const criados = (await rascunhosDoLote(teamId, lote)) ?? atual.criados;
      const fechado: StatusCaptura = {
        ...atual,
        estado: "interrompida",
        motivo: "extensao_offline",
        criados,
        mensagem: mensagemDaCaptura("extensao_offline", "instagram", null, "extensao"),
      };
      await salvarStatusCaptura(teamId, fechado);
      logger.info({ lote, estadoAntes: atual.estado, criados }, "[captura] busca do Instagram vencida: fechada como extensao_offline");
      return fechado;
    });
  } catch (err) {
    if (err instanceof LoteOcupado) return lerStatusCaptura(teamId, lote);
    throw err;
  }
}

/** Status de um lote do time ATUAL (tela), já com a expiração aplicada. Sem time no contexto → null. */
export async function statusDaCapturaAtual(lote: string): Promise<StatusCaptura | null> {
  const teamId = getCurrentTeamId();
  if (!teamId || !/^[0-9a-f-]{36}$/i.test(lote)) return null;
  const st = await statusVivo(teamId, lote);
  return st ? statusParaATela(st) : null;
}

export type CapturaAtual = { status: StatusCaptura; emAndamento: boolean };

/**
 * A busca mais recente DESTA pessoa para o tipo (`origem`), e se ainda está andando. É o que a
 * tela lê ao abrir, ao recarregar e a cada poucos segundos: o estado do botão vem daqui.
 * Null = nunca buscou (ou o ponteiro expirou, 6 h).
 */
export async function capturaAtualDaPessoa(origem: OrigemCaptura, agora = Date.now()): Promise<CapturaAtual | null> {
  const teamId = getCurrentTeamId();
  if (!teamId) return null;
  const ponteiro = lerPonteiro(
    await redisEstado()
      .get(ativaKey(teamId, origem, donoPadrao()))
      .catch(() => null),
  );
  if (!ponteiro) return null;
  const status = await statusVivo(teamId, ponteiro.lote, agora);
  if (!status) return null;
  return { status: statusParaATela(status), emAndamento: capturaEmAndamento(status, agora) };
}

/**
 * "Parar" a busca por filtro desta pessoa. O pedido vale para a busca mais recente DELA (o lote nunca vem
 * do cliente): o worker confere a cada página e a cada poucas consultas, para, e o que já veio fica na fila,
 * com "Buscar mais" para continuar. Sem busca andando, não faz nada.
 */
export async function pararBuscaPorFiltro(): Promise<{ parada: boolean }> {
  requireCan("captacao.run");
  const teamId = getCurrentTeamId();
  if (!teamId) return { parada: false };
  const atual = await capturaAtualDaPessoa("cnpj");
  if (!atual || !atual.emAndamento) return { parada: false };
  await pedirParadaDaCaptura(teamId, atual.status.lote);
  return { parada: true };
}
