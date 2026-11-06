import { describe, expect, it } from "vitest";
import { adaptadorDeTeste, descritorDeTeste, entradaDeTeste, matrizDeTeste } from "./apoio-de-teste";
import { definirCapacidadesDeLigacao, type CapacidadesDeLigacao } from "./capacidades";
import type { ProvedorDeLigacao } from "./interface";
import {
  ProvedorDeLigacaoNaoRegistrado,
  RegistroDeLigacaoIncoerente,
  criarRegistroDeLigacao,
  ehProvedorComprovado,
  flagDoProvedorDeLigacao,
  problemasDoRegistroDeLigacao,
  registroPadraoDeLigacao,
  type ProvedorRegistradoDeLigacao,
} from "./registro";

describe("registro de provedores de ligação", () => {
  it("registra, lista na ordem, obtém e responde se tem", () => {
    const r = criarRegistroDeLigacao();
    r.registrar(entradaDeTeste("teste_um"));
    r.registrar(entradaDeTeste("teste_dois"));
    expect(r.chaves()).toEqual(["teste_um", "teste_dois"]);
    expect(r.tem("teste_um")).toBe(true);
    expect(r.tem("api4com")).toBe(false);
    expect(r.obter("teste_dois").fabrica().chave).toBe("teste_dois");
    expect(r.listar()).toHaveLength(2);
  });

  it("provedor não registrado lança erro nomeado, e chave estranha nem entra", () => {
    const r = criarRegistroDeLigacao();
    expect(() => r.obter("api4com")).toThrow(ProvedorDeLigacaoNaoRegistrado);
    expect(r.tem("../etc/passwd")).toBe(false);
  });

  it("chave repetida ou com formato inválido é recusada", () => {
    const r = criarRegistroDeLigacao();
    r.registrar(entradaDeTeste());
    expect(() => r.registrar(entradaDeTeste())).toThrow(RegistroDeLigacaoIncoerente);
    expect(() => r.registrar({ ...entradaDeTeste(), chave: "Chave Inválida" })).toThrow(RegistroDeLigacaoIncoerente);
  });

  it("entrada coerente não tem problema", () => {
    expect(problemasDoRegistroDeLigacao(entradaDeTeste())).toEqual([]);
  });

  it("recusa quando a chave do registro, do descritor e do adaptador não são a mesma", () => {
    const e = entradaDeTeste("teste_um");
    expect(problemasDoRegistroDeLigacao({ ...e, descritor: descritorDeTeste("teste_dois") })).toContain("A chave do registro é diferente da chave do descritor.");
    expect(problemasDoRegistroDeLigacao({ ...e, fabrica: () => adaptadorDeTeste("teste_dois") })).toContain("A chave do adaptador é diferente da chave do registro.");
    expect(() => criarRegistroDeLigacao().registrar({ ...e, descritor: descritorDeTeste("teste_dois") })).toThrow(/diferente da chave/);
  });

  it("recusa quando o modo de webhook do descritor discorda da matriz", () => {
    const e = entradaDeTeste();
    const d = descritorDeTeste("teste_um", { webhook: { ...e.descritor.webhook, modo: "assinatura_do_provedor" } });
    expect(problemasDoRegistroDeLigacao({ ...e, descritor: d })).toContain("O modo de webhook do descritor é diferente do da matriz.");
  });

  it("recusa quando a matriz diz sandbox e o descritor não tem o ambiente de teste (e o contrário)", () => {
    const comSandbox = entradaDeTeste("teste_um", { sandbox: true });
    expect(problemasDoRegistroDeLigacao(comSandbox)).toContain("A matriz diz que há sandbox, mas o descritor não tem o ambiente de teste (ou o contrário).");
    const semSandbox = entradaDeTeste();
    const d = descritorDeTeste("teste_um", { ambientes: ["teste", "producao"] });
    expect(problemasDoRegistroDeLigacao({ ...semSandbox, descritor: d })).toContain("A matriz diz que há sandbox, mas o descritor não tem o ambiente de teste (ou o contrário).");
    const ok = { ...comSandbox, descritor: d };
    expect(problemasDoRegistroDeLigacao(ok)).toEqual([]);
  });

  it("recusa matriz incoerente no registro, sem derrubar o resto da conferência", () => {
    const e = entradaDeTeste();
    const ruim = { ...matrizDeTeste(), originar: [] } as unknown as CapacidadesDeLigacao;
    expect(problemasDoRegistroDeLigacao({ ...e, capacidades: ruim })).toContain("A matriz de capacidades é incoerente.");
  });

  it("recusa quando a matriz do registro é diferente da do adaptador", () => {
    const e = entradaDeTeste();
    const outra = definirCapacidadesDeLigacao(matrizDeTeste({ ligaAFrio: false }));
    expect(problemasDoRegistroDeLigacao({ ...e, fabrica: () => adaptadorDeTeste("teste_um", outra) })).toContain("A matriz do registro é diferente da matriz do adaptador.");
  });

  it("recusa fábrica que falha", () => {
    const e = entradaDeTeste();
    const p = problemasDoRegistroDeLigacao({
      ...e,
      fabrica: () => {
        throw new Error("segredo-123456");
      },
    });
    expect(p).toContain("A fábrica do adaptador falhou ao criar uma instância.");
    expect(p.join(" ")).not.toContain("segredo-123456");
  });

  it("a flag é ligacao_provedor_ seguido da chave", () => {
    expect(flagDoProvedorDeLigacao("api4com")).toBe("ligacao_provedor_api4com");
    const e = entradaDeTeste();
    expect(problemasDoRegistroDeLigacao({ ...e, flag: "ligacao_provedor_outro" })).toContain("A flag do provedor precisa ser ligacao_provedor_ seguido da chave.");
    expect(problemasDoRegistroDeLigacao({ ...e, flag: "" })).toContain("A flag do provedor precisa ser ligacao_provedor_ seguido da chave.");
  });

  it("o rótulo é obrigatório e segue a §15", () => {
    const e = entradaDeTeste();
    expect(problemasDoRegistroDeLigacao({ ...e, rotulo: "  " })).toContain("O provedor precisa de um rótulo.");
    expect(problemasDoRegistroDeLigacao({ ...e, rotulo: "Telefonia — API" }).join(" ")).toMatch(/travessão/);
  });

  it("junta os problemas do descritor", () => {
    const e = entradaDeTeste();
    const d = descritorDeTeste("teste_um", { nome: " " });
    expect(problemasDoRegistroDeLigacao({ ...e, descritor: d })).toContain("O provedor precisa de um nome.");
  });

  describe("métodos opcionais batem com a matriz, nos dois sentidos", () => {
    type Caso = { metodo: keyof ProvedorDeLigacao; com: Partial<CapacidadesDeLigacao>; sem: Partial<CapacidadesDeLigacao>; mensagem: string };
    // A matriz base do apoio tem consultar, provisionarLinha e obterGravacao; não tem responderOriginacao nem apagarGravacao.
    const casos: Caso[] = [
      { metodo: "consultar", com: {}, sem: { consulta: { porId: false, porMinuto: null, trazAtendimento: false } }, mensagem: "O método consultar e a capacidade consulta.porId discordam." },
      { metodo: "provisionarLinha", com: {}, sem: { provisionarLinha: "manual" }, mensagem: "O método provisionarLinha e a capacidade provisionarLinha discordam." },
      { metodo: "responderOriginacao", com: { originacaoSincrona: true }, sem: {}, mensagem: "O método responderOriginacao e a capacidade originacaoSincrona discordam." },
      { metodo: "obterGravacao", com: {}, sem: { gravacao: { entrega: "nenhuma", prazoHoras: null, aviso: "nenhum", apagavel: false } }, mensagem: "O método obterGravacao e a capacidade gravacao.entrega discordam." },
      { metodo: "apagarGravacao", com: { gravacao: { entrega: "webhook", prazoHoras: null, aviso: "crmagro", apagavel: true } }, sem: {}, mensagem: "O método apagarGravacao e a capacidade gravacao.apagavel discordam." },
    ];

    it.each(casos)("$metodo: sobra ou falta em relação à matriz é recusado", ({ metodo, com, sem, mensagem }) => {
      const comRecurso = definirCapacidadesDeLigacao(matrizDeTeste(com));
      const semRecurso = definirCapacidadesDeLigacao(matrizDeTeste(sem));
      const adaptadorCom = adaptadorDeTeste("teste_um", comRecurso);
      const adaptadorSem = adaptadorDeTeste("teste_um", semRecurso);
      expect(typeof adaptadorCom[metodo]).toBe("function");
      expect(adaptadorSem[metodo]).toBeUndefined();

      const e = entradaDeTeste();
      // A matriz diz "sem o recurso", mas o adaptador tem o método:
      const sobra: ProvedorRegistradoDeLigacao = { ...e, capacidades: semRecurso, fabrica: () => ({ ...adaptadorSem, [metodo]: adaptadorCom[metodo] }) };
      expect(problemasDoRegistroDeLigacao(sobra)).toContain(mensagem);
      // A matriz diz "com o recurso", mas o adaptador não tem o método:
      const falta: ProvedorRegistradoDeLigacao = { ...e, capacidades: comRecurso, fabrica: () => ({ ...adaptadorCom, [metodo]: undefined }) };
      expect(problemasDoRegistroDeLigacao(falta)).toContain(mensagem);
    });

    it("com adaptador e matriz coerentes nos 5 métodos, nenhum problema", () => {
      const tudo = matrizDeTeste({
        originacaoSincrona: true,
        webhook: "url_assinada",
        gravacao: { entrega: "consulta", prazoHoras: 168, aviso: "provedor", apagavel: true },
      });
      expect(problemasDoRegistroDeLigacao(entradaDeTeste("teste_um", tudo))).toEqual([]);
      const nada = matrizDeTeste({
        provisionarLinha: "manual",
        consulta: { porId: false, porMinuto: null, trazAtendimento: false },
        gravacao: { entrega: "nenhuma", prazoHoras: null, aviso: "nenhum", apagavel: false },
      });
      expect(problemasDoRegistroDeLigacao(entradaDeTeste("teste_um", nada))).toEqual([]);
    });
  });

  it("o registro recusa entrada incoerente, com os problemas no erro", () => {
    const r = criarRegistroDeLigacao();
    try {
      r.registrar({ ...entradaDeTeste(), flag: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RegistroDeLigacaoIncoerente);
      expect((e as RegistroDeLigacaoIncoerente).problemas).toContain("A flag do provedor precisa ser ligacao_provedor_ seguido da chave.");
    }
    expect(r.chaves()).toEqual([]);
  });
});

describe("provedor comprovado", () => {
  it("é false por padrão: entrada sem 'comprovado' não é comprovada", () => {
    const r = criarRegistroDeLigacao();
    r.registrar(entradaDeTeste("teste_um"));
    expect(r.obter("teste_um").comprovado).toBeUndefined();
    expect(ehProvedorComprovado("teste_um", r)).toBe(false);
  });

  it("só a entrada que declara 'comprovado: true' conta", () => {
    const r = criarRegistroDeLigacao();
    r.registrar({ ...entradaDeTeste("teste_um"), comprovado: true });
    r.registrar({ ...entradaDeTeste("teste_dois"), comprovado: false });
    r.registrar(entradaDeTeste("teste_tres"));
    expect(ehProvedorComprovado("teste_um", r)).toBe(true);
    expect(ehProvedorComprovado("teste_dois", r)).toBe(false);
    expect(ehProvedorComprovado("teste_tres", r)).toBe(false);
  });

  it("chave desconhecida ou estranha é false", () => {
    const r = criarRegistroDeLigacao();
    expect(ehProvedorComprovado("api4com", r)).toBe(false);
    expect(ehProvedorComprovado("", r)).toBe(false);
    expect(ehProvedorComprovado("../etc/passwd", r)).toBe(false);
    expect(ehProvedorComprovado("__proto__", r)).toBe(false);
    expect(ehProvedorComprovado("constructor", r)).toBe(false);
  });

  it("no registro do app, nenhuma chave é comprovada (F2-23 e F4-16 mudam este teste quando o gate delas passar)", () => {
    for (const chave of ["api4com", "twilio", "whatsapp_cloud", "wavoip", "fake", "manual"]) expect(ehProvedorComprovado(chave), chave).toBe(false);
    for (const p of registroPadraoDeLigacao.listar()) expect(p.comprovado === true, p.chave).toBe(false);
  });

  it("o registro do app é coerente (cada entrada passa na conferência)", () => {
    for (const p of registroPadraoDeLigacao.listar()) expect(problemasDoRegistroDeLigacao(p), p.chave).toEqual([]);
  });
});
