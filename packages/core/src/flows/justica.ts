import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { conferirWhatsAppLigado } from "./conferir-whatsapp";
import { EFEITO_EXTERNO } from "./fase-envio";

/**
 * Justiça entre times no motor (item 1.9 — MF-20).
 *
 * O limitador do BullMQ é UM balde de 600 passos/min para a plataforma inteira,
 * em FIFO: um time que aplica uma tag em 5 mil contatos empurrava os envios e
 * as esperas curtas dos outros 999 times para trás (e, com o FLOW_STALE_HOURS,
 * os contatos deles viravam "segurados"). Agora cada time tem o próprio balde
 * (padrão 120/min): sem ficha, o passo volta para a fila em ~5 s SEM tocar no
 * claim — os outros times seguem passando.
 *
 * O custo da ficha é POR TIPO DE PASSO (incidente de 02/10/2026): passo só de banco (tag, funil, condição por
 * dado do cadastro) custa `CUSTO_PASSO_LEVE`; envio e consulta a serviço de fora custam uma ficha inteira. Com todo
 * passo a 1 ficha, muitos contatos de um fluxo que só marca tag e cadastra no funil levavam ~47 min, com quase todo o
 * teto do worker gasto em "tente de novo". O ritmo de 120/min continua valendo onde ele protege alguém: WhatsApp,
 * e-mail, DM, IA, HTTP e as consultas à Evolution.
 */

export const PASSOS_POR_MINUTO_POR_TIME = Number(process.env.FLOW_STEPS_PER_MINUTE_PER_TEAM ?? 120);

/** Custo (em fichas) de um passo que só mexe no banco. Ajustável por env; 1 = igual a um envio. */
export const CUSTO_PASSO_LEVE = Number(process.env.FLOW_CUSTO_PASSO_LEVE ?? 0.1);

/** Passos que, mesmo sem `EFEITO_EXTERNO`, falam com serviço de fora (Evolution, consulta pública de CNPJ, "digitando"). */
const CONSULTA_EXTERNA = new Set(["save_history", "enrich_data", "enrich_company", "enrich_person", "typing"]);

/**
 * Quantas fichas o passo gasta. Envio, IA, HTTP, "digitando", registrar conversa (lê a Evolution), enriquecer dados
 * (consulta pública) e as condições "tem histórico no WhatsApp" e "Tem WhatsApp" conferido no WhatsApp (consultam a Evolution) gastam 1. O resto, só banco, gasta
 * `CUSTO_PASSO_LEVE`.
 */
export function custoDoPasso(node: { tipo: string; branches?: unknown }): number {
  if (EFEITO_EXTERNO.has(node.tipo) || CONSULTA_EXTERNA.has(node.tipo)) return 1;
  if (node.tipo === "condition" && condicaoConsultaServicoDeFora(node.branches)) return 1;
  return CUSTO_PASSO_LEVE;
}

/**
 * Consulta a Evolution: "já tem histórico" no WhatsApp e "Tem WhatsApp" conferido no WhatsApp (`modo: "verificar"`,
 * a não ser que `FLOW_CONFERIR_WHATSAPP=off` tenha desligado a consulta: aí só lê o cadastro).
 */
function condicaoConsultaServicoDeFora(branches: unknown): boolean {
  const ramos = (branches as { branches?: Array<{ condition?: { type?: string; modo?: string } }> } | null)?.branches ?? [];
  return ramos.some(
    (r) => r.condition?.type === "channel_history" || (r.condition?.type === "has_whatsapp" && r.condition.modo === "verificar" && conferirWhatsAppLigado()),
  );
}

// Token bucket atômico: repõe `taxa` fichas/ms até `capacidade`; devolve 0
// (tem ficha, consumiu) ou quantos ms faltam para a próxima ficha.
const BALDE_LUA = `
local cap = tonumber(ARGV[1])
local taxa = tonumber(ARGV[2])
local agora = tonumber(ARGV[3])
local custo = tonumber(ARGV[4])
local v = redis.call('HMGET', KEYS[1], 'fichas', 'ts')
local fichas = tonumber(v[1])
local ts = tonumber(v[2])
if fichas == nil or ts == nil then fichas = cap; ts = agora end
if agora > ts then fichas = math.min(cap, fichas + (agora - ts) * taxa) end
local espera = 0
if fichas >= custo then fichas = fichas - custo else espera = math.ceil((custo - fichas) / taxa) end
redis.call('HSET', KEYS[1], 'fichas', tostring(fichas), 'ts', tostring(agora))
redis.call('PEXPIRE', KEYS[1], 120000)
return espera
`;

/**
 * Pede a vez do time para executar UM passo. 0 = pode seguir; > 0 = ms até a
 * ficha(s) necessária(s). `custo` = fichas do passo (`custoDoPasso`; padrão 1). Redis fora: libera (a justiça não
 * pode parar o motor).
 */
export async function reservarVezDoTime(
  teamId: string,
  opts: { porMinuto?: number; agora?: number; custo?: number } = {},
): Promise<number> {
  const porMinuto = opts.porMinuto ?? PASSOS_POR_MINUTO_POR_TIME;
  if (!(porMinuto > 0)) return 0;
  try {
    const espera = await redisEstado().eval(
      BALDE_LUA,
      1,
      `flow:balde:${teamId}`,
      String(porMinuto),
      String(porMinuto / 60_000),
      String(opts.agora ?? Date.now()),
      String(Math.max(0, opts.custo ?? 1)),
    );
    return Number(espera) || 0;
  } catch (err) {
    logger.warn({ teamId, err: err instanceof Error ? err.message : String(err) }, "[flow] balde do time indisponível — seguindo");
    return 0;
  }
}

/** Quanto adiar um passo sem ficha: a espera do balde, no mínimo ~5 s (com folga aleatória). */
export function adiamentoPorJustica(esperaMs: number): number {
  return Math.max(esperaMs, 5_000) + Math.round(Math.random() * 2_000);
}

/**
 * O mesmo para o PASSO DE FLUXO, com a folga espalhada em até 15 s. Com a folga curta, centenas de passos do mesmo time
 * voltavam juntos, a cada ~6 s, e cada volta gasta uma das 600 execuções por minuto do worker sem fazer nada; espalhadas,
 * as voltas se diluem. (A campanha segue com `adiamentoPorJustica`: ela tem um tick só por time.)
 */
export function adiamentoDoPassoSemFicha(esperaMs: number): number {
  return Math.max(esperaMs, 5_000) + Math.round(Math.random() * 15_000);
}
