import { describe, expect, it } from "vitest";
import { matrizDeTeste } from "./apoio-de-teste";
import { CAPACIDADES_BOOLEANAS_DE_LIGACAO, CapacidadesDeLigacaoSchema, definirCapacidadesDeLigacao, type CapacidadesDeLigacao } from "./capacidades";

const mensagens = (c: unknown): string[] => {
  const r = CapacidadesDeLigacaoSchema.safeParse(c);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("matriz de capacidades de ligação: formas válidas", () => {
  it("aceita a forma de cada candidato (só no fim, ao vivo, sem consulta)", () => {
    const soNoFim = matrizDeTeste();
    const aoVivo = matrizDeTeste({
      originacaoSincrona: true,
      eventosAoVivo: true,
      causaDoFimGarantida: true,
      consulta: { porId: true, porMinuto: null, trazAtendimento: true },
      gravacao: { entrega: "webhook", prazoHoras: null, aviso: "provedor", apagavel: true },
      webhook: "assinatura_do_provedor",
      sandbox: true,
    });
    const semConsulta = matrizDeTeste({
      provisionarLinha: "manual",
      consulta: { porId: false, porMinuto: null, trazAtendimento: false },
      gravacao: { entrega: "webhook", prazoHoras: 168, aviso: "provedor", apagavel: false },
      webhook: "assinatura_do_provedor",
      ligaAFrio: false,
    });
    const semGravacao = matrizDeTeste({ gravacao: { entrega: "nenhuma", prazoHoras: null, aviso: "nenhum", apagavel: false } });
    const soPonte = matrizDeTeste({ originar: ["ponte"] });
    const os = { soNoFim, aoVivo, semConsulta, semGravacao, soPonte };
    for (const [nome, m] of Object.entries(os)) expect(mensagens(m), nome).toEqual([]);
  });

  it("definirCapacidadesDeLigacao congela a matriz e as partes", () => {
    const c = definirCapacidadesDeLigacao(matrizDeTeste({ originar: ["navegador", "ponte"] }));
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.originar)).toBe(true);
    expect(Object.isFrozen(c.consulta)).toBe(true);
    expect(Object.isFrozen(c.pontasNoAviso)).toBe(true);
    expect(Object.isFrozen(c.gravacao)).toBe(true);
    expect(() => (c.originar as unknown as string[]).push("x")).toThrow();
  });

  it("não guarda referência à entrada (mexer na entrada depois não muda a matriz)", () => {
    const entrada = matrizDeTeste();
    const c = definirCapacidadesDeLigacao(entrada);
    entrada.originar.push("ponte");
    entrada.gravacao.apagavel = true;
    expect(c.originar).toEqual(["navegador"]);
    expect(c.gravacao.apagavel).toBe(false);
  });

  it("as capacidades booleanas simples são todas booleanas na matriz", () => {
    const m = matrizDeTeste();
    for (const k of CAPACIDADES_BOOLEANAS_DE_LIGACAO) expect(typeof m[k], k).toBe("boolean");
    expect([...CAPACIDADES_BOOLEANAS_DE_LIGACAO].sort()).toEqual(
      ["causaDoFimGarantida", "duracaoDesdeAtendimento", "eventosAoVivo", "ligaAFrio", "originacaoSincrona", "sandbox"].sort(),
    );
  });
});

