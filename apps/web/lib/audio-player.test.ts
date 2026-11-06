import { describe, expect, it } from "vitest";
import {
  VELOCIDADES,
  deveAdotarNovaUrl,
  duracaoConhecida,
  falhaDoMediaError,
  falhaDoPlay,
  fmtDur,
  formatoTocavel,
  mensagemDaFalha,
  percentual,
  proximaVelocidade,
  rotuloDuracao,
  rotuloVelocidade,
  velocidadeSalva,
} from "./audio-player";

describe("fmtDur", () => {
  it("formata minutos e segundos", () => {
    expect(fmtDur(0)).toBe("0:00");
    expect(fmtDur(7.9)).toBe("0:07");
    expect(fmtDur(70)).toBe("1:10");
    expect(fmtDur(599.99)).toBe("9:59");
  });
  it("de 1 hora em diante mostra as horas", () => {
    expect(fmtDur(3600)).toBe("1:00:00");
    expect(fmtDur(3723)).toBe("1:02:03");
  });
  it("valor inválido vira 0:00 (NaN, Infinity, negativo)", () => {
    expect(fmtDur(NaN)).toBe("0:00");
    expect(fmtDur(Infinity)).toBe("0:00");
    expect(fmtDur(-3)).toBe("0:00");
  });
});

describe("duração desconhecida", () => {
  it("só número finito e positivo conta como conhecido", () => {
    expect(duracaoConhecida(70)).toBe(true);
    expect(duracaoConhecida(0)).toBe(false);
    expect(duracaoConhecida(NaN)).toBe(false);
    expect(duracaoConhecida(Infinity)).toBe(false);
  });
  it("o rótulo do total usa --:-- enquanto não se sabe (não 0:00)", () => {
    expect(rotuloDuracao(70)).toBe("1:10");
    expect(rotuloDuracao(0)).toBe("--:--");
    expect(rotuloDuracao(Infinity)).toBe("--:--");
  });
  it("percentual da barra é 0 sem duração e nunca passa de 100", () => {
    expect(percentual(10, 0)).toBe(0);
    expect(percentual(10, Infinity)).toBe(0);
    expect(percentual(-1, 70)).toBe(0);
    expect(percentual(35, 70)).toBe(50);
    expect(percentual(80, 70)).toBe(100);
  });
});

describe("falhaDoMediaError", () => {
  it("código 1 (abortado por nós) não é falha", () => {
    expect(falhaDoMediaError(1, true)).toBeNull();
  });
  it("rede e decodificação têm frase própria", () => {
    expect(falhaDoMediaError(2, true)).toBe("rede");
    expect(falhaDoMediaError(3, true)).toBe("decodificacao");
  });
  it("código 4 separa formato não suportado de link que não respondeu", () => {
    expect(falhaDoMediaError(4, false)).toBe("formato");
    expect(falhaDoMediaError(4, true)).toBe("origem");
  });
  it("sem código conhecido cai na frase genérica", () => {
    expect(falhaDoMediaError(undefined, true)).toBe("generica");
    expect(falhaDoMediaError(null, true)).toBe("generica");
    expect(falhaDoMediaError(99, true)).toBe("generica");
  });
});

describe("falhaDoPlay", () => {
  it("AbortError (pause/nova carga no meio do play) é ignorado", () => {
    expect(falhaDoPlay("AbortError", undefined, true)).toBeNull();
  });
  it("NotSupportedError = sem fonte reproduzível", () => {
    expect(falhaDoPlay("NotSupportedError", undefined, false)).toBe("formato");
    expect(falhaDoPlay("NotSupportedError", undefined, true)).toBe("origem");
  });
  it("outro erro usa o código do MediaError, se houver", () => {
    expect(falhaDoPlay("Error", 2, true)).toBe("rede");
    expect(falhaDoPlay("NotAllowedError", undefined, true)).toBe("generica");
  });
});

