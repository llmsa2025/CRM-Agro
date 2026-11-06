/** Erros nomeados do domínio de tags (não usar `throw new Error(...)` solto). */

export class TagNotFound extends Error {
  constructor(id: string) {
    super(`TagNotFound: nenhuma tag com id ${id} neste time.`);
    this.name = "TagNotFound";
  }
}

export class TagJaExiste extends Error {
  constructor(nome: string) {
    super(`TagJaExiste: já existe uma tag chamada "${nome}" neste time.`);
    this.name = "TagJaExiste";
  }
}

export class TagNomeVazio extends Error {
  constructor() {
    super("TagNomeVazio: o nome da tag está vazio.");
    this.name = "TagNomeVazio";
  }
}
