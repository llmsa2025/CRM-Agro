/**
 * Relay hub — tipos e validação de jobs (contrato servidor↔extensão).
 *
 * Compartilhado entre o web (rotas /api/relay) e o worker (motor de fluxo que
 * delega o envio social à extensão pelo IP residencial do usuário). Antes vivia
 * em apps/web/app/api/relay/_types.ts; foi movido para cá para o worker também
 * poder enfileirar/coletar jobs
 *
 * Os jobs são de um CATÁLOGO FECHADO: a extensão nunca executa código
 * arbitrário, só verbos tipados validados dos dois lados.
 */

export type RelayJobType = "http_fetch" | "dom_action" | "social_send" | "ig_followers";

/**
 * Catálogo FECHADO de tipos de tarefa (allowlist do servidor). O que não está
 * aqui nunca sai para uma extensão: o `poll` descarta. A extensão tem a lista
 * dela (apps/extension/background.js, `executeJob`); as duas andam juntas.
 */
export const RELAY_JOB_TYPES: readonly RelayJobType[] = Object.freeze(["http_fetch", "dom_action", "social_send", "ig_followers"]);

export function tipoDeJobPermitido(tipo: unknown): tipo is RelayJobType {
  return typeof tipo === "string" && (RELAY_JOB_TYPES as readonly string[]).includes(tipo);
}

export interface HttpFetchSpec {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface DomActionSpec {
  action: string; // enum fechado na extensão (stub no MVP)
  params: Record<string, unknown>;
}

/**
 * Envio de DM social pela SESSÃO logada do usuário no navegador (IP residencial).
 * A extensão abre a plataforma e envia como o próprio usuário — foge do ban por
 * IP de datacenter que o Playwright no worker tomava. `to` = @username (IG) ou
 * URL/publicIdentifier do perfil (LinkedIn); a extensão resolve o destinatário.
 */
export interface SocialSendSpec {
  network: "instagram" | "linkedin";
  to: string;
  text: string;
  timeoutMs?: number;
  /**
   * Conta social (ChannelAccount) que DEVE enviar (item 1.8, INT-08). O job vai
   * para a fila dessa conta, e só a extensão logada nela o recebe.
   */
  accountId: string;
  /**
   * @usuário (IG) / publicIdentifier (LinkedIn) da conta. A extensão confere a
   * sessão do navegador antes de enviar e recusa com `wrong_account` se não
   * bater (o usuário pode ter trocado de conta depois de conectar).
   */
  expectedUsername?: string | null;
}

/**
 * Leitura dos seguidores de um perfil do Instagram PELO NAVEGADOR de quem pediu
 * (IP residencial e sessão do Chrome dele). A extensão resolve o @ do perfil,
 * pagina a lista dentro de uma aba do instagram.com, com pausas humanas, e manda
 * os perfis em lotes pequenos para `POST /api/relay/captura-lote`. Nunca devolve
 * cookie. O job vai para a fila DA CONTA (`relay:queue:{teamId}:{accountId}`),
 * então só a extensão logada naquela conta o recebe.
 */
export interface IgFollowersSpec {
  /** Conta do Instagram (ChannelAccount) que deve ler. */
  accountId: string;
  /** @ da conta: a extensão confere que o Chrome está logado nela (senão `conta_errada`). */
  expectedUsername: string;
  /** @ do perfil cujos seguidores serão lidos (sem "@"). */
  perfil: string;
  /** Quantos seguidores trazer (1 a 300). */
  limite: number;
  /** Lote da Captação: onde o status e os rascunhos são gravados. */
  lote: string;
  /** Bio dos primeiros `max` seguidores (1 requisição cada). Omitido = nenhuma. */
  bios?: { max: number };
}

export interface RelayJob {
  id: string;
  teamId: string;
  type: RelayJobType;
  spec: HttpFetchSpec | DomActionSpec | SocialSendSpec | IgFollowersSpec;
  createdAt: number;
  /**
   * Validade do job (epoch ms). Vencido, é descartado no poll em vez de
   * executado (item 1.8, INT-07): antes, um DM que ficou na fila voltava a sair
   * no dia seguinte, quando o navegador do usuário abria.
   */
  expiresAt?: number;
}

export interface RelayResult {
  jobId: string;
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

/** Métodos HTTP aceitos num http_fetch. */
export const ALLOWED_METHODS = new Set(["GET", "POST"]);

/**
 * Allowlist de domínios — defesa em profundidade (a extensão também aplica).
 * Só hosts de captação conhecidos. Nunca localhost/IP privado/metadata.
 */
const ALLOWED_HOST_SUFFIXES = [
  "google.com",
  "www.google.com",
  "instagram.com",
  "www.instagram.com",
  "linkedin.com",
  "www.linkedin.com",
];

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/i;

export function isUrlAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host)) return false;
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export const RELAY_ALLOWLIST = ALLOWED_HOST_SUFFIXES;
