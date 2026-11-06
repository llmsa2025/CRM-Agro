/**
 * Fachada de normalização de dados do CRM Agro — fonte ÚNICA de verdade para
 * converter qualquer entrada (scraper, CNPJ, import Excel/CSV, cadastro manual,
 * webhook) no formato canônico armazenável + um formato de exibição.
 *
 * Contrato comum `NormalizeResult`:
 *   - canonical: o que ARMAZENAR (telefone → E.164; cnpj → 14 dígitos; …)
 *   - display:   o que EXIBIR (pt-BR bonito)
 *   - valid:     passou na validação real (não só "tem dígitos")
 *   - reason:    motivo quando inválido (UI / logs / IA de qualidade)
 *   - meta:      dados extras (tipo, país, ddd…)
 *
 * Direção de dependência: core → channels e core → captation são permitidos
 * (ambos já são deps do core). O primitivo de telefone (libphonenumber) vive em
 * channels; o de CNPJ (dígitos+14+repetidos) em captation — aqui reusamos.
 */
import { normalizePhoneDetailed, type PhoneDetail } from "@crmagro/channels";
import { normalizeCnpj as cnpjDigits } from "@crmagro/captation";

export type NormalizeResult<C = string> = {
  canonical: C | null;
  display: string | null;
  valid: boolean;
  reason?: string;
  meta?: Record<string, unknown>;
};

// ── Telefone → E.164 ────────────────────────────────────────────────────────
/**
 * Aceita qualquer formato visto na plataforma: `(64) 99999-2850`,
 * `5566999998888`, `+5566999998888`, `06633337703` (com "0" de tronco do
 * Google), `phone:tel:0...`, etc.
 */
export function normalizePhone(raw: string | null | undefined): NormalizeResult {
  const d: PhoneDetail = normalizePhoneDetailed(raw);
  return {
    canonical: d.canonical,
    display: d.display,
    valid: d.valid,
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.meta ? { meta: d.meta } : {}),
  };
}

// ── E-mail ──────────────────────────────────────────────────────────────────
// Endurecido em relação ao `[^\s@]+@[^\s@]+\.[^\s@]+` histórico: sem espaços,
// sem `..`, TLD com ≥2 letras. NÃO canonicaliza dots/+tag do Gmail no
// armazenamento (isso só vale p/ dedup — decisão à parte).
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function normalizeEmail(raw: string | null | undefined): NormalizeResult {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return { canonical: null, display: null, valid: false, reason: "vazio" };
  if (!EMAIL_RE.test(v)) return { canonical: null, display: null, valid: false, reason: "e-mail inválido" };
  return { canonical: v, display: v, valid: true };
}

// ── CPF ─────────────────────────────────────────────────────────────────────
function cpfCheckDigit(base: string): number {
  // base tem 9 ou 10 dígitos; peso decresce a partir de (len+1).
  const len = base.length;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += Number(base[i]) * (len + 1 - i);
  const mod = (sum * 10) % 11;
  return mod === 10 ? 0 : mod;
}

export function normalizeCpf(raw: string | null | undefined): NormalizeResult {
  const d = (raw ?? "").replace(/\D/g, "");
  if (!d) return { canonical: null, display: null, valid: false, reason: "vazio" };
  if (d.length !== 11) return { canonical: null, display: null, valid: false, reason: "CPF precisa de 11 dígitos" };
  if (/^(\d)\1{10}$/.test(d)) return { canonical: null, display: null, valid: false, reason: "CPF com dígitos repetidos" };
  const dv1 = cpfCheckDigit(d.slice(0, 9));
  const dv2 = cpfCheckDigit(d.slice(0, 10));
  if (dv1 !== Number(d[9]) || dv2 !== Number(d[10])) {
    return { canonical: null, display: null, valid: false, reason: "dígitos verificadores inválidos" };
  }
  const display = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return { canonical: d, display, valid: true };
}

// ── CNPJ ────────────────────────────────────────────────────────────────────
function cnpjCheckDigit(base: string): number {
  // pesos 2..9 cíclicos, da direita p/ esquerda.
  let sum = 0;
  let weight = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    sum += Number(base[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

export function normalizeCnpj(raw: string | null | undefined): NormalizeResult {
  // Reusa a limpeza de captation (dígitos + 14 + rejeita repetidos).
  const d = cnpjDigits(raw);
  if (!d) return { canonical: null, display: null, valid: false, reason: "CNPJ inválido (14 dígitos, não repetidos)" };
  const dv1 = cnpjCheckDigit(d.slice(0, 12));
  const dv2 = cnpjCheckDigit(d.slice(0, 13));
  if (dv1 !== Number(d[12]) || dv2 !== Number(d[13])) {
    return { canonical: null, display: null, valid: false, reason: "dígitos verificadores inválidos" };
  }
  const display = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return { canonical: d, display, valid: true };
}

// ── Lat/Lng ─────────────────────────────────────────────────────────────────
export function normalizeLatLng(
  lat: number | string | null | undefined,
  lng: number | string | null | undefined,
): NormalizeResult<{ lat: number; lng: number }> {
  const la = typeof lat === "string" ? Number(lat) : lat;
  const ln = typeof lng === "string" ? Number(lng) : lng;
  if (la == null || ln == null || !Number.isFinite(la) || !Number.isFinite(ln)) {
    return { canonical: null, display: null, valid: false, reason: "lat/lng não numérico" };
  }
  if (la < -90 || la > 90 || ln < -180 || ln > 180) {
    return { canonical: null, display: null, valid: false, reason: "lat/lng fora de faixa" };
  }
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const rLa = round6(la);
  const rLn = round6(ln);
  return { canonical: { lat: rLa, lng: rLn }, display: `${rLa}, ${rLn}`, valid: true };
}

// ── Inscrição Estadual (só LIMPA — validação por UF não implementada) ────────
// NÃO existe coluna IE no schema ainda; normalizador pronto p/ quando entrar.
// `valid` fica false de propósito (não sabemos validar), mas `canonical` traz o
// valor limpo utilizável.
export function normalizeIE(raw: string | null | undefined): NormalizeResult {
  const cleaned = (raw ?? "").trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  return {
    canonical: cleaned || null,
    display: cleaned || null,
    valid: false,
    reason: "validação por UF não implementada",
  };
}
