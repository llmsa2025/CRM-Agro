import { describe, it, expect, vi } from "vitest";
import { safeFetch, ipBloqueado, resolverPublico, SafeFetchBlocked, type Transporte, type Resolver } from "./safe-fetch";

/**
 * SSRF (auditoria S6/S13 — item 0.7). Sem rede: o DNS e o transporte são
 * injetados, então dá para provar a regra (inclusive redirect para IP interno)
 * sem depender de host externo no CI.
 */

const PUBLICO = "93.184.216.34";
const resolverFalso: Resolver = async (host) => {
  const mapa: Record<string, string[]> = {
    "ok.exemplo.com": [PUBLICO],
    "interno.exemplo.com": ["10.0.0.5"],
    "misto.exemplo.com": [PUBLICO, "127.0.0.1"], // uma resposta ruim já basta
    "v6.exemplo.com": ["::1"],
  };
  return (mapa[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
};
const ok200: Transporte = async () => ({ status: 200, ok: true, headers: {}, body: Buffer.from("ok") });

describe("ipBloqueado", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
  ])("%s é bloqueado", (ip) => expect(ipBloqueado(ip)).toBe(true));

  it.each([PUBLICO, "8.8.8.8", "2606:4700:4700::1111"])("%s é público", (ip) => expect(ipBloqueado(ip)).toBe(false));
});

describe("safeFetch", () => {
  it.each([
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://localhost:8081/",
    "https://interno.exemplo.com/",
    "https://misto.exemplo.com/",
    "https://v6.exemplo.com/",
    "http://ok.exemplo.com/",
    "ftp://ok.exemplo.com/",
    "https://user:senha@ok.exemplo.com/",
    "não é url",
  ])("bloqueia %s", async (url) => {
    const transporte = vi.fn(ok200);
    await expect(safeFetch(url, {}, { resolver: resolverFalso, transporte })).rejects.toBeInstanceOf(SafeFetchBlocked);
    expect(transporte).not.toHaveBeenCalled();
  });

  it("permite https público e FIXA o IP validado na conexão", async () => {
    const transporte = vi.fn(ok200);
    const r = await safeFetch("https://ok.exemplo.com/x", { method: "POST", body: "{}" }, { resolver: resolverFalso, transporte });
    expect(r.ok).toBe(true);
    expect(transporte).toHaveBeenCalledTimes(1);
    expect(transporte.mock.calls[0]![1]).toEqual({ address: PUBLICO, family: 4 });
  });

  it("http só com allowHttp explícito", async () => {
    const transporte = vi.fn(ok200);
    await expect(
      safeFetch("http://ok.exemplo.com/", { allowHttp: true }, { resolver: resolverFalso, transporte }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("redirect para IP interno é bloqueado (cada salto é revalidado)", async () => {
    const transporte: Transporte = vi.fn(async (url) =>
      url.hostname === "ok.exemplo.com"
        ? { status: 302, ok: false, headers: { location: "http://169.254.169.254/latest/meta-data/" }, body: Buffer.alloc(0) }
        : { status: 200, ok: true, headers: {}, body: Buffer.from("segredo") },
    );
    await expect(
      safeFetch("https://ok.exemplo.com/", { allowHttp: true }, { resolver: resolverFalso, transporte }),
    ).rejects.toBeInstanceOf(SafeFetchBlocked);
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it("redirects demais são recusados; 303 vira GET sem corpo", async () => {
    const sempreRedireciona: Transporte = vi.fn(async () => ({
      status: 302,
      ok: false,
      headers: { location: "https://ok.exemplo.com/de-novo" },
      body: Buffer.alloc(0),
    }));
    await expect(
      safeFetch("https://ok.exemplo.com/", {}, { resolver: resolverFalso, transporte: sempreRedireciona }),
    ).rejects.toThrow(/redirecionamentos demais/);

    let n = 0;
    const umSee: Transporte = vi.fn(async () =>
      n++ === 0
        ? { status: 303, ok: false, headers: { location: "/fim" }, body: Buffer.alloc(0) }
        : { status: 200, ok: true, headers: {}, body: Buffer.alloc(0) },
    );
    await safeFetch("https://ok.exemplo.com/", { method: "POST", body: "x" }, { resolver: resolverFalso, transporte: umSee });
    const segunda = (umSee as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(segunda[0].toString()).toBe("https://ok.exemplo.com/fim");
    expect(segunda[2]).toMatchObject({ method: "GET", body: undefined });
  });

  it("resolverPublico recusa host sem endereço e nomes internos", async () => {
    await expect(resolverPublico("sumiu.exemplo.com", resolverFalso)).rejects.toBeInstanceOf(SafeFetchBlocked);
    await expect(resolverPublico("db.internal", resolverFalso)).rejects.toBeInstanceOf(SafeFetchBlocked);
  });
});
