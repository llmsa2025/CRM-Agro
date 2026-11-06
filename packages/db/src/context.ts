import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "@crmagro/config";

/**
 * Contexto de tenancy por request (AsyncLocalStorage).
 *
 * A extensão Prisma (tenant.ts) lê o teamId daqui — nunca de parâmetro manual.
 * Enquanto o NextAuth não existe, `runAsDev` resolve o teamId do `DEV_TEAM_ID`
 * do env. Quando o NextAuth entrar, troca-se só o resolver (a interface
 * `runWithTeam` / `getCurrentTeamId` não muda).
 *
 * RBAC (fase R1): além do teamId, o contexto pode carregar a IDENTIDADE de quem
 * age — `userId` e `role` (papel). São OPCIONAIS por retrocompatibilidade: quem
 * abre o contexto só com teamId (bootstrap, jobs, testes antigos) continua
 * funcionando, mas nesse caso o papel é tratado como AUSENTE — e a camada de
 * autorização (packages/core/src/auth/authz.ts) é FAIL-CLOSED: sem papel → nega.
 */
export type TenantContext = {
  teamId: string;
  /** Id do usuário que age nesta request (RBAC). Ausente = sem identidade. */
  userId?: string;
  /** Papel do usuário (owner|admin|member|viewer). Ausente = fail-closed. */
  role?: string;
  /**
   * Telas liberadas (plano-equipe-permissoes F2b). Ausente ou vazio = padrão do
   * papel (todas). Só restringe membro e só leitura; master/admin veem tudo.
   */
  modulos?: string[];
  /**
   * "Ver tudo" POR TELA (F3, pedido do dono de 28/09): telas em que a pessoa
   * vê os registros de todos do time (ex.: ["contatos"] = Contatos de todos,
   * Conversas só as dela). Ausente/vazio = só os seus em todas. Master e
   * administrador veem tudo independentemente disto (`escopoDoAtor` no core).
   */
  verTudoEm?: readonly string[];
  /**
   * "Editar tudo" POR TELA: telas em que a pessoa também ALTERA os registros de
   * todos (sempre dentro de `verTudoEm`). Ausente/vazio = altera só os seus.
   * Ver `escopoDoAtor(modulo, { escrita: true })` no core.
   */
  editarTudoEm?: readonly string[];
  /**
   * "Por vendedor" (F4): quem vê tudo pode ler COMO uma pessoa do time (os
   * números do Painel dela). Só estreita o escopo — nunca amplia (ver
   * `escopoDoAtor` no core). Validado pela tela contra a lista do time.
   */
  verComo?: string;
};

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

/** TeamId ativo no contexto atual, ou null se nenhum. */
export function getCurrentTeamId(): string | null {
  return tenantStorage.getStore()?.teamId ?? null;
}

/** UserId ativo no contexto atual, ou null se ausente (RBAC). */
export function getCurrentUserId(): string | null {
  return tenantStorage.getStore()?.userId ?? null;
}

/** Papel ativo no contexto atual, ou null se ausente (RBAC, fail-closed). */
export function getCurrentRole(): string | null {
  return tenantStorage.getStore()?.role ?? null;
}

/** Telas em que quem age vê os registros de todos (F3: escopo por dono). */
export function getCurrentVerTudoEm(): readonly string[] {
  return tenantStorage.getStore()?.verTudoEm ?? [];
}

/** Telas em que quem age ALTERA os registros de todos (escopo de escrita). */
export function getCurrentEditarTudoEm(): readonly string[] {
  return tenantStorage.getStore()?.editarTudoEm ?? [];
}

/** "Por vendedor" (F4): de quem é a visão pedida por quem vê tudo, ou null. */
export function getCurrentVerComo(): string | null {
  return tenantStorage.getStore()?.verComo ?? null;
}

/**
 * Roda `fn` no MESMO contexto, lendo como `userId` (F4, "por vendedor"). Só
 * leitura: quem não vê tudo continua com o próprio escopo (o core ignora).
 */
export function runVendoComo<T>(userId: string, fn: () => T): T {
  const atual = tenantStorage.getStore();
  if (!atual) return fn();
  return tenantStorage.run({ ...atual, verComo: userId }, fn);
}

/** Telas liberadas no contexto atual (vazio/ausente = todas as do papel). */
export function getCurrentModulos(): string[] | null {
  return tenantStorage.getStore()?.modulos ?? null;
}

/**
 * Roda `fn` dentro de um contexto de tenancy.
 *
 * `fn` deve chamar o serviço (que por sua vez chama `db()` no início, de forma
 * síncrona, lendo o teamId daqui). O `db()` captura o teamId num closure, então
 * a execução lazy do PrismaPromise não depende mais do ALS — mas `db()` precisa
 * rodar dentro deste escopo síncrono.
 *
 * O 3º parâmetro `identity` é OPCIONAL (RBAC/R1): quando fornecido, o `userId` e
 * o `role` descem ao contexto para a camada de autorização. Sem ele, o papel
 * fica ausente (fail-closed) — retrocompat total com os callers que só passam
 * teamId.
 *
 * ✅ runWithTeam(id, async () => await contactsService.list())
 * ✅ runWithTeam(id, async () => { ... }, { userId, role })
 */
export function runWithTeam<T>(
  teamId: string,
  fn: () => T,
  identity?: { userId?: string; role?: string; modulos?: string[]; verTudoEm?: readonly string[]; editarTudoEm?: readonly string[] },
): T {
  return tenantStorage.run(
    {
      teamId,
      userId: identity?.userId,
      role: identity?.role,
      modulos: identity?.modulos,
      verTudoEm: identity?.verTudoEm,
      editarTudoEm: identity?.editarTudoEm,
    },
    fn,
  );
}

/**
 * Identidade do SISTEMA: motor de fluxos, webhooks (WhatsApp, Voopi, fluxo),
 * pixel de e-mail, polling de caixa de entrada e jobs do worker agem EM NOME DO
 * TIME, sem um usuário humano por trás.
 *
 * É explícita de propósito (auditoria S7). Com o RBAC dentro dos serviços, "sem
 * papel" continua sendo NEGADO (fail-closed); quem é sistema diz que é. Um
 * usuário nunca chega aqui: a sessão desce `userId` = uuid do User e o papel do
 * banco, e o RBAC só reconhece o sistema quando OS DOIS valores batem.
 */
export const SYSTEM_USER_ID = "system";
export const SYSTEM_ROLE = "system";

/** Roda `fn` no time `teamId` com a identidade do sistema (ver acima). */
export function runAsSystem<T>(teamId: string, fn: () => T): T {
  return runWithTeam(teamId, fn, { userId: SYSTEM_USER_ID, role: SYSTEM_ROLE });
}

/** Resolver de dev: usa DEV_TEAM_ID do env. Substituir por NextAuth quando existir. */
export function runAsDev<T>(fn: () => T): T {
  // Opcional no env (produção não usa): só dev, seed e scripts chegam aqui, e eles precisam da chave.
  if (!env.DEV_TEAM_ID) throw new Error("DEV_TEAM_ID ausente: runAsDev só vale em desenvolvimento, seed e scripts.");
  return runWithTeam(env.DEV_TEAM_ID, fn);
}
