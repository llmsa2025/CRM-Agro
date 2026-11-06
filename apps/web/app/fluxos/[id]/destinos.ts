/**
 * Saída da condição com UM ou VÁRIOS destinos. O primeiro (`principal`) é o `nextNodeId` de sempre; os outros
 * (`mais`) começam ao mesmo tempo, cada um como um caminho paralelo. Funções puras, sem React.
 */
export type Saida = { principal: string | null; mais: string[] };

/** Todos os destinos da saída, na ordem de execução, sem repetir. */
export function todosDestinos(principal: string | null | undefined, mais: readonly string[] | undefined): string[] {
  return [...new Set([principal, ...(mais ?? [])].filter((x): x is string => !!x))];
}

/** Liga mais um destino à saída (o primeiro vira o principal; um já ligado não repete). */
export function adicionarDestino(principal: string | null | undefined, mais: readonly string[] | undefined, alvo: string): Saida {
  const todos = todosDestinos(principal, mais);
  if (!todos.includes(alvo)) todos.push(alvo);
  return { principal: todos[0] ?? null, mais: todos.slice(1) };
}

/** Tira um destino da saída; se era o principal, o próximo assume. */
export function removerDestino(principal: string | null | undefined, mais: readonly string[] | undefined, alvo: string): Saida {
  const todos = todosDestinos(principal, mais).filter((x) => x !== alvo);
  return { principal: todos[0] ?? null, mais: todos.slice(1) };
}

/** Ordem estável no mapa (de cima para baixo): quem segue na inscrição de origem e quem vira caminho paralelo. */
export function ordenarPorPosicao(ids: readonly string[], posicoes: ReadonlyMap<string, { x: number; y: number }>): string[] {
  return [...ids].sort((a, b) => {
    const pa = posicoes.get(a);
    const pb = posicoes.get(b);
    if (!pa || !pb) return 0;
    return pa.y - pb.y || pa.x - pb.x;
  });
}
