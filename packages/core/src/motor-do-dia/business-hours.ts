import { DEFAULT_TZ, zonedParts, zonedTimeToUtc } from "./tz";
import { isHoliday } from "./holidays";

/**
 * Horário comercial de prospecção. O motor do dia e o discador usam isto para
 * não agendar (nem sugerir) ligações fora de hora ou em feriado. Toda a lógica
 * raciocina sobre a hora-de-parede no fuso do usuário (America/Sao_Paulo por
 * padrão). O limite superior é exclusivo (18:00 já está fora).
 *
 * **CONFIGURÁVEL.** As regras (ligar/desligar, janela, dias úteis, feriados,
 * fuso) vêm de um `TeamConfig` (ver ./team-config) e entram pelas opções abaixo.
 * Sem `respectBusinessHours`, o gate é desligado: pode ligar a qualquer hora —
 * compatível com a filosofia "o usuário prospecta quando quiser" e evita que a
 * falta de config trave o discador.
 */

/**
 * Opções das funções de horário comercial. Espelham os campos do `TeamConfig`
 * (Prisma). O time-config mapeia a row do banco para este shape antes de chamar
 * as funções daqui — assim `business-hours` segue puro (sem depender de @crmagro/db
 * nem de Prisma) e testável isoladamente.
 */
export interface BusinessHoursOptions {
  /** Fuso do time (fallback: America/Sao_Paulo). */
  timeZone?: string;
  /**
   * `false`/`undefined` → desliga o gate (sempre pode ligar). `true` → aplica
   * a janela, dias úteis e feriados configurados.
   */
  respectBusinessHours?: boolean;
  /** Abertura no formato "HH:mm" (fallback: "08:00"). */
  businessHourStart?: string;
  /** Fechamento no formato "HH:mm" (fallback: "18:00"). Exclusivo. */
  businessHourEnd?: string;
  /** Dias úteis como lista CSV de abreviações (ex.: "mon,tue,wed,thu,fri"). */
  businessDays?: string;
  /**
   * `false` → ignora feriados (mesmo com `respectBusinessHours=true`).
   * Default `true` quando o gate está ligado.
   */
  respectHolidays?: boolean;
}

const DEFAULT_OPEN = 8 * 60; // 08:00 em minutos
const DEFAULT_CLOSE = 18 * 60; // 18:00
const DEFAULT_DAYS = new Set([1, 2, 3, 4, 5]); // seg–sex (0=dom … 6=sáb)

/** Abreviação de dia → índice ISO/local (0=domingo … 6=sábado). */
const DAY_TO_WEEKDAY: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Faz o parse de "HH:mm" para minutos do dia; fallback em caso de inválido. */
function parseMinutes(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(input);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

/** Faz o parse de "mon,tue,..." para o conjunto de índices de dia; fallback default. */
function parseDays(input: string | undefined): Set<number> {
  if (!input || !input.trim()) return new Set(DEFAULT_DAYS);
  const out = new Set<number>();
  for (const raw of input.split(",")) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const w = DAY_TO_WEEKDAY[key];
    if (w !== undefined) out.add(w);
  }
  return out.size > 0 ? out : new Set(DEFAULT_DAYS);
}

/** `true` se a data cai dentro da janela comercial configurada (ignora feriados). */
export function isBusinessHour(date: Date, opts: BusinessHoursOptions = {}): boolean {
  if (!opts.respectBusinessHours) return true; // gate desligado → sempre "aberto"
  const tz = opts.timeZone ?? DEFAULT_TZ;
  const days = parseDays(opts.businessDays);
  const open = parseMinutes(opts.businessHourStart, DEFAULT_OPEN);
  const close = parseMinutes(opts.businessHourEnd, DEFAULT_CLOSE);
  const { weekday, hour, minute } = zonedParts(date, tz);
  if (!days.has(weekday)) return false;
  const minutesOfDay = hour * 60 + minute;
  return minutesOfDay >= open && minutesOfDay < close;
}

/**
 * Pode ligar neste instante? Respeita a janela comercial quando o gate está
 * ligado e — opcionalmente — barra feriados. `respectBusinessHours` desligado
 * (default) libera sempre; `respectHolidays=false` ignora feriados mesmo com o
 * gate ligado.
 */
export function canCallNow(date: Date = new Date(), opts: BusinessHoursOptions = {}): boolean {
  if (!opts.respectBusinessHours) return true;
  if (!isBusinessHour(date, opts)) return false;
  if (opts.respectHolidays === false) return true; // ignora feriados
  const tz = opts.timeZone ?? DEFAULT_TZ;
  return !isHoliday(date, tz);
}

/** Data-calendário seguinte (mesmo fuso), como componentes y/m/d. */
function nextDay(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 1);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Próximo instante em que se pode ligar (dia útil + janela + não feriado). Se já
 * se pode ligar em `from`, devolve o próprio `from`. Com o gate desligado
 * (`respectBusinessHours` ausente/false) devolve `from` imediatamente — pode
 * ligar a qualquer hora.
 */
export function getNextCallSlot(from: Date = new Date(), opts: BusinessHoursOptions = {}): Date {
  if (!opts.respectBusinessHours) return from;
  const tz = opts.timeZone ?? DEFAULT_TZ;
  const days = parseDays(opts.businessDays);
  const open = parseMinutes(opts.businessHourStart, DEFAULT_OPEN);
  const close = parseMinutes(opts.businessHourEnd, DEFAULT_CLOSE);
  const respectHolidays = opts.respectHolidays !== false; // default true
  let cursor = from;

  // Limite de segurança: no pior caso (feriados encadeados) poucas dezenas de
  // dias bastam; 60 evita loop infinito diante de qualquer imprevisto.
  for (let i = 0; i < 60; i++) {
    const { year, month, day, weekday, hour, minute } = zonedParts(cursor, tz);
    const holiday = respectHolidays && isHoliday(cursor, tz);

    if (days.has(weekday) && !holiday) {
      const minutesOfDay = hour * 60 + minute;
      if (minutesOfDay < open) {
        // Antes de abrir: pula para a abertura do mesmo dia.
        return zonedTimeToUtc(year, month, day, Math.floor(open / 60), open % 60, tz);
      }
      if (minutesOfDay < close) {
        // Dentro da janela: já pode ligar agora.
        return cursor;
      }
    }

    // Fechado (fora dos dias úteis, feriado ou após o expediente): avança para
    // a abertura do próximo dia e reavalia no topo do loop.
    const nd = nextDay(year, month, day);
    cursor = zonedTimeToUtc(nd.year, nd.month, nd.day, Math.floor(open / 60), open % 60, tz);
  }

  throw new Error("getNextCallSlot: nenhum horário útil encontrado em 60 dias");
}
