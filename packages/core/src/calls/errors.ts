/** Erros nomeados do domínio de ligações (não usar `throw new Error(...)` solto). */

export class CallNotFound extends Error {
  constructor(id: string) {
    super(`CallNotFound: nenhuma ligação com id ${id} neste time.`);
    this.name = "CallNotFound";
  }
}

export class CallValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallValidationError";
  }
}

/**
 * A Voopi não está pronta para ligar (sem conta cadastrada, integração
 * desligada ou faltando configuração no servidor). A tela cai no discador
 * manual — o `motivo` diz o que falta.
 */
export class VoopiNaoConfigurada extends Error {
  constructor(readonly motivo: string) {
    super(`VoopiNaoConfigurada: ${motivo}.`);
    this.name = "VoopiNaoConfigurada";
  }
}

/** A API da Voopi recusou ou não respondeu (o detalhe não traz a resposta crua). */
export class VoopiFalhou extends Error {
  constructor(readonly acao: "ligar" | "desligar", detalhe: string) {
    super(`VoopiFalhou: não deu para ${acao} pela Voopi (${detalhe}).`);
    this.name = "VoopiFalhou";
  }
}

/** O contato não tem telefone válido para ligar (sem número, ou só número errado). */
export class ContatoSemTelefoneValido extends Error {
  constructor(contactId: string, motivo = "sem telefone válido") {
    super(`ContatoSemTelefoneValido: contato ${contactId}: ${motivo}.`);
    this.name = "ContatoSemTelefoneValido";
  }
}

/**
 * O contato pediu para sair (opt-out). Ligar exige a confirmação do vendedor
 * (`confirmarOptOut`) — um "me tira da lista" costuma valer para ligação.
 */
export class ContatoPediuParaSair extends Error {
  constructor(contactId: string) {
    super(`ContatoPediuParaSair: o contato ${contactId} pediu para sair. Confirme antes de ligar.`);
    this.name = "ContatoPediuParaSair";
  }
}