describe("mensagemDaFalha", () => {
  it("toda falha tem frase em português e a de formato cita o OGG/Opus", () => {
    for (const f of ["rede", "decodificacao", "formato", "origem", "generica"] as const) {
      expect(mensagemDaFalha(f).length).toBeGreaterThan(10);
    }
    expect(mensagemDaFalha("formato")).toContain("OGG/Opus");
  });
});

describe("formatoTocavel", () => {
  const chrome = (t: string) => (t.startsWith("audio/ogg") ? "probably" : "");
  const safari = () => "";
  it("sem tipo informado assume que toca (nunca bloqueia por dúvida)", () => {
    expect(formatoTocavel(null, safari)).toBe(true);
    expect(formatoTocavel(undefined, safari)).toBe(true);
    expect(formatoTocavel("  ", safari)).toBe(true);
  });
  it("navegador que conhece o tipo", () => {
    expect(formatoTocavel("audio/ogg; codecs=opus", chrome)).toBe(true);
  });
  it("navegador que só conhece o contêiner (sem o codec)", () => {
    const soContainer = (t: string) => (t === "audio/ogg" ? "maybe" : "");
    expect(formatoTocavel("audio/ogg; codecs=opus", soContainer)).toBe(true);
  });
  it("navegador que não toca o formato (ex.: Safari com OGG/Opus)", () => {
    expect(formatoTocavel("audio/ogg; codecs=opus", safari)).toBe(false);
    expect(formatoTocavel("audio/ogg", safari)).toBe(false);
  });
});

describe("deveAdotarNovaUrl", () => {
  const base = { atual: "https://s/a?token=1", nova: "https://s/a?token=2", tocando: false, posicao: 0, comFalha: false };
  it("mesma URL ou URL vazia: nada a fazer", () => {
    expect(deveAdotarNovaUrl({ ...base, nova: base.atual })).toBe(false);
    expect(deveAdotarNovaUrl({ ...base, nova: "" })).toBe(false);
  });
  it("áudio parado no início troca sem custo", () => {
    expect(deveAdotarNovaUrl(base)).toBe(true);
  });
  it("tocando NÃO troca (recarregar zeraria a reprodução)", () => {
    expect(deveAdotarNovaUrl({ ...base, tocando: true, posicao: 12 })).toBe(false);
  });
  it("pausado no meio NÃO troca (perderia a posição)", () => {
    expect(deveAdotarNovaUrl({ ...base, tocando: false, posicao: 12 })).toBe(false);
  });
  it("com falha troca sempre (a URL atual provavelmente venceu)", () => {
    expect(deveAdotarNovaUrl({ ...base, tocando: true, posicao: 12, comFalha: true })).toBe(true);
  });
});

describe("velocidade do áudio", () => {
  it("as opções são 1x, 1,5x e 2x", () => {
    expect([...VELOCIDADES]).toEqual([1, 1.5, 2]);
  });
  it("o botão gira 1x → 1,5x → 2x → 1x", () => {
    expect(proximaVelocidade(1)).toBe(1.5);
    expect(proximaVelocidade(1.5)).toBe(2);
    expect(proximaVelocidade(2)).toBe(1);
  });
  it("valor fora da lista volta ao normal e segue o giro", () => {
    expect(proximaVelocidade(3)).toBe(1);
    expect(proximaVelocidade(NaN)).toBe(1);
  });
  it("lê a velocidade guardada (texto com ponto ou vírgula) e ignora lixo", () => {
    expect(velocidadeSalva("1.5")).toBe(1.5);
    expect(velocidadeSalva("1,5")).toBe(1.5);
    expect(velocidadeSalva("2")).toBe(2);
    expect(velocidadeSalva("0.5")).toBe(1);
    expect(velocidadeSalva(null)).toBe(1);
    expect(velocidadeSalva("abc")).toBe(1);
  });
  it("rótulo em português", () => {
    expect(rotuloVelocidade(1)).toBe("1x");
    expect(rotuloVelocidade(1.5)).toBe("1,5x");
    expect(rotuloVelocidade(2)).toBe("2x");
  });
});
