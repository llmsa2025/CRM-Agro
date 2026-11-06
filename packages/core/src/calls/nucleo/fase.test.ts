import { describe, expect, it } from "vitest";
import { capacidadesDoPerfilDeLigacao } from "../provedor/fake/perfis";
import { consulta, fimDoCrmAgro, webhook } from "./apoio-de-teste";
import { PRAZO_SEM_CONFIRMACAO_DE_LIGACAO_MS, faseDaLigacao, semConfirmacaoDaLigacao, type FaseDaLigacao } from "./fase";

const criadaEm = new Date("2026-10-18T12:00:00-03:00");
const depois = (ms: number) => new Date(criadaEm.getTime() + ms);

describe("faseDaLigacao", () => {
  it("sem número do provedor e sem fato: preparando", () => {
    expect(faseDaLigacao({ status: "scheduled", providerCallId: null, linhaDoTempo: [] })).toBe("preparando");
  });

  it("com número do provedor e sem fato: conectando", () => {
    expect(faseDaLigacao({ status: "scheduled", providerCallId: "pc_1", linhaDoTempo: [] })).toBe("conectando");
  });

  it("com o aviso de que o celular do contato está tocando: chamando", () => {
    expect(faseDaLigacao({ status: "scheduled", providerCallId: "pc_1", linhaDoTempo: [webhook("c", 0, "chamando")] })).toBe("chamando");
    expect(faseDaLigacao({ status: "scheduled", providerCallId: "pc_1", linhaDoTempo: [consulta("c", 0, "chamando")] })).toBe("chamando");
  });

  it("com o aviso de atendida: em andamento, mesmo depois do toque", () => {
    const linha = [webhook("c", 0, "chamando"), webhook("a", 8, "atendida")];
    expect(faseDaLigacao({ status: "scheduled", providerCallId: "pc_1", linhaDoTempo: linha })).toBe("em_andamento");
    expect(faseDaLigacao({ status: "scheduled", providerCallId: "pc_1", linhaDoTempo: [...linha].reverse() })).toBe("em_andamento");
  });

  it("com status terminal: encerrada, seja qual for a linha do tempo", () => {
    for (const status of ["completed", "no_answer", "busy", "failed"] as const) {
      expect(faseDaLigacao({ status, providerCallId: null, linhaDoTempo: [] })).toBe("encerrada");
      expect(faseDaLigacao({ status, providerCallId: "pc_1", linhaDoTempo: [webhook("a", 8, "atendida")] })).toBe("encerrada");
    }
  });

  it("o fechamento sintético do CRM Agro não faz a ligação tocar nem ser atendida", () => {
    const linha = [fimDoCrmAgro("s", 5, "desconhecida")];
    expect(faseDaLigacao({ status: "scheduled", providerCallId: "pc_1", linhaDoTempo: linha })).toBe("conectando");
  });
});

describe("semConfirmacaoDaLigacao", () => {
  const aoVivo = capacidadesDoPerfilDeLigacao("ao_vivo");
  const soNoFim = capacidadesDoPerfilDeLigacao("so_no_fim");

  it("o prazo é de 3 minutos", () => {
    expect(PRAZO_SEM_CONFIRMACAO_DE_LIGACAO_MS).toBe(180_000);
  });

  it.each(["preparando", "conectando", "chamando"] as FaseDaLigacao[])("provedor que avisa ao vivo, fase %s: passou de 3 min vira sem confirmação", (fase) => {
    expect(semConfirmacaoDaLigacao({ fase, criadaEm }, depois(PRAZO_SEM_CONFIRMACAO_DE_LIGACAO_MS), aoVivo)).toBe(false);
    expect(semConfirmacaoDaLigacao({ fase, criadaEm }, depois(PRAZO_SEM_CONFIRMACAO_DE_LIGACAO_MS + 1), aoVivo)).toBe(true);
    expect(semConfirmacaoDaLigacao({ fase, criadaEm }, depois(10_000), aoVivo)).toBe(false);
  });

  it("ligação atendida ou encerrada nunca fica sem confirmação", () => {
    for (const fase of ["em_andamento", "encerrada"] as FaseDaLigacao[]) {
      expect(semConfirmacaoDaLigacao({ fase, criadaEm }, depois(3_600_000), aoVivo)).toBe(false);
    }
  });

  it("provedor que só avisa o fim nunca fica sem confirmação no meio da ligação", () => {
    for (const fase of ["preparando", "conectando", "chamando", "em_andamento"] as FaseDaLigacao[]) {
      expect(semConfirmacaoDaLigacao({ fase, criadaEm }, depois(PRAZO_SEM_CONFIRMACAO_DE_LIGACAO_MS * 10), soNoFim)).toBe(false);
    }
  });
});
