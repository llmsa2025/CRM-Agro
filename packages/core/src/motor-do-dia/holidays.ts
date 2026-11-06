import { DEFAULT_TZ, zonedParts } from "./tz";

/**
 * Feriados nacionais brasileiros (fixos e móveis). O cálculo é dinâmico (vale
 * para qualquer ano), então não há tabela chumbada — a Páscoa sai do algoritmo
 * de Gauss e os móveis derivam dela. Cobre com folga o alvo 2025–2027.
 *
 * NÃO inclui feriados estaduais/municipais nem pontos facultativos (ex.: a
 * segunda-feira de Carnaval). Corpus Christi entra por ser amplamente feriado
 * comercial no Brasil, embora não seja feriado nacional por lei federal.
 */

export interface Holiday {
  date: Date; // meia-noite UTC da data-calendário do feriado
  name: string;
}

/** Feriados fixos: [mês (1-12), dia, nome]. */
const FIXED: ReadonlyArray<readonly [number, number, string]> = [
  [1, 1, "Confraternização Universal"],
  [4, 21, "Tiradentes"],
  [5, 1, "Dia do Trabalho"],
  [9, 7, "Independência do Brasil"],
  [10, 12, "Nossa Senhora Aparecida"],
  [11, 2, "Finados"],
  [11, 15, "Proclamação da República"],
  [12, 25, "Natal"],
];

/**
 * Feriados fixos que só existem A PARTIR de um ano: [mês, dia, nome, desde].
 * 20/11 virou feriado nacional pela Lei 14.759/2023 — vale de 2024 em diante.
 * Antes o motor do dia tratava 20/11 como dia útil (ligava/mandava mensagem).
 */
const FIXED_DESDE: ReadonlyArray<readonly [number, number, string, number]> = [
  [11, 20, "Dia Nacional de Zumbi e da Consciência Negra", 2024],
];

/** Domingo de Páscoa via algoritmo de Gauss (Anonymous Gregorian). */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** UTC-midnight de uma data-calendário; base para todas as datas de feriado. */
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Todos os feriados do ano (fixos + móveis), ordenados por data. */
export function getHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  const easterDate = utcDate(year, easter.month, easter.day);

  const movable: Holiday[] = [
    { date: addDays(easterDate, -47), name: "Carnaval" },
    { date: addDays(easterDate, -2), name: "Sexta-feira Santa" },
    { date: addDays(easterDate, 60), name: "Corpus Christi" },
  ];

  const fixed: Holiday[] = [
    ...FIXED.map(([month, day, name]) => ({ date: utcDate(year, month, day), name })),
    ...FIXED_DESDE.filter(([, , , desde]) => year >= desde).map(([month, day, name]) => ({
      date: utcDate(year, month, day),
      name,
    })),
  ];

  return [...fixed, ...movable].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Chave YYYY-MM-DD a partir de uma data UTC (para comparar por dia). */
function ymdKey(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

/** `true` se a data (interpretada no fuso) cair num feriado nacional. */
export function isHoliday(date: Date, timeZone: string = DEFAULT_TZ): boolean {
  const { year, month, day } = zonedParts(date, timeZone);
  const key = `${year}-${month}-${day}`;
  return getHolidays(year).some((h) => ymdKey(h.date) === key);
}

/** Próximo feriado a partir da data (inclusive se a própria data for feriado). */
export function getNextHoliday(date: Date, timeZone: string = DEFAULT_TZ): Holiday {
  const { year, month, day } = zonedParts(date, timeZone);
  const from = Date.UTC(year, month - 1, day);
  // Ano corrente cobre a maioria; ano seguinte cobre a virada (ex.: consulta em 26/12).
  const candidates = [...getHolidays(year), ...getHolidays(year + 1)];
  const next = candidates.find((h) => h.date.getTime() >= from);
  // Sempre há candidato (o próximo ano garante), mas o TS exige o guard.
  if (!next) throw new Error(`getNextHoliday: nenhum feriado encontrado após ${ymdKey(new Date(from))}`);
  return next;
}
