/**
 * Prazos para a automação de navegador (item 3.2, INT-11). Puro: nada de
 * Playwright aqui — o worker usa estes helpers em volta das chamadas dele.
 *
 * - `comPrazo`: uma chamada que pode travar (`page.evaluate`/`$$eval` NÃO
 *   respeitam o `setDefaultTimeout` do Playwright) falha em `ms` em vez de
 *   prender a fila `capture` (concorrência 1) até o próximo restart.
 * - `comTeto`: teto do JOB inteiro. Ao estourar, chama `aoEstourar` (que fecha o
 *   navegador e salva o parcial) e devolve sem esperar o trabalho travado.
 */

export class PrazoEsgotado extends Error {
  constructor(
    public readonly rotulo: string,
    public readonly ms: number,
  ) {
    super(`${rotulo}: sem resposta em ${Math.round(ms / 1000)}s`);
    this.name = "PrazoEsgotado";
  }
}

/** Rejeita com `PrazoEsgotado` se `p` não terminar em `ms`. */
export function comPrazo<T>(p: Promise<T>, ms: number, rotulo: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new PrazoEsgotado(rotulo, ms)), ms);
  });
  // O race assina `p`: se ele rejeitar depois do prazo, a rejeição fica tratada.
  return Promise.race([p, prazo]).finally(() => clearTimeout(timer));
}

export type ResultadoTeto<T> = { estourou: false; valor: T } | { estourou: true };

/**
 * Corre `p` contra o teto `ms`. Terminou antes: devolve o valor (ou repassa o
 * erro). Estourou: roda `aoEstourar` e devolve `{ estourou: true }` — `p` segue
 * pendente, e quem chama decide quanto mais esperar por ele.
 */
export async function comTeto<T>(
  p: Promise<T>,
  ms: number,
  aoEstourar: () => Promise<void> | void,
): Promise<ResultadoTeto<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const teto = new Promise<{ estourou: true }>((ok) => {
    timer = setTimeout(() => ok({ estourou: true }), ms);
  });
  const r = await Promise.race([p.then((valor) => ({ estourou: false as const, valor })), teto]).finally(() =>
    clearTimeout(timer),
  );
  if (r.estourou) await aoEstourar();
  return r;
}
