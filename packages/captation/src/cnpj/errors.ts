export class CnpjInvalid extends Error {
  constructor(public readonly cnpj: string) {
    super(`CNPJ inválido: ${cnpj}`);
    this.name = "CnpjInvalid";
  }
}

export class CnpjNotFound extends Error {
  constructor(public readonly cnpj: string) {
    super(`CNPJ não encontrado: ${cnpj}`);
    this.name = "CnpjNotFound";
  }
}

export class CnpjLookupFailed extends Error {
  constructor(public readonly cnpj: string, message: string) {
    super(`Falha ao consultar CNPJ ${cnpj}: ${message}`);
    this.name = "CnpjLookupFailed";
  }
}

/**
 * O CNPJá devolveu 429: o limite de 5/min POR IP estourou (item 3.2, INT-13).
 * Subclasse de `CnpjLookupFailed` para quem só trata a falha genérica; o
 * consultor compartilhado do core usa o tipo para esvaziar o balde global.
 */
export class CnpjaLimite extends CnpjLookupFailed {
  constructor(cnpj: string) {
    super(cnpj, "429 (limite do CNPJá)");
    this.name = "CnpjaLimite";
  }
}

/**
 * A OpenCNPJ devolveu 429 (limite de uso). O consultor do core para de chamá-la por um minuto
 * (item de gentileza com uma API gratuita e sem limite publicado) e segue pela BrasilAPI.
 */
export class OpenCnpjLimite extends CnpjLookupFailed {
  constructor(cnpj: string) {
    super(cnpj, "429 (limite da OpenCNPJ)");
    this.name = "OpenCnpjLimite";
  }
}
