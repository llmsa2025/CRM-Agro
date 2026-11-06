import { basePrisma } from "@crmagro/db";
import { redisCache } from "../shared/redis-cache";

/**
 * Revalidação da sessão (auditoria S12).
 *
 * O JWT guardava `teamId` e `role` do login e nunca relia: rebaixar ou remover
 * alguém, ou redefinir a senha, não tinha efeito por até 7 dias. Agora o token
 * carrega `sessionVersion` e o callback `jwt` (apps/web/auth.ts) confere contra
 * o banco — com cache de 60 s no Redis por usuário, para não ir ao banco a cada
 * request. Troca de senha/papel/remoção chama `revokeUserSessions`, que sobe a
 * versão e APAGA o cache: o efeito é imediato na próxima request.
 */

/** Estado da conta que a sessão precisa bater. `null` = usuário não existe mais. */
export type SessionState = { teamId: string; role: string; sessionVersion: number } | null;

/** Janela do cache (e da revalidação do token). */
export const SESSION_CHECK_MS = 60_000;

const chave = (userId: string) => `crmagro:sess:${userId}`;

/** Lê o estado da conta (cache Redis de 60 s; sem Redis, vai direto ao banco). */
export async function getSessionState(userId: string): Promise<SessionState> {
  try {
    const hit = await redisCache().get(chave(userId));
    if (hit) return JSON.parse(hit) as SessionState;
  } catch {
    /* sem cache: segue para o banco */
  }
  const u = await basePrisma.user.findUnique({
    where: { id: userId },
    select: { teamId: true, role: true, sessionVersion: true, desativadoEm: true },
  });
  // Conta desativada (Equipe, F2a) conta como inexistente: a sessão cai.
  const estado: SessionState = u && !u.desativadoEm ? { teamId: u.teamId, role: u.role, sessionVersion: u.sessionVersion } : null;
  try {
    await redisCache().set(chave(userId), JSON.stringify(estado), "PX", SESSION_CHECK_MS);
  } catch {
    /* cache é opcional */
  }
  return estado;
}

/**
 * O token ainda vale? Precisa bater time, papel e versão com o banco. Qualquer
 * divergência derruba (o usuário faz login de novo e pega o estado atual).
 * Token sem `sessionVersion` (emitido antes desta mudança) também cai — um
 * login a mais, uma vez, em troca de não aceitar cookie antigo roubado.
 */
export function sessionIsCurrent(
  token: { teamId?: unknown; role?: unknown; sessionVersion?: unknown },
  estado: SessionState,
): boolean {
  if (!estado) return false;
  return (
    token.teamId === estado.teamId &&
    token.role === estado.role &&
    typeof token.sessionVersion === "number" &&
    token.sessionVersion === estado.sessionVersion
  );
}

/**
 * Derruba todas as sessões abertas do usuário (troca de papel, remoção...).
 * Dentro de uma transação, suba `sessionVersion` na própria transação e chame
 * `forgetSessionCache` DEPOIS do commit (apagar antes deixa uma leitura
 * concorrente recolocar a versão velha no cache).
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  await basePrisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
  await forgetSessionCache(userId);
}

/** Apaga o cache do estado da sessão (chamar DEPOIS de gravar a mudança). */
export async function forgetSessionCache(userId: string): Promise<void> {
  try {
    await redisCache().del(chave(userId));
  } catch {
    /* sem Redis: o cache expira sozinho em 60 s */
  }
}
