import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Relatório de violação da CSP: rota PÚBLICA e anônima. Só escreve no log campos saneados, limita por IP
 * e por tamanho, e NUNCA responde 5xx (o navegador não tem o que fazer com erro).
 */
const aviso = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ allowed: true, remaining: 59, retryAfterMs: 0 })));
vi.mock("@crmagro/core", () => ({ logger: { warn: aviso }, rateLimit }));

const { POST } = await import("./route");

const legado = (campos: Record<string, unknown> = {}) => ({
  "csp-report": {
    "document-uri": "https://app.crmagro.example/contatos?busca=maria",
    "effective-directive": "img-src",
    "blocked-uri": "https://cdn.exemplo.com/foto.png?token=SEGREDO",
    disposition: "report",
    ...campos,
  },
});

let n = 0;
/** Cada teste usa uma página diferente, para o descarte de repetidos não esconder o log. */
const unico = () => ({ "document-uri": `https://app.crmagro.example/pagina-${++n}` });

function pedir(corpo: unknown, tipo = "application/csp-report", extra: Record<string, string> = {}) {
  return POST(
    new Request("http://x/api/csp-report", {
      method: "POST",
      headers: { "content-type": tipo, "x-forwarded-for": "203.0.113.7", ...extra },
      body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    }),
  );
}

beforeEach(() => {
  aviso.mockClear();
  rateLimit.mockClear();
  rateLimit.mockResolvedValue({ allowed: true, remaining: 59, retryAfterMs: 0 });
});

describe("POST /api/csp-report", () => {
  it("formato antigo (application/csp-report): 204 e uma linha de log saneada", async () => {
    const r = await pedir(legado(unico()));
    expect(r.status).toBe(204);
    expect(aviso).toHaveBeenCalledTimes(1);
    const [campos, mensagem] = aviso.mock.calls[0]!;
    expect(mensagem).toBe("csp-violacao");
    expect(campos).toMatchObject({ diretiva: "img-src", bloqueado: "https://cdn.exemplo.com", disposicao: "report" });
    expect(JSON.stringify(campos)).not.toMatch(/SEGREDO|maria|\?/);
  });

  it("formato novo (application/reports+json)", async () => {
    const r = await pedir(
      [{ type: "csp-violation", url: "https://app.crmagro.example/mapa", body: { effectiveDirective: "connect-src", blockedURL: "https://tiles.exemplo.com/x.pbf", disposition: "report" } }],
      "application/reports+json",
    );
    expect(r.status).toBe(204);
    expect(aviso.mock.calls[0]![0]).toMatchObject({ diretiva: "connect-src", bloqueado: "https://tiles.exemplo.com", pagina: "/mapa" });
  });

  it("aceita content-type com charset", async () => {
    expect((await pedir(legado(unico()), "application/csp-report; charset=utf-8")).status).toBe(204);
    expect(aviso).toHaveBeenCalledTimes(1);
  });

  it("content-type de formulário ou texto: 415 e nada no log", async () => {
    for (const tipo of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      expect((await pedir(legado(unico()), tipo)).status, tipo).toBe(415);
    }
    expect(aviso).not.toHaveBeenCalled();
  });

  it("corpo acima de 8 KB: 413 (pelo content-length e pelo corpo real) e nada no log", async () => {
    const grande = JSON.stringify(legado({ ...unico(), "blocked-uri": "https://x.com/" + "a".repeat(9000) }));
    expect((await pedir(grande, "application/csp-report", { "content-length": String(grande.length) })).status).toBe(413);
    // Sem content-length confiável: o limite vale na leitura do corpo.
    const r = await POST(new Request("http://x/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body: grande }));
    expect(r.status).toBe(413);
    expect(aviso).not.toHaveBeenCalled();
  });

  it("limite por IP estourado: 429 com Retry-After e nada no log", async () => {
    rateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 30_000 });
    const r = await pedir(legado(unico()));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(aviso).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith("csp-report:203.0.113.7", 60, 60_000);
  });

  it("sem IP no cabeçalho, o limite vale para o balde 'sem-ip'", async () => {
    await POST(new Request("http://x/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify(legado(unico())) }));
    expect(rateLimit).toHaveBeenCalledWith("csp-report:sem-ip", 60, 60_000);
  });

  it("JSON inválido, vazio ou sem relatório: 204 e nada no log", async () => {
    for (const corpo of ["{não é json", "", "null", "[]", "{}", '"texto"']) {
      expect((await pedir(corpo)).status, corpo).toBe(204);
    }
    expect(aviso).not.toHaveBeenCalled();
  });

  it("ruído de extensão do navegador não vai para o log", async () => {
    const r = await pedir(legado({ ...unico(), "blocked-uri": "chrome-extension://abc/x.js", "effective-directive": "script-src-elem" }));
    expect(r.status).toBe(204);
    expect(aviso).not.toHaveBeenCalled();
  });

  it("a mesma violação repetida em 1 minuto entra no log uma vez só", async () => {
    const corpo = legado(unico());
    await pedir(corpo);
    await pedir(corpo);
    await pedir(corpo);
    expect(aviso).toHaveBeenCalledTimes(1);
    // Outra página ou outra diretiva é outra violação.
    await pedir(legado(unico()));
    expect(aviso).toHaveBeenCalledTimes(2);
  });

  it("nunca responde 5xx: falha no limitador ou no log vira 204", async () => {
    rateLimit.mockRejectedValueOnce(new Error("redis caiu"));
    expect((await pedir(legado(unico()))).status).toBe(204);
    aviso.mockImplementationOnce(() => {
      throw new Error("log quebrou");
    });
    expect((await pedir(legado(unico()))).status).toBe(204);
  });

  it("a resposta não leva corpo nem eco do que foi enviado", async () => {
    const r = await pedir(legado(unico()));
    expect(await r.text()).toBe("");
  });
});
