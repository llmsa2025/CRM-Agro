import { JANELA_DA_EMPRESA, type JanelaEnvio } from "../flows/janela";
import { getNextCallSlot } from "./business-hours";
import { getTeamConfigComCache, toBusinessHoursOptions, type TeamConfigDTO } from "./team-config";
import { zonedParts, zonedTimeToUtc } from "./tz";

/**
 * Janela de ENVIO do motor (item 1.3 — MF-05).
 *
 * Antes nenhum nó de envio olhava o relógio: mensagem saía às 23h, no domingo,
 * no feriado — e o adiamento por cota mandava o backlog inteiro EXATAMENTE à
 * meia-noite, em rajada, para produtor rural. Agora:
 * - envio automático só dentro do horário do FLUXO, que por padrão segue o da
 *   empresa (TeamConfig: abertura/fechamento, dias úteis, feriados; padrão
 *   seg–sex 08–18) quando "Respeitar horário comercial" está ligado. Desligado, o
 *   fluxo envia a qualquer hora (era o contrário: o motor ignorava o botão e
 *   sempre segurava o envio). Cada fluxo pode ter o próprio horário ou nenhum
 *   (ver `flows/janela.ts`);
 * - fora da janela o passo é adiado para a abertura + jitter (0–90 min), para
 *   não sair tudo junto às 08:00;
 * - `FLOW_JANELA_ENVIO=off` desliga (operação/emergência).
 *
 * A config do time fica em cache por 5 min por processo (`getTeamConfigComCache`;
 * antes: 1 consulta a cada envio só para o fuso).
 */

/** Config do time do contexto (cache de 5 min em team-config.ts). */
export const configDoTimeComCache = getTeamConfigComCache;

export function janelaDeEnvioLigada(): boolean {
  return (process.env.FLOW_JANELA_ENVIO ?? "on").toLowerCase() !== "off";
}

/**
 * A config de horário que vale para um fluxo, ou `null` quando ele pode enviar a qualquer hora:
 * - `empresa` segue o botão "Respeitar horário comercial" da empresa (desligado = sem restrição);
 * - `livre` nunca restringe;
 * - `propria` usa os dias, horas e feriados do próprio fluxo (o fuso é o da empresa).
 */
export function configDaJanela(cfg: TeamConfigDTO, janela: JanelaEnvio = JANELA_DA_EMPRESA): TeamConfigDTO | null {
  if (janela.modo === "livre") return null;
  if (janela.modo === "empresa") return cfg.respectBusinessHours ? cfg : null;
  return {
    ...cfg,
    respectBusinessHours: true,
    businessHourStart: janela.abertura,
    businessHourEnd: janela.fechamento,
    businessDays: janela.dias.join(","),
    respectHolidays: janela.feriados,
  };
}

/** Próximo instante permitido para envio (o próprio `agora` se já está na janela). */
export function proximoSlotDeEnvio(agora: Date, cfg: TeamConfigDTO): Date {
  return getNextCallSlot(agora, { ...toBusinessHoursOptions(cfg), respectBusinessHours: true });
}

/** Jitter aleatório em [0, maxMin] minutos. */
export function jitterMs(maxMin: number, aleatorio: () => number = Math.random): number {
  return Math.round(aleatorio() * maxMin * 60_000);
}

/** Jitter ao abrir a janela: espalha o backlog da noite/fim de semana. */
export const JITTER_ABERTURA_MIN = 90;

/**
 * Quanto adiar um envio que caiu FORA da janela (ms), ou `null` se pode sair
 * agora. Usa a config do time do contexto e o horário do FLUXO (`janela`; sem ele,
 * segue a empresa).
 */
export async function adiamentoForaDaJanela(agora = new Date(), janela: JanelaEnvio = JANELA_DA_EMPRESA): Promise<number | null> {
  if (!janelaDeEnvioLigada()) return null;
  const cfg = configDaJanela(await configDoTimeComCache(agora.getTime()), janela);
  if (!cfg) return null; // sem restrição de horário (empresa desligada, ou fluxo "qualquer hora")
  const slot = proximoSlotDeEnvio(agora, cfg);
  if (slot.getTime() <= agora.getTime()) return null;
  return slot.getTime() - agora.getTime() + jitterMs(JITTER_ABERTURA_MIN);
}

/**
 * Adiamento para "amanhã" (cota do dia esgotada / conta pausada): a abertura
 * da janela do PRÓXIMO dia permitido + jitter — nunca 00:00 em rajada.
 */
export async function adiamentoParaProximoDia(agora = new Date()): Promise<number> {
  const cfg = await configDoTimeComCache(agora.getTime());
  const p = zonedParts(agora, cfg.timezone);
  const amanha = zonedTimeToUtc(p.year, p.month, p.day + 1, 0, 0, cfg.timezone);
  const alvo = janelaDeEnvioLigada() ? proximoSlotDeEnvio(amanha, cfg) : amanha;
  return Math.max(60_000, alvo.getTime() - agora.getTime()) + jitterMs(JITTER_ABERTURA_MIN);
}
