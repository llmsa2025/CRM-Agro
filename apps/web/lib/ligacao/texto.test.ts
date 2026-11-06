import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FASES_DA_LIGACAO } from "./estado";
import { CODIGOS_DO_MOTOR, MOTIVOS_LOCAIS_DO_FIM } from "./motor";
import {
  codigoDoErroDeMicrofone,
  formatarDuracao,
  mensagemDoCodigoDoMotor,
  mensagemDoMicrofone,
  rotuloDaFase,
  rotuloDoMotivoLocal,
  rotuloDoResultado,
  segundosDesde,
} from "./texto";

const TRAVESSAO = String.fromCharCode(0x2014);
const MEIA_RISCA = String.fromCharCode(0x2013);

/** Nenhum travessão, meia-risca nem " - " como separador (AGENTS.md (texto da interface)), e nada de exclamação. */
function limpo(texto: string) {
  expect(texto).not.toContain(TRAVESSAO);
  expect(texto).not.toContain(MEIA_RISCA);
  expect(texto).not.toMatch(/\s-\s/);
  expect(texto).not.toContain("!");
  expect(texto.trim()).toBe(texto);
  expect(texto.length).toBeGreaterThan(0);
}

describe("formatarDuracao", () => {
  it("mm:ss, e h:mm:ss a partir de 1 hora", () => {
    expect(formatarDuracao(0)).toBe("00:00");
    expect(formatarDuracao(5)).toBe("00:05");
    expect(formatarDuracao(59)).toBe("00:59");
    expect(formatarDuracao(60)).toBe("01:00");
    expect(formatarDuracao(192)).toBe("03:12");
    expect(formatarDuracao(3599)).toBe("59:59");
    expect(formatarDuracao(3600)).toBe("1:00:00");
    expect(formatarDuracao(3725)).toBe("1:02:05");
  });

  it("arredonda para baixo e não aceita valor ruim", () => {
    expect(formatarDuracao(61.9)).toBe("01:01");
    expect(formatarDuracao(-5)).toBe("00:00");
    expect(formatarDuracao(Number.NaN)).toBe("00:00");
    expect(formatarDuracao(Number.POSITIVE_INFINITY)).toBe("00:00");
  });
});

describe("segundosDesde", () => {
  it("conta em segundos inteiros, nunca negativos", () => {
    expect(segundosDesde(1_000, 4_999)).toBe(3);
    expect(segundosDesde(5_000, 1_000)).toBe(0);
  });

  it("instante nulo ou ruim dá zero", () => {
    expect(segundosDesde(null, 1_000)).toBe(0);
    expect(segundosDesde(Number.NaN, 1_000)).toBe(0);
    expect(segundosDesde(1_000, Number.NaN)).toBe(0);
  });
});

describe("mensagemDoMicrofone e codigoDoErroDeMicrofone", () => {
  const casos: [string, string, string][] = [
    ["NotAllowedError", "O navegador bloqueou o microfone", "microfone_negado"],
    ["SecurityError", "O navegador bloqueou o microfone", "microfone_negado"],
    ["NotFoundError", "Não achei um microfone", "sem_microfone"],
    ["OverconstrainedError", "Não achei um microfone", "sem_microfone"],
    ["NotReadableError", "em uso por outro programa", "sem_microfone"],
    ["AbortError", "Não deu para abrir o microfone", "sem_audio"],
  ];

  it.each(casos)("%s", (nome, trecho, codigo) => {
    expect(mensagemDoMicrofone({ name: nome })).toContain(trecho);
    expect(codigoDoErroDeMicrofone({ name: nome })).toBe(codigo);
  });

  it("aceita um DOMException de verdade", () => {
    expect(mensagemDoMicrofone(new DOMException("x", "NotAllowedError"))).toContain("bloqueou o microfone");
    expect(codigoDoErroDeMicrofone(new DOMException("x", "NotFoundError"))).toBe("sem_microfone");
  });

  it("não repassa o texto do erro e aceita qualquer coisa", () => {
    for (const ruim of [null, undefined, "NotAllowedError", 42, {}, new Error("Falha em +5511999990000")]) {
      expect(mensagemDoMicrofone(ruim)).toBe("Não deu para abrir o microfone.");
      expect(codigoDoErroDeMicrofone(ruim)).toBe("sem_audio");
    }
  });
});

