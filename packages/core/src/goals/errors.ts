/** Erros nomeados do domínio de metas (não usar `throw new Error(...)` solto). */

export class GoalNotFound extends Error {
  readonly code = "GoalNotFound";
  constructor(id: string) {
    super(`GoalNotFound: nenhuma meta com id ${id} neste time.`);
    this.name = "GoalNotFound";
  }
}

/** Detecta o "registro não encontrado" do Prisma (P2025) sem importar o client. */
export function isRecordNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2025";
}
