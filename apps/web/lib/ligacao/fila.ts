import type { ContatoDaLigacao } from "./estado";

/**
 * De onde sai o "Próximo" depois de uma ligação: a lista que o vendedor tinha na tela (Painel, Atividades,
 * fila do Discador). A loja guarda a fonte (`definirFonteDoProximo`) e a barra pergunta a ela.
 *
 * Aqui só existe o TIPO. `fonteDeLista(itens)` e o componente `FilaDeLigacao` chegam na F3-04, que pode
 * ajustar este formato.
 */
export type FonteDoProximo = {
  /** Nome da lista para a tela, por exemplo "Ligar hoje". */
  rotulo: string;
  /** O contato que vem depois de `atualId`, ou nulo quando a lista acabou. */
  proximo(atualId: string): ContatoDaLigacao | null;
  /** Quantos contatos ainda faltam depois de `atualId`. */
  restantes?(atualId: string): number;
};
