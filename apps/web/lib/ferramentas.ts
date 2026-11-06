/**
 * Mapa das ferramentas (canais, integrações e provedores de IA) para a MARCA
 * que aparece no logo. Módulo puro, sem JSX: a tela usa
 * `iconeDaFerramenta` (components/brand-icons.tsx), que só troca a marca
 * daqui pelo componente SVG. Assim o mapa é testável sem DOM.
 */

/** Uma marca por logo desenhado em components/brand-icons.tsx. */
export const MARCAS = [
  "whatsapp",
  "instagram",
  "linkedin",
  "email",
  "gmail",
  "google",
  "google-agenda",
  "google-meet",
  "voopi",
  "nectar",
  "webhook",
  "api",
  "anthropic",
  "openai",
  "glm",
  // Ícones genéricos: "ia" para provedor de IA desconhecido, "generico" para o resto.
  "ia",
  "generico",
] as const;

export type MarcaId = (typeof MARCAS)[number];

/**
 * Nomes que chegam das telas e do banco (canal, provider, tipo de integração)
 * e a marca de cada um. Vale a chave já normalizada (ver `normalizar`).
 */
const ALIAS: Record<string, MarcaId> = {
  whatsapp: "whatsapp",
  evolution: "whatsapp",
  instagram: "instagram",
  linkedin: "linkedin",
  email: "email",
  "e-mail": "email",
  smtp: "email",
  imap: "email",
  gmail: "gmail",
  google: "google",
  "google-agenda": "google-agenda",
  "agenda-google": "google-agenda",
  "google-calendar": "google-agenda",
  "google-meet": "google-meet",
  meet: "google-meet",
  voopi: "voopi",
  nectar: "nectar",
  nectarcrm: "nectar",
  "nectar-crm": "nectar",
  webhook: "webhook",
  webhooks: "webhook",
  api: "api",
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  glm: "glm",
  zai: "glm",
  "z.ai": "glm",
  ia: "ia",
};

/** Minúsculas, sem espaço nas pontas e "_" ou espaço viram "-". */
function normalizar(id: string): string {
  return id.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * Marca do logo para o id da ferramenta. Id desconhecido (ou vazio) cai em
 * `padrao`: "generico" por padrão; use "ia" para provedor de IA que o CRM Agro
 * ainda não conhece (ícone de brilho em vez do plugue).
 */
export function marcaDaFerramenta(id: string | null | undefined, padrao: MarcaId = "generico"): MarcaId {
  if (!id) return padrao;
  // Object.hasOwn: "constructor" e afins não podem virar marca.
  const chave = normalizar(id);
  return Object.hasOwn(ALIAS, chave) ? ALIAS[chave]! : padrao;
}

/** Rótulo curto de cada marca, usado como texto alternativo do logo. */
export const NOME_DA_MARCA: Record<MarcaId, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  email: "E-mail",
  gmail: "Gmail",
  google: "Google",
  "google-agenda": "Google Agenda",
  "google-meet": "Google Meet",
  voopi: "Voopi",
  nectar: "Nectar CRM",
  webhook: "Webhooks",
  api: "API",
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  glm: "GLM (z.ai)",
  ia: "Inteligência artificial",
  generico: "Integração",
};
