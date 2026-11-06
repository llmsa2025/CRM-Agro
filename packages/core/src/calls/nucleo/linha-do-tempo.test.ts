import { describe, expect, it } from "vitest";
import { consulta, fimDaConsulta, fimDoCrmAgro, fimDoWebhook, permutacoes, webhook } from "./apoio-de-teste";
import {
  EntradaDaLinhaDoTempoDeLigacaoSchema,
  ORIGENS_DE_FATO_DE_LIGACAO,
  acrescentarFatoDeLigacao,
  ehOrigemDoProvedorDeLigacao,
  entradaDaLinhaDoTempoDeLigacao,
  idDeEventoDaLinhaDoTempoDeLigacao,
  lerLinhaDoTempoDeLigacao,
  normalizarLinhaDoTempoDeLigacao,
  type EntradaDaLinhaDoTempoDeLigacao,
} from "./linha-do-tempo";

describe("entrada da linha do tempo", () => {
  it("o idEvento leva a origem na frente", () => {
    expect(idDeEventoDaLinhaDoTempoDeLigacao("webhook", "ev_1")).toBe("webhook:ev_1");
    expect(webhook("ev_1", 0, "chamando").idEvento).toBe("webhook:ev_1");
    expect(consulta("ev_1", 0, "chamando").idEvento).toBe("consulta:ev_1");
    expect(fimDoCrmAgro("ev_1", 0, "desconhecida").idEvento).toBe("crmagro:ev_1");
  });

  it("o fato de origem crmagro usa crmagro:<callId>:<tipo>:<n> e pode vir sem providerCallId", () => {
    const callId = "0b8f6b0e-6f0e-4f8e-9a52-3f1c1d2a4b5c";
    const fato = { idEvento: `${callId}:encerrada:1`, tipo: "encerrada", causa: "desconhecida", ocorridoEm: "2026-10-18T12:00:00-03:00", refDaLigacao: callId };
    const r = EntradaDaLinhaDoTempoDeLigacaoSchema.safeParse({ idEvento: `crmagro:${callId}:encerrada:1`, origem: "crmagro", fato });
    expect(r.success).toBe(true);
  });

  it("aceita as três origens", () => {
    expect([...ORIGENS_DE_FATO_DE_LIGACAO].sort()).toEqual(["consulta", "crmagro", "webhook"]);
    for (const origem of ORIGENS_DE_FATO_DE_LIGACAO) {
      const e = entradaDaLinhaDoTempoDeLigacao(origem, webhook("x", 0, "chamando").fato);
      expect(EntradaDaLinhaDoTempoDeLigacaoSchema.safeParse(e).success, origem).toBe(true);
    }
  });

  it("só o provedor prova: a origem crmagro não", () => {
    expect(ehOrigemDoProvedorDeLigacao("webhook")).toBe(true);
    expect(ehOrigemDoProvedorDeLigacao("consulta")).toBe(true);
    expect(ehOrigemDoProvedorDeLigacao("crmagro")).toBe(false);
  });

  it("recusa idEvento que não bate com a origem e o id do fato, e campo desconhecido", () => {
    const boa = webhook("ev_1", 0, "chamando");
    expect(EntradaDaLinhaDoTempoDeLigacaoSchema.safeParse({ ...boa, idEvento: "consulta:ev_1" }).success).toBe(false);
    expect(EntradaDaLinhaDoTempoDeLigacaoSchema.safeParse({ ...boa, idEvento: "ev_1" }).success).toBe(false);
    expect(EntradaDaLinhaDoTempoDeLigacaoSchema.safeParse({ ...boa, telefone: "+5511999999999" }).success).toBe(false);
    expect(EntradaDaLinhaDoTempoDeLigacaoSchema.safeParse({ ...boa, origem: "provedor" }).success).toBe(false);
  });
});

