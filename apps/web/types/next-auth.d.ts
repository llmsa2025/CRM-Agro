import type { DefaultSession } from "next-auth";

/**
 * `teamId` na sessão — é o que a tenancy consome (ver lib/tenant.ts).
 * `role` (RBAC) desce junto para a camada de autorização (packages/core authz).
 * Sem esta declaração o TypeScript não conhece os campos que gravamos no callback.
 */
declare module "next-auth" {
  interface Session {
    /** `modulos`: telas liberadas (F2b); vazio = todas as do papel. */
    /** `verTudoEm`: telas em que vê os registros de todos ("ver tudo" por tela, F3). */
    user: { id: string; teamId: string; role?: string; modulos?: string[]; verTudoEm?: string[]; editarTudoEm?: string[] } & DefaultSession["user"];
  }
  interface User {
    teamId?: string;
    role?: string;
    sessionVersion?: number;
    modulos?: string[];
    verTudoEm?: string[];
    editarTudoEm?: string[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    teamId?: string;
    role?: string;
    /** Versão da sessão no login (S12) — conferida com o banco a cada ~60 s. */
    sessionVersion?: number;
    /** Última conferência com o banco (epoch ms). */
    checkedAt?: number;
    /** Telas liberadas (F2b). Mudar as telas derruba a sessão: o token novo traz as atuais. */
    modulos?: string[];
    /** "Ver tudo" por tela (F3). Mudar derruba a sessão: o token novo traz a lista atual. */
    verTudoEm?: string[];
    /** "Editar" por tela (dentro de `verTudoEm`). Token de antes da troca, sem a lista = edita onde vê. */
    editarTudoEm?: string[];
    /** OBSOLETO: o "ver tudo" tudo-ou-nada de antes (token emitido antes da troca = todas as telas). */
    verTudo?: boolean;
  }
}
