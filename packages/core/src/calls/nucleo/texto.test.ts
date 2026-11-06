import { describe, expect, it } from "vitest";
import { CAUSAS_DE_LIGACAO } from "../provedor/fato";
import { fimDoWebhook, matrizGarantida, webhook } from "./apoio-de-teste";
import { calcularDesfechoDeLigacao, type ResultadoDeLigacao } from "./desfecho";
import { duracaoCurtaDaLigacao, textoDaLigacao, type DesfechoParaTextoDaLigacao } from "./texto";

const desfecho = (outcome: ResultadoDeLigacao | null, extra: Partial<DesfechoParaTextoDaLigacao> = {}): DesfechoParaTextoDaLigacao => ({
  status: "completed",
  outcome,
  motivo: null,
  duracaoConectadaS: null,
  ...extra,
});

describe("duracaoCurtaDaLigacao", () => {
  it("segundos até 59, depois minutos com segundos de dois dígitos", () => {
    expect(duracaoCurtaDaLigacao(0)).toBe("0 s");
    expect(duracaoCurtaDaLigacao(45)).toBe("45 s");
    expect(duracaoCurtaDaLigacao(59)).toBe("59 s");
    expect(duracaoCurtaDaLigacao(60)).toBe("1 min 00 s");
    expect(duracaoCurtaDaLigacao(65)).toBe("1 min 05 s");
    expect(duracaoCurtaDaLigacao(754)).toBe("12 min 34 s");
  });
});

describe("textoDaLigacao", () => {
  it("telefone é o padrão e não cita o canal", () => {
    expect(textoDaLigacao(desfecho("answered", { duracaoConectadaS: 65 }))).toBe("Ligação atendida (1 min 05 s)");
    expect(textoDaLigacao(desfecho("answered"))).toBe("Ligação atendida");
    expect(textoDaLigacao(desfecho("rejected", { status: "no_answer" }))).toBe("Ligação recusada pelo contato");
    expect(textoDaLigacao(desfecho("no_answer", { status: "no_answer" }))).toBe("Ligação não atendida");
    expect(textoDaLigacao(desfecho("busy", { status: "busy" }))).toBe("Ligação com linha ocupada");
    expect(textoDaLigacao(desfecho("voicemail", { status: "no_answer" }))).toBe("Ligação caiu na caixa postal");
    expect(textoDaLigacao(desfecho("wrong_number", { status: "failed" }))).toBe("Número inexistente, a ligação não saiu");
  });

  it("pelo WhatsApp, a frase diz o canal", () => {
    expect(textoDaLigacao(desfecho("answered", { duracaoConectadaS: 45 }), "whatsapp")).toBe("Ligação pelo WhatsApp atendida (45 s)");
    expect(textoDaLigacao(desfecho("rejected", { status: "no_answer" }), "whatsapp")).toBe("Ligação recusada pelo contato no WhatsApp");
    expect(textoDaLigacao(desfecho("no_answer", { status: "no_answer" }), "whatsapp")).toBe("Ligação pelo WhatsApp não atendida");
    expect(textoDaLigacao(desfecho("wrong_number", { status: "failed" }), "whatsapp")).toBe("Número inexistente, a ligação pelo WhatsApp não saiu");
  });

  it("sem resultado, a frase leva o motivo", () => {
    expect(textoDaLigacao(desfecho(null, { status: "failed", motivo: "A ligação não completou por falha de rede." }))).toBe(
      "Ligação não completou. A ligação não completou por falha de rede.",
    );
    expect(textoDaLigacao(desfecho(null, { status: "no_answer", motivo: "O provedor não confirmou o motivo." }), "whatsapp")).toBe(
      "Ligação pelo WhatsApp sem resposta. O provedor não confirmou o motivo.",
    );
    expect(textoDaLigacao(desfecho(null, { status: "completed", motivo: "O provedor não confirmou o fim da ligação." }))).toBe(
      "Ligação terminou. O provedor não confirmou o fim da ligação.",
    );
    expect(textoDaLigacao(desfecho(null, { status: "failed" }))).toBe("Ligação não completou");
  });

  it("sem desfecho (a ligação acabou de começar): iniciada", () => {
    expect(textoDaLigacao(null)).toBe("Ligação iniciada");
    expect(textoDaLigacao(null, "whatsapp")).toBe("Ligação pelo WhatsApp iniciada");
  });

  it("todo texto possível segue a §15: sem travessão, meia-risca nem hífen como separador, sem exclamação", () => {
    const textos: string[] = [];
    for (const via of ["telefone", "whatsapp"] as const) {
      for (const causa of CAUSAS_DE_LIGACAO) {
        for (const tocou of [true, false]) {
          const entradas = [...(tocou ? [webhook("c", 0, "chamando")] : []), fimDoWebhook("f", 30, causa, { duracaoConectadaS: 65 })];
          for (const garantida of [true, false]) {
            const d = calcularDesfechoDeLigacao(entradas, matrizGarantida({ causaDoFimGarantida: garantida }))!;
            textos.push(textoDaLigacao(d, via));
          }
        }
      }
      textos.push(textoDaLigacao(null, via));
    }
    expect(textos.length).toBeGreaterThan(40);
    for (const t of textos) {
      expect(t, t).not.toMatch(/[—–]| - |!/);
      expect(t.length, t).toBeGreaterThan(5);
      expect(t, t).not.toMatch(/\s{2,}/);
    }
  });
});