describe("matriz de capacidades de ligação: uma regra, um teste", () => {
  it("originar vazio é recusado", () => {
    expect(mensagens(matrizDeTeste({ originar: [] }))).toEqual(expect.arrayContaining([expect.stringContaining("originar")]));
  });

  it("originar com modo repetido é recusado", () => {
    expect(mensagens(matrizDeTeste({ originar: ["navegador", "navegador"] }))).toContain("originar: Modos de ligar repetidos.");
  });

  it("originar com modo desconhecido é recusado", () => {
    expect(mensagens({ ...matrizDeTeste(), originar: ["sip"] }).length).toBeGreaterThan(0);
  });

  it("sem consulta por id, o limite por minuto precisa ser nulo", () => {
    const m = matrizDeTeste({ consulta: { porId: false, porMinuto: 15, trazAtendimento: false } });
    expect(mensagens(m)).toContain("consulta.porMinuto: Sem consulta por id não há limite de consultas por minuto.");
  });

  it("sem consulta por id, a consulta não traz o atendimento", () => {
    const m = matrizDeTeste({ consulta: { porId: false, porMinuto: null, trazAtendimento: true } });
    expect(mensagens(m)).toContain("consulta.trazAtendimento: Sem consulta por id a consulta não traz o atendimento.");
  });

  it("gravação 'nenhuma' com aviso diferente de nenhum é recusada", () => {
    const m = matrizDeTeste({ gravacao: { entrega: "nenhuma", prazoHoras: null, aviso: "crmagro", apagavel: false } });
    expect(mensagens(m)).toContain("gravacao: Sem entrega de gravação, o aviso é nenhum, o prazo é nulo e não há o que apagar.");
  });

  it("gravação 'nenhuma' com prazo é recusada", () => {
    const m = matrizDeTeste({ gravacao: { entrega: "nenhuma", prazoHoras: 24, aviso: "nenhum", apagavel: false } });
    expect(mensagens(m).some((x) => x.startsWith("gravacao:"))).toBe(true);
  });

  it("gravação 'nenhuma' que diz ser apagável é recusada", () => {
    const m = matrizDeTeste({ gravacao: { entrega: "nenhuma", prazoHoras: null, aviso: "nenhum", apagavel: true } });
    expect(mensagens(m).some((x) => x.startsWith("gravacao:"))).toBe(true);
  });

  it("gravação entregue sem aviso, sem prazo e sem como apagar é recusada (seria 'nenhuma')", () => {
    for (const entrega of ["webhook", "consulta"] as const) {
      const m = matrizDeTeste({ gravacao: { entrega, prazoHoras: null, aviso: "nenhum", apagavel: false } });
      expect(mensagens(m).some((x) => x.startsWith("gravacao:")), entrega).toBe(true);
    }
  });

  it("prazo da gravação precisa ser inteiro positivo ou nulo", () => {
    for (const prazoHoras of [0, -1, 1.5]) {
      const m = matrizDeTeste({ gravacao: { entrega: "webhook", prazoHoras, aviso: "provedor", apagavel: false } });
      expect(mensagens(m).length, String(prazoHoras)).toBeGreaterThan(0);
    }
  });

  it("limite de consultas por minuto precisa ser inteiro positivo ou nulo", () => {
    for (const porMinuto of [0, -3, 2.5]) {
      expect(mensagens(matrizDeTeste({ consulta: { porId: true, porMinuto, trazAtendimento: false } })).length, String(porMinuto)).toBeGreaterThan(0);
    }
  });

  it("originação síncrona exige o modo navegador", () => {
    const m = matrizDeTeste({ originar: ["ponte"], originacaoSincrona: true });
    expect(mensagens(m)).toContain("originacaoSincrona: Originação síncrona exige o modo navegador.");
  });
});

describe("matriz de capacidades de ligação: campos estritos", () => {
  it("campo desconhecido na raiz ou aninhado é recusado", () => {
    const base = matrizDeTeste();
    const ruins: unknown[] = [
      { ...base, navegador: "sip_wss" },
      { ...base, consulta: { ...base.consulta, porJanela: true } },
      { ...base, gravacao: { ...base.gravacao, extra: 1 } },
      { ...base, pontasNoAviso: { ...base.pontasNoAviso, nome: true } },
    ];
    for (const r of ruins) expect(CapacidadesDeLigacaoSchema.safeParse(r).success).toBe(false);
  });

  it("campo faltando é recusado (n/c não vale: o adaptador diz sim ou não)", () => {
    const base = matrizDeTeste() as Partial<CapacidadesDeLigacao>;
    for (const campo of Object.keys(base) as (keyof CapacidadesDeLigacao)[]) {
      const resto = Object.fromEntries(Object.entries(base).filter(([k]) => k !== campo));
      expect(CapacidadesDeLigacaoSchema.safeParse(resto).success, campo).toBe(false);
    }
  });

  it("definirCapacidadesDeLigacao lança em matriz incoerente, sem repetir valores", () => {
    expect(() => definirCapacidadesDeLigacao(matrizDeTeste({ originar: [] }))).toThrow();
  });
});