describe("os textos da ligação seguem a §15", () => {
  it("todo código de falha do motor tem frase, e o servidor sem resposta também", () => {
    for (const codigo of [...CODIGOS_DO_MOTOR, "sem_resposta" as const]) limpo(mensagemDoCodigoDoMotor(codigo));
  });

  it("toda fase tem rótulo", () => {
    for (const fase of FASES_DA_LIGACAO) limpo(rotuloDaFase(fase));
    expect(rotuloDaFase("chamando")).toBe("Chamando");
    expect(rotuloDaFase("em_conversa")).toBe("Em ligação");
    expect(rotuloDaFase("encerrada")).toBe("Ligação encerrada");
  });

  it("todo motivo local tem rótulo", () => {
    for (const motivo of MOTIVOS_LOCAIS_DO_FIM) limpo(rotuloDoMotivoLocal(motivo));
    expect(rotuloDoMotivoLocal("desligou")).toBe("Você desligou");
  });

  it("o resultado confirmado vira palavra; o que a tela não conhece vira Sem resultado", () => {
    const conhecidos: [string, string][] = [
      ["answered", "Atendida"],
      ["no_answer", "Não atendeu"],
      ["busy", "Ocupado"],
      ["voicemail", "Caixa postal"],
      ["wrong_number", "Número errado"],
      ["rejected", "Recusada"],
    ];
    for (const [chave, rotulo] of conhecidos) {
      expect(rotuloDoResultado(chave)).toBe(rotulo);
      limpo(rotulo);
    }
    for (const desconhecido of [null, "", "algo_novo", "__proto__", "constructor", "toString"]) expect(rotuloDoResultado(desconhecido)).toBe("Sem resultado");
  });

  it("os rótulos de resultado que a barra e o Histórico dividem não se afastam", () => {
    // `lib/ligacao` não pode importar valor do core (arrastaria bullmq para o navegador), então o rótulo é
    // duplicado de propósito. Este teste lê o texto do core e não deixa a cópia ficar para trás.
    const fonte = readFileSync(join(__dirname, "../../../../packages/core/src/calls/schema.ts"), "utf8");
    const bloco = /export const ROTULO_RESULTADO[^=]*=\s*\{([\s\S]*?)\};/.exec(fonte)?.[1] ?? "";
    const doCore = new Map<string, string>();
    for (const m of bloco.matchAll(/(\w+):\s*"([^"]+)"/g)) doCore.set(m[1] ?? "", m[2] ?? "");
    expect(doCore.get("no_answer")).toBe("Não atendeu");

    // `answered` é a exceção: a barra mostra "Atendida, 3:12" (F3-03), o Histórico "Atendeu". `skip` só existe
    // no discador. `rejected` ainda não está no core (F1B-06); quando entrar, o rótulo precisa ser o mesmo.
    const excecoes = new Set(["answered", "skip"]);
    for (const [chave, rotulo] of doCore) {
      if (excecoes.has(chave)) continue;
      expect(rotuloDoResultado(chave), chave).toBe(rotulo);
    }
  });

  it("as mensagens do microfone também", () => {
    for (const nome of ["NotAllowedError", "NotFoundError", "NotReadableError", "Outro"]) limpo(mensagemDoMicrofone({ name: nome }));
  });

  it("fala do CRM Agro no masculino", () => {
    for (const codigo of [...CODIGOS_DO_MOTOR, "sem_resposta" as const]) expect(mensagemDoCodigoDoMotor(codigo)).not.toMatch(/\ba CRM Agro\b/);
  });
});
