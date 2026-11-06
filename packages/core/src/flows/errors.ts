/** Erros nomeados do domínio de fluxos (não usar `throw new Error(...)` solto). */

export class FlowNotFound extends Error {
  constructor(id: string) {
    super(`FlowNotFound: ${id}`);
    this.name = "FlowNotFound";
  }
}

export class FlowNotActive extends Error {
  constructor(id: string) {
    super(`FlowNotActive: o fluxo ${id} não está ativo.`);
    this.name = "FlowNotActive";
  }
}

export class EnrollmentNotFound extends Error {
  constructor(id: string) {
    super(`EnrollmentNotFound: ${id}`);
    this.name = "EnrollmentNotFound";
  }
}

export class NodeNotFound extends Error {
  constructor(nodeId: string) {
    super(`NodeNotFound: nó ${nodeId} não está no snapshot do enrollment.`);
    this.name = "NodeNotFound";
  }
}

export class InvalidGraphError extends Error {
  constructor(message: string) {
    super(`InvalidGraphError: ${message}`);
    this.name = "InvalidGraphError";
  }
}

/** O horário de envio do fluxo (`triggerConfig.janelaEnvio`) veio torto: o motivo vai na mensagem. */
export class JanelaDeEnvioInvalida extends Error {
  constructor(motivo: string) {
    super(`JanelaDeEnvioInvalida: ${motivo}`);
    this.name = "JanelaDeEnvioInvalida";
  }
}

/**
 * O contato já está percorrendo o fluxo (inscrição em andamento). É um `InvalidGraphError` (quem já tratava
 * esse erro continua tratando), com nome próprio para a tela oferecer "Encerrar e testar de novo".
 */
export class ContatoJaNoFluxo extends InvalidGraphError {
  constructor() {
    super("este contato já está percorrendo o fluxo (inscrição em andamento)");
    this.name = "ContatoJaNoFluxo";
  }
}

/** Rodar o fluxo nos contatos selecionados passou do que cabe de uma vez (`contatos-selecionados.ts`). */
export class SelecaoGrandeDemais extends Error {
  constructor(
    public readonly max: number,
    public readonly pedidos: number,
  ) {
    super(`SelecaoGrandeDemais: são ${pedidos} contatos e cabem ${max} por vez. Selecione menos contatos ou rode em partes.`);
    this.name = "SelecaoGrandeDemais";
  }
}

/** O fluxo tem passo ou gatilho que o tipo dele não aceita (`tipos.ts`). Cada frase diz o que e onde pode. */
export class FluxoForaDoTipo extends Error {
  constructor(public readonly problemas: string[]) {
    super(`FluxoForaDoTipo: ${problemas.join(" ")}`);
    this.name = "FluxoForaDoTipo";
  }
}

/** O tipo do fluxo não muda depois de criado. */
export class TipoDoFluxoNaoMuda extends Error {
  constructor() {
    super("TipoDoFluxoNaoMuda: o tipo do fluxo é escolhido na criação e não muda. Crie outro fluxo do tipo que você precisa.");
    this.name = "TipoDoFluxoNaoMuda";
  }
}

/** O tipo pedido ainda não pode ser criado. */
export class TipoDoFluxoIndisponivel extends Error {
  constructor(tipo: string) {
    super(`TipoDoFluxoIndisponivel: o tipo ${tipo} ainda não está disponível.`);
    this.name = "TipoDoFluxoIndisponivel";
  }
}

/** Nó existe no enum mas ainda não tem implementação (ex.: ai_agent). */
export class NodeNotImplementedError extends Error {
  constructor(tipo: string) {
    super(`NodeNotImplementedError: tipo de nó "${tipo}" não implementado.`);
    this.name = "NodeNotImplementedError";
  }
}

/**
 * A inscrição mudou entre a tela e o clique (item 1.9, MF-17): outro clique em
 * "definir destino"/"ligação feita" ou o próprio motor já agiu. Antes, o 2º
 * clique criava uma segunda "linha de execução" na mesma inscrição (dois envios).
 */
export class EnrollmentChanged extends Error {
  constructor(id: string) {
    super(`EnrollmentChanged: a inscrição ${id} mudou (outro clique ou o motor já agiu). Atualize a tela.`);
    this.name = "EnrollmentChanged";
  }
}

/**
 * A condição "Tem WhatsApp" no modo "conferir no WhatsApp" não conseguiu a resposta (Evolution fora, lenta ou
 * resposta que não dá para ler). Não é recusa: o motor repete o passo com espera crescente e, esgotadas as
 * tentativas, SEGURA a inscrição para revisão. Nunca escolhe um ramo no escuro.
 */
export class ConsultaWhatsAppIndisponivel extends Error {
  constructor(public readonly motivo: string) {
    super(`ConsultaWhatsAppIndisponivel: ${motivo}`);
    this.name = "ConsultaWhatsAppIndisponivel";
  }
}
