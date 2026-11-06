export class FunnelNotFound extends Error {
  constructor(id: string) {
    super(`FunnelNotFound: ${id}`);
    this.name = "FunnelNotFound";
  }
}

export class StageNotFound extends Error {
  constructor(id: string) {
    super(`StageNotFound: ${id}`);
    this.name = "StageNotFound";
  }
}

export class DealNotFound extends Error {
  constructor(id: string) {
    super(`DealNotFound: ${id}`);
    this.name = "DealNotFound";
  }
}

/** Etapa não pode ser excluída porque ainda tem negócios/cards nela. */
export class StageNotEmpty extends Error {
  constructor(id: string, readonly deals: number) {
    super(`StageNotEmpty: a etapa ${id} tem ${deals} negócio(s). Mova ou exclua os cards antes.`);
    this.name = "StageNotEmpty";
  }
}

/** Funil não pode ser excluído porque ainda tem negócios. */
export class FunnelNotEmpty extends Error {
  constructor(id: string, readonly deals: number) {
    super(`FunnelNotEmpty: o funil ${id} tem ${deals} negócio(s). Mova ou exclua os negócios antes.`);
    this.name = "FunnelNotEmpty";
  }
}
