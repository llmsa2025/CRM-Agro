/**
 * Nome completo do contato. No cadastro nome e sobrenome são campos separados, mas toda lista, cabeçalho e
 * ficha mostra os dois juntos ("Danilo Silva"). Sem importar valor do `@crmagro/core`: serve a qualquer tela.
 */
export function nomeCompleto(c: { nome: string; sobrenome?: string | null }): string {
  return [c.nome, c.sobrenome].map((p) => p?.trim()).filter(Boolean).join(" ");
}
