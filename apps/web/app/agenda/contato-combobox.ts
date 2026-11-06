/**
 * Regras puras do combobox "Contato (opcional)" do diálogo de compromisso.
 * Ficam fora do componente para serem testadas sem DOM: o que decide se o
 * Esc / clique fora fecha só a lista ou o diálogo inteiro mora aqui.
 */

export type DecisaoFechar = {
  /** A lista de contatos deve ser fechada. */
  fecharLista: boolean;
  /** O diálogo NÃO pode fechar com este evento (o Radix deve receber preventDefault). */
  impedirFecharDialogo: boolean;
};

/**
 * Esc: com a lista aberta fecha só a lista (e segura o diálogo);
 * com a lista fechada o Esc segue o comportamento normal do diálogo.
 */
export function decidirEsc(listaAberta: boolean): DecisaoFechar {
  return { fecharLista: listaAberta, impedirFecharDialogo: listaAberta };
}

/**
 * Clique/toque fora do combobox. Com a lista aberta, fecha só a lista — inclusive
 * quando o clique cai no fundo escurecido, que sozinho fecharia o diálogo.
 * Clique dentro do combobox (campo, lista, botão limpar) não mexe em nada.
 */
export function decidirCliqueFora(listaAberta: boolean, dentroDoCombobox: boolean): DecisaoFechar {
  if (!listaAberta || dentroDoCombobox) return { fecharLista: false, impedirFecharDialogo: false };
  return { fecharLista: true, impedirFecharDialogo: true };
}

export type EstadoContato = {
  contact: { id: string; nome: string } | null;
  search: string;
  showList: boolean;
};

/** Botão "limpar": remove o contato escolhido, zera a busca e fecha a lista. */
export function estadoAoLimpar(): EstadoContato {
  return { contact: null, search: "", showList: false };
}
