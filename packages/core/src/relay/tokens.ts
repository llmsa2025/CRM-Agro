/**
 * Tokens da extensão de relay (captação pelo IP residencial do usuário).
 *
 * O agente (extensão do navegador) NÃO tem sessão do CRM Agro — ele autentica cada
 * requisição com um `Authorization: Bearer <token>`. Este serviço:
 *   - gera tokens opacos por usuário/time (tenant-scoped, via db()/tenantData);
 *   - guarda só o sha256 do token (nunca o texto puro) + um prefixo p/ exibir;
 *   - revoga tokens (soft, revokedAt);
 *   - verifica um token apresentado SEM sessão (cross-team via basePrisma, como
 *     os webhooks), resolvendo teamId/userId reais — nunca o DEV_TEAM_ID.
 *
 * Segurança: o TEXTO PURO do token é devolvido UMA ÚNICA VEZ (na criação). Não
 * há como recuperá-lo depois — só o hash fica no banco.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { basePrisma, db, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";

/** Item mascarado — NUNCA contém o token nem o hash. */
export type RelayTokenDTO = {
  id: string;
  label: string;
  tokenPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export type CreatedRelayToken = {
  id: string;
  label: string;
  tokenPrefix: string;
  /** Texto puro — exibido UMA vez, não é recuperável depois. */
  token: string;
};

const TOKEN_PREFIX = "rly_";

/**
 * Início do rótulo dos tokens que o DOWNLOAD da extensão cria sozinho
 * ("Extensão (download 2026-09-30)"). É o que separa esses tokens dos que a pessoa
 * gera na mão, para revogar só os de download que nunca foram usados.
 */
export const ROTULO_TOKEN_DOWNLOAD = "Extensão (download";

/** Rótulo do token criado por um download, na data dada. */
export function rotuloDoTokenDeDownload(data: Date): string {
  return `${ROTULO_TOKEN_DOWNLOAD} ${data.toISOString().slice(0, 10)})`;
}

function ehRotuloDeDownload(label: string): boolean {
  return label.trim().toLowerCase().startsWith(ROTULO_TOKEN_DOWNLOAD.toLowerCase());
}

/** sha256 hex do token apresentado (lookup O(1) por hash único). */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Gera um token opaco: "rly_" + 32 bytes base64url. */
function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

function toDTO(r: {
  id: string;
  label: string;
  tokenPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): RelayTokenDTO {
  return {
    id: r.id,
    label: r.label,
    tokenPrefix: r.tokenPrefix,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  };
}

/**
 * Cria um token de relay para o time atual (tenant-scoped). Retorna o TEXTO PURO
 * uma única vez — o chamador deve exibi-lo ao usuário e nunca persisti-lo.
 */
export async function createRelayToken(input: {
  label: string;
  userId?: string;
  /** Só a rota de download passa true: o rótulo "Extensão (download …)" é reservado a ela. */
  doDownload?: boolean;
}): Promise<CreatedRelayToken> {
  requireCan("relay.tokens");
  const label = input.label.trim();
  if (!label) throw new Error("label do token obrigatório");
  if (!input.doDownload && ehRotuloDeDownload(label)) {
    throw new Error("Esse nome é reservado. Escolha outro nome para o token.");
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  // ex.: "rly_ab12" — primeiros 8 chars visíveis, só p/ identificar na lista.
  const tokenPrefix = token.slice(0, 8);

  const row = await db().relayAgentToken.create({
    data: tenantData<Prisma.RelayAgentTokenUncheckedCreateInput>({
      label,
      tokenHash,
      tokenPrefix,
      ...(input.userId ? { userId: input.userId } : {}),
    }),
    select: { id: true, label: true, tokenPrefix: true },
  });

  return { id: row.id, label: row.label, tokenPrefix: row.tokenPrefix, token };
}

/**
 * Revoga os tokens que os downloads ANTERIORES da extensão criaram para este
 * usuário e que nunca foram usados (`lastUsedAt` vazio). Cada download cria um
 * token novo; sem isto, quem baixa várias vezes acumula tokens ativos e sem uso.
 *
 * Seguro de propósito: só o próprio usuário, só o rótulo de download e só o que
 * nunca autenticou. Token já em uso (uma extensão instalada) NÃO é tocado, então
 * baixar de novo para atualizar não derruba a extensão de outro computador.
 * Tenant-scoped (`db()` injeta o time) e exige o mesmo papel que gerar token.
 * Devolve quantos foram revogados.
 */
export async function revogarTokensDeDownloadNaoUsados(userId: string): Promise<number> {
  requireCan("relay.tokens");
  if (!userId) return 0;
  const r = await db().relayAgentToken.updateMany({
    where: { userId, revokedAt: null, lastUsedAt: null, label: { startsWith: ROTULO_TOKEN_DOWNLOAD } },
    data: { revokedAt: new Date() },
  });
  return r.count;
}

/**
 * Nome do dono do token e do time dele, para a extensão mostrar "de quem é" e
 * quem conecta uma conta veja em qual CRM Agro ela vai parar. Só nomes (nunca
 * e-mail). Sem sessão, como o `verifyRelayToken`: o token já foi conferido.
 */
export async function descreverDonoDoToken(
  teamId: string,
  userId: string | null,
): Promise<{ nome: string | null; time: string | null }> {
  if (!userId) return { nome: null, time: null };
  const u = await basePrisma.user.findFirst({
    where: { id: userId, teamId },
    select: { name: true, team: { select: { name: true } } },
  });
  return { nome: u?.name ?? null, time: u?.team?.name ?? null };
}

/** Lista mascarada dos tokens do time (nunca devolve token nem hash). */
export async function listRelayTokens(): Promise<RelayTokenDTO[]> {
  const rows = await db().relayAgentToken.findMany({
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      label: true,
      tokenPrefix: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  return rows.map(toDTO);
}

/** Revoga um token (soft, revokedAt). Tenant-scoped — só afeta o próprio time. */
export async function revokeRelayToken(id: string): Promise<void> {
  requireCan("relay.tokens");
  await db().relayAgentToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Verifica um token apresentado pela extensão (SEM sessão). Cross-team via
 * `basePrisma` (como os webhooks). Rejeita tokens revogados; atualiza lastUsedAt
 * best-effort. Devolve teamId/userId reais ou null.
 */
export async function verifyRelayToken(
  token: string,
): Promise<{ teamId: string; userId: string | null; role: string | null } | null> {
  const t = token?.trim();
  if (!t) return null;
  const tokenHash = hashToken(t);

  const row = await basePrisma.relayAgentToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      teamId: true,
      userId: true,
      revokedAt: true,
      user: { select: { teamId: true, role: true } },
    },
  });
  if (!row || row.revokedAt) return null;

  // best-effort: não bloqueia a autenticação se a escrita falhar.
  try {
    await basePrisma.relayAgentToken.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });
  } catch {
    /* noop */
  }

  // RBAC: a extensão age com o papel ATUAL de quem gerou o token (rebaixou o
  // usuário → o token perde poder junto). Dono em outro time ou apagado → sem papel.
  const role = row.user && row.user.teamId === row.teamId ? row.user.role : null;
  return { teamId: row.teamId, userId: row.userId, role };
}
