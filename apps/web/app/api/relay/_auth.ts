/**
 * Relay hub — autenticação.
 *
 * PRODUÇÃO: token opaco por usuário/time (RelayAgentToken, tenant-scoped,
 * revogável) gerado na tela Integrações → Extensão. `verifyRelayToken` resolve
 * teamId + userId reais pelo hash (cross-team, sem sessão). DEV: além disso,
 * aceita um RELAY_DEV_TOKEN para teste local — NUNCA em produção.
 */
import { verifyRelayToken, rateLimit, peekRateLimit } from "@crmagro/core";

/**
 * S8: tokens ERRADOS por IP (30 / 15 min). Só falha conta, e o bloqueio só vale
 * para falha: o token é conferido PRIMEIRO (uma busca por hash, barata), então
 * token válido passa mesmo com o IP estourado (auditoria do #52 — numa rede com
 * NAT, uma extensão antiga com token revogado derrubava o relay dos colegas).
 * IP estourado só pula a comparação com o token de dev e a contagem.
 */
const FALHAS_POR_IP = { max: 30, janelaMs: 15 * 60 * 1000 };

/**
 * Teto por IP para TODAS as requisições do relay (auditoria do #118): com o
 * token conferido primeiro, cada token inválido custa uma consulta ao banco —
 * uma rajada ocuparia o pool do web. Folgado: uma extensão faz ~40–100
 * requisições por 15 min (long-poll de 25 s + resultados), então 1.800 cobre
 * um escritório com ~15 extensões atrás do mesmo NAT.
 */
const TETO_POR_IP = { max: 1800, janelaMs: 15 * 60 * 1000 };

function ipDoCliente(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

const DEV_TOKEN_DEFAULT = "dev-relay-token-please-change";

/**
 * Token aceito. FAIL-CLOSED em produção: sem RELAY_DEV_TOKEN setado, retorna null
 * → `authenticate` rejeita TUDO (o token padrão hardcoded está no código/git, não
 * pode valer em prod). Em dev, cai no padrão para facilitar o teste local.
 */
export function relayDevToken(): string | null {
  const t = process.env.RELAY_DEV_TOKEN;
  if (t) return t;
  return process.env.NODE_ENV === "production" ? null : DEV_TOKEN_DEFAULT;
}

export interface RelayAuth {
  teamId: string;
  userId: string | null;
  /** Papel atual do dono do token (RBAC). null = sem papel → escrita negada. */
  role: string | null;
  token: string;
}

/**
 * Extrai e valida o Bearer token. Resolve pelo token REAL (RelayAgentToken, DB);
 * em dev, também aceita o RELAY_DEV_TOKEN. Retorna null se inválido/ausente.
 */
export async function authenticate(req: Request): Promise<RelayAuth | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = m?.[1]?.trim();
  if (!token) return null;

  const ip = ipDoCliente(req);
  if (ip && !(await rateLimit(`relay:req:ip:${ip}`, TETO_POR_IP.max, TETO_POR_IP.janelaMs)).allowed) return null;

  // 1) Token real gerado pelo usuário (produção e dev) — antes do bloqueio por falha.
  const real = await verifyRelayToken(token);
  if (real) return { teamId: real.teamId, userId: real.userId, role: real.role, token };

  const chave = ip ? `relay:falha:ip:${ip}` : null;
  if (chave && !(await peekRateLimit(chave, FALHAS_POR_IP.max, FALHAS_POR_IP.janelaMs)).allowed) return null;

  // 2) Fallback SÓ em dev: RELAY_DEV_TOKEN para teste local.
  const dev = relayDevToken();
  if (dev && constantTimeEquals(token, dev)) {
    return { teamId: process.env.DEV_TEAM_ID ?? "dev-team", userId: null, role: null, token };
  }
  if (chave) await rateLimit(chave, FALHAS_POR_IP.max, FALHAS_POR_IP.janelaMs);
  return null;
}

/** Comparação em tempo constante para não vazar o token por timing. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}