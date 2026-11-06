/** Formatadores compartilhados (PT-BR). */

export function formatBRL(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

/**
 * Valor compacto em português, como se fala: "R$ 210 mil", "R$ 1,84 mi".
 * Abaixo de mil, o valor inteiro. Zero vira "R$ 0".
 */
export function formatBRLCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sinal = value < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    const mi = abs / 1_000_000;
    return `${sinal}R$ ${mi.toLocaleString("pt-BR", { maximumFractionDigits: mi >= 10 ? 0 : 2 })} mi`;
  }
  if (abs >= 1_000) {
    const mil = abs / 1_000;
    return `${sinal}R$ ${mil.toLocaleString("pt-BR", { maximumFractionDigits: mil >= 100 ? 0 : 1 })} mil`;
  }
  return formatBRL(value);
}

// Fuso do produto. O servidor roda em UTC e o Next renderiza datas no servidor:
// sem timeZone explícito, "15:00" viraria "18:00" e "hoje" viraria "ontem".
// (Igual ao DEFAULT_TZ do core — repetido aqui para o bundle do cliente não
// puxar o pacote inteiro.)
export const TZ = "America/Sao_Paulo";

const RTf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function relativeTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = date.getTime() - Date.now();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hour = Math.round(min / 60);
  const day = Math.round(hour / 24);
  if (Math.abs(sec) < 60) return RTf.format(sec, "second");
  if (Math.abs(min) < 60) return RTf.format(min, "minute");
  if (Math.abs(hour) < 24) return RTf.format(hour, "hour");
  if (Math.abs(day) < 30) return RTf.format(day, "day");
  const month = Math.round(day / 30);
  return RTf.format(month, "month");
}

const DateTimeShort = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: TZ });
const TimeShort = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const DateShort = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: TZ });
const WeekdayShort = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: TZ });
const DateLong = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", timeZone: TZ });
const DayKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });

/** "2026-09-25" no fuso do produto — para comparar dias. */
export function dayKeyOf(date: Date): string {
  return DayKey.format(date);
}

// Formatadores criados UMA vez (criar Intl.* por chamada é caro — lição do Gestão Família).
export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return DateTimeShort.format(date);
}

/** "14:18" */
export function formatTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  return TimeShort.format(typeof iso === "string" ? new Date(iso) : iso);
}

function mesmoDia(a: Date, b: Date): boolean {
  return dayKeyOf(a) === dayKeyOf(b);
}

/**
 * Data como se lê numa lista: "14:18" (hoje) · "ontem" · "ter" (esta semana) ·
 * "22/09" (mais antigo). Como no WhatsApp.
 */
export function formatWhen(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const agora = new Date();
  if (mesmoDia(date, agora)) return TimeShort.format(date);
  const ontem = new Date(agora.getTime() - 86_400_000);
  if (mesmoDia(date, ontem)) return "ontem";
  const dias = (agora.getTime() - date.getTime()) / 86_400_000;
  if (dias < 6) return WeekdayShort.format(date).replace(".", "");
  return DateShort.format(date);
}

/** "hoje" · "ontem" · "12 de agosto" — separador de dia numa thread. */
export function formatDayLabel(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const agora = new Date();
  if (mesmoDia(date, agora)) return "hoje";
  const ontem = new Date(agora.getTime() - 86_400_000);
  if (mesmoDia(date, ontem)) return "ontem";
  return DateLong.format(date);
}

export function initialsOf(nome: string): string {
  return nome
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** "Criado" em dias: "hoje", "ontem", "há N dias". Coluna de Contatos. */
export function daysSince(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const dias = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (dias <= 0) return "hoje";
  if (dias === 1) return "ontem";
  return `há ${dias} dias`;
}

/** "Parado há 11 dias" · "1 dia" — idade de um negócio na etapa. */
export function daysLabel(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const dias = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  if (dias === 0) return "hoje";
  return `${dias} ${dias === 1 ? "dia" : "dias"}`;
}

/** E.164 brasileiro → "(66) 99999-7705"; outros formatos voltam como vieram. */
export function formatPhone(valor: string | null | undefined): string {
  if (!valor) return "—";
  const d = valor.replace(/\D/g, "");
  const n = d.startsWith("55") && (d.length === 12 || d.length === 13) ? d.slice(2) : d;
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return valor;
}