describe("acrescentarFatoDeLigacao", () => {
  it("acrescenta e devolve a lista ordenada por instante", () => {
    const a = webhook("a", 30, "atendida");
    const b = webhook("b", 10, "chamando");
    const r1 = acrescentarFatoDeLigacao([], a);
    expect(r1).toEqual({ entradas: [a], igual: false });
    const r2 = acrescentarFatoDeLigacao(r1.entradas, b);
    expect(r2.entradas.map((e) => e.idEvento)).toEqual(["webhook:b", "webhook:a"]);
    expect(r2.igual).toBe(false);
  });

  it("o mesmo idEvento só vale uma vez: a lista não muda e diz que é igual", () => {
    const a = webhook("a", 30, "atendida");
    const r = acrescentarFatoDeLigacao([a], a);
    expect(r.igual).toBe(true);
    expect(r.entradas).toEqual([a]);
  });

  it("o primeiro que chegou fica quando o mesmo idEvento volta com outro conteúdo", () => {
    const primeiro = fimDoWebhook("f1", 60, "atendida", { duracaoConectadaS: 40 });
    const outro = fimDoWebhook("f1", 60, "atendida", { duracaoConectadaS: 400 });
    const r = acrescentarFatoDeLigacao([primeiro], outro);
    expect(r.igual).toBe(true);
    expect(r.entradas).toEqual([primeiro]);
  });

  it("o mesmo id do adaptador em origens diferentes são dois eventos", () => {
    const r = acrescentarFatoDeLigacao([fimDoWebhook("x", 30, "ocupado")], fimDaConsulta("x", 30, "ocupado"));
    expect(r.igual).toBe(false);
    expect(r.entradas.map((e) => e.idEvento).sort()).toEqual(["consulta:x", "webhook:x"]);
  });

  it("não muda a lista que recebeu", () => {
    const atual = [webhook("a", 30, "atendida")];
    const copia = structuredClone(atual);
    acrescentarFatoDeLigacao(atual, webhook("b", 10, "chamando"));
    expect(atual).toEqual(copia);
  });

  it("a ordem de chegada não aparece no que se grava", () => {
    const fatos = [webhook("c", 0, "chamando"), webhook("a", 8, "atendida"), fimDoWebhook("f", 90, "atendida"), webhook("a", 8, "atendida"), fimDaConsulta("q", 90, "atendida")];
    const resultados = permutacoes(fatos).map((ordem) => {
      let linha: EntradaDaLinhaDoTempoDeLigacao[] = [];
      for (const f of ordem) linha = acrescentarFatoDeLigacao(linha, f).entradas;
      return linha;
    });
    for (const r of resultados) expect(r).toEqual(resultados[0]);
    expect(resultados[0]).toHaveLength(4);
  });

  it("ordena por instante de verdade, não por texto, quando os fusos são diferentes", () => {
    const tarde = entradaDaLinhaDoTempoDeLigacao("webhook", { idEvento: "t", tipo: "chamando", ocorridoEm: "2026-10-18T12:00:10-03:00", providerCallId: "pc_1" });
    // 15:00:05 em UTC é 12:00:05 em Brasília: vem ANTES, apesar de o texto "15..." ser maior que "12...".
    const cedo = entradaDaLinhaDoTempoDeLigacao("webhook", { idEvento: "c", tipo: "chamando", ocorridoEm: "2026-10-18T15:00:05Z", providerCallId: "pc_1" });
    expect(acrescentarFatoDeLigacao([tarde], cedo).entradas.map((e) => e.idEvento)).toEqual(["webhook:c", "webhook:t"]);
  });
});

describe("lerLinhaDoTempoDeLigacao", () => {
  const boas = [webhook("c", 0, "chamando"), fimDaConsulta("q", 90, "atendida", { duracaoConectadaS: 60 }), fimDoCrmAgro("s", 100, "desconhecida")];

  it("aceita as três origens e devolve ordenado, sem descartar nada", () => {
    const r = lerLinhaDoTempoDeLigacao([...boas].reverse());
    expect(r.descartadas).toBe(0);
    expect(r.entradas).toEqual(boas);
  });

  it("lê o que foi gravado como JSON", () => {
    const r = lerLinhaDoTempoDeLigacao(JSON.parse(JSON.stringify(boas)));
    expect(r).toEqual({ entradas: boas, descartadas: 0 });
  });

  it("nulo e indefinido são uma linha do tempo vazia, sem nada descartado", () => {
    expect(lerLinhaDoTempoDeLigacao(null)).toEqual({ entradas: [], descartadas: 0 });
    expect(lerLinhaDoTempoDeLigacao(undefined)).toEqual({ entradas: [], descartadas: 0 });
  });

  it("o que não é lista conta como descartado", () => {
    expect(lerLinhaDoTempoDeLigacao({ a: 1 })).toEqual({ entradas: [], descartadas: 1 });
    expect(lerLinhaDoTempoDeLigacao("lixo")).toEqual({ entradas: [], descartadas: 1 });
  });

  it("não joga fora em silêncio: entrada inválida é contada", () => {
    const lixo = [null, 7, "x", {}, { ...boas[0], origem: "meta" }, { ...boas[0], fato: { tipo: "tocando" } }, { ...boas[0], idEvento: "outro:id" }];
    const r = lerLinhaDoTempoDeLigacao([...boas, ...lixo]);
    expect(r.entradas).toEqual(boas);
    expect(r.descartadas).toBe(lixo.length);
  });

  it("repetição no JSON vale uma vez, e não conta como descartada", () => {
    const r = lerLinhaDoTempoDeLigacao([boas[0], boas[0], boas[1]]);
    expect(r.entradas).toEqual([boas[0], boas[1]]);
    expect(r.descartadas).toBe(0);
  });
});

describe("normalizarLinhaDoTempoDeLigacao", () => {
  it("uma entrada por idEvento, em ordem estável, em qualquer ordem de chegada", () => {
    const verdadeiro = fimDoWebhook("f1", 100, "atendida", { duracaoConectadaS: 80 });
    const forjado = fimDoWebhook("f1", 100, "atendida", { duracaoConectadaS: 800 });
    const outro = webhook("c", 0, "chamando");
    const a = normalizarLinhaDoTempoDeLigacao([verdadeiro, forjado, outro, outro]);
    const b = normalizarLinhaDoTempoDeLigacao([outro, forjado, outro, verdadeiro]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });
});
