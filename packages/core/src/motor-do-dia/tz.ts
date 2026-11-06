/**
 * Helpers de fuso horário para o "motor do dia". Feriados, horário comercial e
 * o orçamento de toques raciocinam sobre a data-calendário e a hora de parede
 * no fuso do usuário (Brasil), não no fuso do servidor. Tudo aqui é interno ao
 * módulo — não é re-exportado pelo index.
 *
 * São Paulo não tem horário de verão desde 2019 (offset fixo -03:00), mas os
 * helpers usam `Intl` e calculam o offset real do fuso, então continuam
 * corretos caso o `timeZone` mude ou o país volte a adotar DST.
 */

export const DEFAULT_TZ = "America/Sao_Paulo";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  weekday: number; // 0=domingo ... 6=sábado
  hour: number; // 0-23
  minute: number; // 0-59
}

/** Componentes da data (ano/mês/dia/hora/min + dia da semana) num fuso. */
export function zonedParts(date: Date, timeZone: string = DEFAULT_TZ): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  // Dia da semana é determinado pela data-calendário; UTC evita ruído de fuso.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return { year, month, day, weekday, hour, minute };
}

/** Offset (ms) do fuso no instante dado: (parede no fuso) − UTC. SP ≈ -3h. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asIfUtc - date.getTime();
}

/**
 * Converte uma hora-de-parede num fuso para o instante UTC correspondente.
 * Ex.: (2026, 7, 20, 8, 0, "America/Sao_Paulo") → 2026-07-20T11:00:00Z.
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string = DEFAULT_TZ,
): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMs(new Date(naiveUtc), timeZone);
  return new Date(naiveUtc - offset);
}
