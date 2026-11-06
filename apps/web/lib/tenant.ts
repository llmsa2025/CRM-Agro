import { redirect } from "next/navigation";
import { runWithTeam } from "@crmagro/db";
import { ForbiddenError, roleAtLeast, type Role } from "@crmagro/core";
import { temTela } from "@/lib/telas";
import { auth } from "@/auth";

/**
 * Resolver de tenancy de PRODUÇÃO — substitui o `runAsDev` (que fixava
 * DEV_TEAM_ID do env).
 *
 * Regra FAIL-CLOSED da PARTE 0: sem time no contexto, zero resultados — nunca
 * "todos". Aqui isso vira: sem sessão válida, não executamos nada. Páginas
 * redirecionam para o login; server actions recebem erro.
 *
 * RBAC (R1): além do teamId, descemos IDENTIDADE (userId + role) ao contexto,
 * para a camada de autorização (packages/core authz). Se a sessão não trouxer
 * papel (token antigo), `role` desce ausente — e a autorização nega (fail-closed).
 *
 * Toda leitura/escrita de dados do cliente passa por aqui. Se algum caminho
 * escapar, a extensão do Prisma ainda barra (não há teamId no ALS), mas o
 * objetivo é que nada chegue lá sem sessão.
 */

/** teamId da sessão, ou null. Não redireciona — use quando o caller decide. */
export async function currentTeamId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.teamId || null;
}

/** Sessão completa (id do usuário + time + papel), ou null. */
export async function currentUser(): Promise<{
  id: string;
  teamId: string;
  role?: string;
  name?: string | null;
  email?: string | null;
  modulos: string[];
  /** Telas em que vê os registros de todos ("ver tudo" por tela). */
  verTudoEm: string[];
  /** Telas em que também altera os registros de todos (dentro de `verTudoEm`). */
  editarTudoEm: string[];
} | null> {
  const session = await auth();
  if (!session?.user?.teamId) return null;
  return {
    id: session.user.id,
    teamId: session.user.teamId,
    role: session.user.role,
    modulos: session.user.modulos ?? [],
    verTudoEm: session.user.verTudoEm ?? [],
    editarTudoEm: session.user.editarTudoEm ?? [],
    name: session.user.name,
    email: session.user.email,
  };
}

/**
 * Identidade da sessão para o contexto de tenancy: papel, telas e o que a
 * pessoa vê e altera por tela. Um lugar só — ninguém esquece uma das listas.
 */
export function identidade(user: NonNullable<Awaited<ReturnType<typeof currentUser>>>) {
  return { userId: user.id, role: user.role, modulos: user.modulos, verTudoEm: user.verTudoEm, editarTudoEm: user.editarTudoEm };
}

/**
 * Guarda de RBAC no NÍVEL DA ACTION, para actions que NÃO abrem `runWithTeam`
 * (logo `requireRole`, que lê o ALS, não enxergaria o papel). Lê o papel da
 * sessão e lança `ForbiddenError` se insuficiente. FAIL-CLOSED: sem sessão/papel
 * → nega. Devolve o usuário para uso subsequente.
 */
export async function requireRoleAction(min: Role): Promise<{
  id: string;
  teamId: string;
  role?: string;
}> {
  const user = await currentUser();
  if (!user || !roleAtLeast(user.role, min)) throw new ForbiddenError();
  return user;
}

/**
 * Executa `fn` no contexto do time+identidade da sessão. Para PÁGINAS (server
 * components): sem sessão, redireciona para o login.
 */
export async function runAsUser<T>(fn: () => Promise<T>): Promise<T> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return runWithTeam(user.teamId, fn, identidade(user));
}

/**
 * Igual ao `runAsUser`, mas para SERVER ACTIONS: lança em vez de redirecionar
 * (um redirect dentro de action é engolido pelo cliente e vira erro obscuro).
 */
export async function runAsUserAction<T>(fn: () => Promise<T>): Promise<T> {
  const user = await currentUser();
  if (!user) throw new Error("NaoAutenticado");
  return runWithTeam(user.teamId, fn, identidade(user));
}

/**
 * `runAsUserAction` de uma TELA (F2b; revisão do #150). O Next deixa chamável
 * TODO o arquivo "use server" a partir de qualquer página que importe uma
 * action dele — o middleware só vê o caminho da página. Por isso cada arquivo
 * de actions de uma tela confere a tela aqui, no início de cada action.
 *
 * Uso no topo do actions.ts da tela: `const runAsUserAction = acaoDaTela("conversas");`
 */
export function acaoDaTela(tela: string, opts: { tambem?: readonly string[] } = {}) {
  return async function runAsUserActionNaTela<T>(fn: () => Promise<T>): Promise<T> {
    const user = await currentUser();
    if (!user) throw new Error("NaoAutenticado");
    if (!temTela(user.role, user.modulos, tela)) throw new ForbiddenError();
    // Exceção do dono (28/09): a ação de Contatos/Funis vale ONDE O BOTÃO
    // APARECE (Mapa, Conversas) — quem tem a tela recebe, só nesta action, os
    // módulos de `tambem`. Lista vazia = todas as telas (nada a acrescentar).
    // O papel continua valendo (o core confere `requireCan`).
    const modulos = user.modulos.length && opts.tambem?.length ? [...new Set([...user.modulos, ...opts.tambem])] : user.modulos;
    return runWithTeam(user.teamId, fn, { ...identidade(user), modulos });
  };
}
