/** Erros nomeados da importação de contatos (produto §C). */

/** Arquivo sem cabeçalho ou sem nenhuma linha de dados. */
export class PlanilhaVazia extends Error {
  constructor() {
    super("PlanilhaVazia: a planilha não tem cabeçalho ou não tem linhas.");
    this.name = "PlanilhaVazia";
  }
}

/** Passou do limite de linhas/colunas de uma importação. */
export class PlanilhaGrandeDemais extends Error {
  constructor(readonly limite: string) {
    super(`PlanilhaGrandeDemais: ${limite}. Divida o arquivo em partes menores.`);
    this.name = "PlanilhaGrandeDemais";
  }
}

/** Mapeamento que não casa com as colunas (tamanho) ou repete um campo único. */
export class MapeamentoInvalido extends Error {
  constructor(motivo: string) {
    super(`MapeamentoInvalido: ${motivo}`);
    this.name = "MapeamentoInvalido";
  }
}

/** Importação que não existe (ou é de outro time — mesma resposta). */
export class ImportJobNotFound extends Error {
  constructor(id: string) {
    super(`ImportJobNotFound: ${id}`);
    this.name = "ImportJobNotFound";
  }
}
