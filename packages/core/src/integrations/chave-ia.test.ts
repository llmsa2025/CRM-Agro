import { describe, expect, it, vi } from "vitest";
import { conferirFormatoDaChave, diagnosticarChaveDeIa, motivoDoStatus } from "./chave-ia";

const resposta = (status: number) => ({ status, ok: status >= 200 && status < 300 }) as Response;
const CHAVE = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-bAAA";

describe("formato da chave (sem rede)", () => {
  it("chave da Anthropic começa com sk-ant-; token do Claude Code (oat) é outro caso", () => {
    expect(conferirFormatoDaChave("anthropic", CHAVE)).toBeNull();
    expect(conferirFormatoDaChave("anthropic", "sk-ant-oat01-xxxxxxxxxxxx")).toBe("token_oauth");
    expect(conferirFormatoDaChave("anthropic", "sk-proj-xxxxxxxxxxxx")).toBe("formato");
    expect(conferirFormatoDaChave("anthropic", "qualquercoisa123")).toBe("formato");
  });
  it("OpenAI começa com sk-; GLM não exige prefixo", () => {
    expect(conferirFormatoDaChave("openai", "sk-proj-abcdefghij")).toBeNull();
    expect(conferirFormatoDaChave("openai", "abcdefghij")).toBe("formato");
    expect(conferirFormatoDaChave("glm", "abcdefghij.klmnop")).toBeNull();
  });
  it("espaço ou quebra de linha no meio da chave", () => {
    expect(conferirFormatoDaChave("anthropic", `${CHAVE} ${CHAVE}`)).toBe("espaco");
    expect(conferirFormatoDaChave("anthropic", `${CHAVE}\nresto`)).toBe("espaco");
    expect(conferirFormatoDaChave("glm", "abc def")).toBe("espaco");
  });
});

describe("status do provedor → motivo", () => {
  it("2xx ok; 401 recusada; 403 sem acesso; 429 limite; 5xx indisponível; o resto, recusada", () => {
    expect(motivoDoStatus(200)).toBe("ok");
    expect(motivoDoStatus(204)).toBe("ok");
    expect(motivoDoStatus(401)).toBe("recusada");
    expect(motivoDoStatus(403)).toBe("sem_acesso");
    expect(motivoDoStatus(429)).toBe("limite");
    expect(motivoDoStatus(500)).toBe("indisponivel");
    expect(motivoDoStatus(503)).toBe("indisponivel");
    expect(motivoDoStatus(404)).toBe("recusada");
  });
});

describe("diagnóstico da chave (provedor simulado)", () => {
  it("chave boa: ok, e chama a listagem de modelos da Anthropic com os cabeçalhos certos", async () => {
    const chamar = vi.fn(async () => resposta(200));
    expect(await diagnosticarChaveDeIa("anthropic", CHAVE, chamar as unknown as typeof fetch)).toEqual({ ok: true, motivo: "ok" });
    expect(chamar).toHaveBeenCalledTimes(1);
    const [url, init] = chamar.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(init.headers).toEqual({ "x-api-key": CHAVE, "anthropic-version": "2023-06-01" });
  });

  it("OpenAI usa Bearer; GLM usa o endpoint da z.ai", async () => {
    const chamar = vi.fn(async () => resposta(200));
    await diagnosticarChaveDeIa("openai", "sk-proj-abcdefghij", chamar as unknown as typeof fetch);
    await diagnosticarChaveDeIa("glm", "abcdefghij.klmnop", chamar as unknown as typeof fetch);
    const [u1, i1] = chamar.mock.calls[0] as unknown as [string, RequestInit];
    const [u2] = chamar.mock.calls[1] as unknown as [string, RequestInit];
    expect(u1).toBe("https://api.openai.com/v1/models");
    expect(i1.headers).toEqual({ Authorization: "Bearer sk-proj-abcdefghij" });
    expect(u2).toBe("https://api.z.ai/api/anthropic/v1/models");
  });

  it("401, 403, 429 e 500 viram o motivo certo", async () => {
    for (const [status, motivo] of [[401, "recusada"], [403, "sem_acesso"], [429, "limite"], [500, "indisponivel"]] as const) {
      const chamar = vi.fn(async () => resposta(status));
      expect(await diagnosticarChaveDeIa("anthropic", CHAVE, chamar as unknown as typeof fetch)).toEqual({ ok: false, motivo });
    }
  });

  it("sem resposta (rede, DNS, tempo esgotado) vira 'rede'", async () => {
    const chamar = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await diagnosticarChaveDeIa("anthropic", CHAVE, chamar as unknown as typeof fetch)).toEqual({ ok: false, motivo: "rede" });
  });

  it("espaço no meio e token do Claude Code nem chamam o provedor", async () => {
    const chamar = vi.fn(async () => resposta(200));
    expect(await diagnosticarChaveDeIa("anthropic", "sk-ant-oat01-xxxxxxxxxxxx", chamar as unknown as typeof fetch)).toEqual({ ok: false, motivo: "token_oauth" });
    expect(await diagnosticarChaveDeIa("anthropic", `${CHAVE} ${CHAVE}`, chamar as unknown as typeof fetch)).toEqual({ ok: false, motivo: "espaco" });
    expect(chamar).not.toHaveBeenCalled();
  });

  it("prefixo diferente do usual ainda é testado: o 401 vira 'formato' (explica melhor), um 200 vale", async () => {
    const recusa = vi.fn(async () => resposta(401));
    expect(await diagnosticarChaveDeIa("anthropic", "lixo-lixo-lixo", recusa as unknown as typeof fetch)).toEqual({ ok: false, motivo: "formato" });
    expect(recusa).toHaveBeenCalledTimes(1);
    const aceita = vi.fn(async () => resposta(200));
    expect(await diagnosticarChaveDeIa("anthropic", "chave-de-gateway-123", aceita as unknown as typeof fetch)).toEqual({ ok: true, motivo: "ok" });
    // Outros motivos não são trocados: rede fora do ar continua sendo rede.
    const queda = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await diagnosticarChaveDeIa("anthropic", "lixo-lixo-lixo", queda as unknown as typeof fetch)).toEqual({ ok: false, motivo: "rede" });
  });
});
