import { afterEach, describe, expect, it } from "vitest";
import {
  avaliarEspera,
  fimPedeUmaPessoa,
  lerEstadoDoAgente,
  motivoLegivelDaFalha,
  pausaAntesDeResponderMs,
  textoDoFim,
  type EstadoDoAgente,
} from "./agente-conversa";

const estado = (o: Partial<EstadoDoAgente> = {}): EstadoDoAgente => ({
  acao: "esperando",
  conversationId: "c1",
  enviadas: 1,
  vistoAte: "2026-10-01T10:00:00.000Z",
  enviadoEm: "2026-10-01T10:00:00.000Z",
  mensagemId: "m1",
  falhas: 0,
  ...o,
});

describe("lerEstadoDoAgente", () => {
  it("pega o estado mais novo e ignora passos sem estado (adiados, falhos)", () => {
    const r = lerEstadoDoAgente([{ motivo: "fora do horário de envio" }, null, { agente: estado({ enviadas: 3 }) }, { agente: estado({ enviadas: 1 }) }]);
    expect(r?.enviadas).toBe(3);
  });

  it("estado 'encerrou' no topo = conversa nova (recomeça do zero)", () => {
    expect(lerEstadoDoAgente([{ agente: { ...estado(), acao: "encerrou", fim: "silencio" } }, { agente: estado() }])).toBeNull();
  });

  it("sem nada, ou com estado torto, devolve null", () => {
    expect(lerEstadoDoAgente([])).toBeNull();
    expect(lerEstadoDoAgente([{ agente: { acao: "esperando" } }, { agente: "x" }])).toBeNull();
  });
});

describe("avaliarEspera", () => {
  const agora = new Date("2026-10-01T12:00:00.000Z");
  const base = { estado: estado(), agora, silencioMs: 24 * 3_600_000, maxRespostas: 6, novasDoContato: 0, mensagensDeOutros: 0 };

  it("contato falou: prepara a resposta", () => {
    expect(avaliarEspera({ ...base, novasDoContato: 1 })).toEqual({ tipo: "preparar" });
  });

  it("contato falou e o agente já mandou tudo: limite", () => {
    expect(avaliarEspera({ ...base, novasDoContato: 2, estado: estado({ enviadas: 6 }) })).toEqual({ tipo: "limite" });
  });

  it("uma pessoa respondeu à mão: o agente se cala, mesmo com o contato falando de novo", () => {
    expect(avaliarEspera({ ...base, novasDoContato: 3, mensagensDeOutros: 1 })).toEqual({ tipo: "pessoa_respondeu" });
  });

  it("ninguém falou: segue esperando até o prazo e depois encerra por silêncio", () => {
    expect(avaliarEspera(base)).toEqual({ tipo: "continuar_esperando", restanteMs: 22 * 3_600_000 });
    expect(avaliarEspera({ ...base, agora: new Date("2026-10-02T10:00:00.000Z") })).toEqual({ tipo: "silencio" });
    expect(avaliarEspera({ ...base, agora: new Date("2026-10-02T10:00:01.000Z") })).toEqual({ tipo: "silencio" });
  });
});

describe("pausa antes de responder", () => {
  afterEach(() => {
    delete process.env.FLOW_AGENTE_PAUSA_MIN_S;
    delete process.env.FLOW_AGENTE_PAUSA_MAX_S;
  });

  it("fica entre 8 e 20 segundos por padrão", () => {
    for (let i = 0; i < 50; i++) {
      const ms = pausaAntesDeResponderMs();
      expect(ms).toBeGreaterThanOrEqual(8_000);
      expect(ms).toBeLessThanOrEqual(20_000);
    }
  });

  it("zera por env (testes e emergência)", () => {
    process.env.FLOW_AGENTE_PAUSA_MIN_S = "0";
    process.env.FLOW_AGENTE_PAUSA_MAX_S = "0";
    expect(pausaAntesDeResponderMs()).toBe(0);
  });
});

describe("textos do fim", () => {
  it("só passar para pessoa e limite pedem uma pessoa", () => {
    expect(fimPedeUmaPessoa("passou_para_pessoa")).toBe(true);
    expect(fimPedeUmaPessoa("limite")).toBe(true);
    for (const f of ["silencio", "pessoa_respondeu", "encerrado_pela_ia"] as const) expect(fimPedeUmaPessoa(f)).toBe(false);
  });

  it("os textos não usam travessão e trazem o motivo", () => {
    expect(textoDoFim("passou_para_pessoa", "pediu o preço")).toBe("O agente passou a conversa para uma pessoa: pediu o preço");
    for (const f of ["passou_para_pessoa", "silencio", "pessoa_respondeu", "encerrado_pela_ia", "limite"] as const) {
      expect(textoDoFim(f, "x")).not.toMatch(/[—–]/);
    }
    expect(motivoLegivelDaFalha("sem_chave")).toContain("chave");
    expect(motivoLegivelDaFalha("qualquer")).toBe("a IA deu erro");
  });
});
