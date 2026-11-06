import { modoCifraContatos } from "@crmagro/db";

/** Erros nomeados do domínio de contatos (não usar `throw new Error(...)` solto). */

export class ContactNotFound extends Error {
  constructor(id: string) {
    super(`ContactNotFound: nenhum contato com id ${id} neste time.`);
    this.name = "ContactNotFound";
  }
}

/** Telefone/e-mail que já pertence a OUTRO contato do time (unique global). */
export class IdentifierTaken extends Error {
  constructor(
    readonly canal: string,
    readonly valor: string,
  ) {
    const rotulo = canal === "email" ? "e-mail" : canal === "whatsapp" ? "telefone" : canal;
    // Com a cifra de e-mail e telefone ligada (CONTATOS_CIFRA != off), o valor não vai na mensagem (ela
    // sobe para o navegador e para o log) nem fica enumerável no erro. Com `off` nada muda.
    const protegido = modoCifraContatos() !== "off" && (canal === "email" || canal === "whatsapp");
    super(protegido ? `IdentifierTaken: o ${rotulo} informado já pertence a outro contato neste time.` : `IdentifierTaken: o ${rotulo} "${valor}" já pertence a outro contato neste time.`);
    this.name = "IdentifierTaken";
    if (protegido) Object.defineProperty(this, "valor", { value: valor, enumerable: false });
  }
}

/** Detecta a violação de unique do Prisma (P2002) sem importar o valor do client. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

export class ContactValidationError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ContactValidationError";
  }
}

/**
 * A unificação não terminou (auditoria do #113): um duplicado ainda tem
 * conversa ou uma inscrição nova apareceu no meio. Nada se perde — o que já foi
 * movido fica no mantido, e unificar de novo termina o trabalho.
 */
export class UnificacaoIncompleta extends Error {
  constructor() {
    super("UnificacaoIncompleta: a unificação não terminou. Unifique de novo para concluir.");
    this.name = "UnificacaoIncompleta";
  }
}

/**
 * O contato já existe na base (mesmo telefone/e-mail/perfil). Regra do dono
 * (28/09): não se cadastra duas vezes a mesma pessoa. Quando é de OUTRO
 * responsável, quem tentou não vê nem usa o contato — pede ao gestor para
 * mudar o responsável. `contactId` só vem quando a pessoa pode abrir o contato.
 */
/**
 * Contato que pediu para sair: o status dele não muda por aqui. Mudar para "Cliente" ou "Contatado" religaria,
 * sem ninguém perceber, as campanhas e os fluxos de quem pediu para não receber mensagens.
 */
export class StatusDeQuemSaiuNaoMuda extends Error {
  constructor() {
    super("StatusDeQuemSaiuNaoMuda: este contato pediu para sair e não recebe mensagens. O status dele não muda por aqui.");
    this.name = "StatusDeQuemSaiuNaoMuda";
  }
}

export class ContatoJaCadastrado extends Error {
  constructor(
    readonly responsavelNome: string | null,
    readonly contactId: string | null,
  ) {
    super(
      contactId
        ? "ContatoJaCadastrado: este contato já está cadastrado. Abra o existente."
        : `ContatoJaCadastrado: este contato já está cadastrado${responsavelNome ? ` com o responsável ${responsavelNome}` : " com outro responsável"}. Peça ao gestor para mudar o responsável.`,
    );
    this.name = "ContatoJaCadastrado";
  }
}

/**
 * Responsável escolhido no cadastro não vale (regra do dono, 28/09): só quem vê
 * o time todo (gestor) escolhe outra pessoa, e ela tem de estar ATIVA no time.
 */
export class ResponsavelInvalido extends Error {
  constructor(readonly motivo: "so_gestor" | "pessoa_invalida") {
    super(
      motivo === "so_gestor"
        ? "ResponsavelInvalido: só a gestão escolhe outro responsável. O contato fica com quem cadastra."
        : "ResponsavelInvalido: escolha uma pessoa ativa da equipe como responsável.",
    );
    this.name = "ResponsavelInvalido";
  }
}

/** A busca de contatos passou do tempo limite do banco (palavra comum demais numa base grande). */
export class BuscaMuitoLenta extends Error {
  constructor() {
    super("BuscaMuitoLenta: a busca demorou demais. Use uma palavra mais específica.");
    this.name = "BuscaMuitoLenta";
  }
}

/** A busca de contatos falhou por outro motivo (o detalhe vai para o log, sem o termo pesquisado). */
export class BuscaFalhou extends Error {
  constructor() {
    super("BuscaFalhou: não consegui buscar agora. Tente de novo em instantes.");
    this.name = "BuscaFalhou";
  }
}

/** Ação em massa sobre uma busca que achou mais contatos do que o teto. */
export class BuscaGrandeDemais extends Error {
  constructor(readonly teto: number) {
    super(`BuscaGrandeDemais: a busca achou mais de ${teto.toLocaleString("pt-BR")} contatos. Refine a busca para agir em todos.`);
    this.name = "BuscaGrandeDemais";
  }
}
