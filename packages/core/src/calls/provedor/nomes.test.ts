import { describe, expect, it } from "vitest";
import * as ligacao from "./index";

/**
 * `packages/core/src/index.ts` faz `export *` de `calls/`. Nome repetido dá TS2308 e some do barrel. O typecheck pega o
 * que é tipo; este teste pega o que existe em tempo de execução, e fixa a regra: todo nome exportado do contrato leva
 * "Ligacao".
 */
describe("nomes exportados do contrato de ligação", () => {
  const nomes = Object.keys(ligacao);

  it("todo valor exportado leva 'Ligacao' (ou 'LIGACAO') no nome, salvo a função pedida pelo plano", () => {
    const sem = nomes.filter((n) => !/Ligacao|LIGACAO/.test(n));
    // `ehProvedorComprovado(chave)` tem o nome fixado pela F1B-03 e pelo projetor da F1B-09.
    expect(sem).toEqual(["ehProvedorComprovado"]);
  });

  it("exporta o que as tarefas seguintes importam", () => {
    for (const n of [
      "definirCapacidadesDeLigacao",
      "CAPACIDADES_BOOLEANAS_DE_LIGACAO",
      "ErroDeLigacao",
      "comoErroDeLigacao",
      "erroDeLigacaoParaLog",
      "FatoDeLigacaoSchema",
      "SinalEfemeroDeLigacaoSchema",
      "criarRegistroDeLigacao",
      "problemasDoRegistroDeLigacao",
      "ehProvedorComprovado",
      "problemasDoDescritorDeLigacao",
    ]) {
      expect(nomes, n).toContain(n);
    }
  });

  it("não exporta o apoio de teste", () => {
    expect(nomes).not.toContain("matrizDeTeste");
    expect(nomes).not.toContain("entradaDeTeste");
  });
});
