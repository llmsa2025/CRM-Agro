/**
 * Regra de estilo para todo texto que a IA escreve (mensagem para contato, nota,
 * resposta do assistente): soar como uma pessoa, não como texto gerado.
 * Vai no system prompt de cada gerador. Hífen DENTRO de palavra é português
 * correto (e-mail, pré-venda) e fica; o que sai é o travessão como pontuação.
 */
export const REGRA_ESTILO_HUMANO = [
  "Escreva como uma pessoa escreveria: frases curtas e diretas, português do Brasil natural, sem tom de vendedor nem de robô.",
  "NÃO use travessão (—) nem meia-risca (–) como pontuação, nem hífen com espaços dos dois lados como separador: use vírgula, ponto, dois-pontos ou parênteses.",
  "Evite expressões com cara de texto de IA (\"é importante ressaltar\", \"vale destacar\", \"no cenário atual\", \"potencialize\", \"solução completa\", \"descubra\"), listas de três itens retóricas e exclamações em excesso.",
].join(" ");

/**
 * Trava determinística para o que a IA devolve: o prompt pede para não usar
 * travessão, mas o modelo às vezes escapa. Aqui "—"/"–" (com ou sem espaços) e
 * " - " viram vírgula. Hífen dentro de palavra (e-mail, pré-venda) e em números
 * ("10-20", telefone) não é tocado.
 */
export function limparEstiloIA(texto: string): string {
  return texto
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/ +- +/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}
