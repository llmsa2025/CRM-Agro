import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { env } from "@crmagro/config";
import { runWithTeam } from "../test-support/identidade";
import { redisCache } from "../shared/redis-cache";
import { signedMediaUrl, signedMediaUrls } from "./service";

/**
 * Mídia assinada em LOTE + cache Redis (item 2.2, DP-02). O Storage é um fetch
 * falso: nenhum request sai de verdade.
 */
const TEAM = "00000000-0000-0000-0000-0000000002a5";
const OUTRO = "00000000-0000-0000-0000-0000000002a6";
const URL_FALSA = "https://storage.teste.invalid";
const sufixo = Math.random().toString(36).slice(2, 8);
const p = (n: number) => `conv-${sufixo}/in-${n}.jpg`;

const originais = { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY };
const chamadas: { url: string; body: { paths?: string[]; expiresIn?: number } }[] = [];
let loteQuebrado = false;

const fetchFalso = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const body = JSON.parse(String(init?.body ?? "{}")) as { paths?: string[]; expiresIn?: number };
  chamadas.push({ url: u, body });
  const resposta = (dados: unknown, status = 200) =>
    new Response(JSON.stringify(dados), { status, headers: { "Content-Type": "application/json" } });
  if (u.endsWith("/storage/v1/object/sign/conversas-midia")) {
    if (loteQuebrado) return resposta({ error: "boom" }, 500);
    return resposta(
      (body.paths ?? []).map((path) =>
        path.includes("sumiu")
          ? { path, signedURL: null, error: "Object not found" }
          : { path, signedURL: `/object/sign/conversas-midia/${path}?token=lote`, error: null },
      ),
    );
  }
  const path = decodeURI(u.split("/storage/v1/object/sign/conversas-midia/")[1] ?? "");
  return resposta({ signedURL: `/object/sign/conversas-midia/${path}?token=um` });
});

beforeAll(async () => {
  Object.assign(env, { SUPABASE_URL: URL_FALSA, SUPABASE_SERVICE_ROLE_KEY: "chave-falsa" });
  vi.stubGlobal("fetch", fetchFalso);
  const r = redisCache();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  Object.assign(env, { SUPABASE_URL: originais.url, SUPABASE_SERVICE_ROLE_KEY: originais.key });
  const chaves = await redisCache().keys(`midia:url:*:conv-${sufixo}/*`);
  if (chaves.length) await redisCache().del(...chaves);
});

beforeEach(() => {
  chamadas.length = 0;
  loteQuebrado = false;
});

describe("signedMediaUrls — lote e cache", () => {
  it("assina várias mídias num request só e guarda no cache do time", async () => {
    const urls = await runWithTeam(TEAM, () => signedMediaUrls([p(1), p(2), p(1), p(3)]));
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.body).toEqual({ expiresIn: 3600, paths: [p(1), p(2), p(3)] });
    expect(urls.get(p(2))).toBe(`${URL_FALSA}/storage/v1/object/sign/conversas-midia/${p(2)}?token=lote`);

    // Segunda leitura: tudo do cache, nenhum request.
    const denovo = await runWithTeam(TEAM, () => signedMediaUrls([p(1), p(2), p(3)]));
    expect(chamadas).toHaveLength(1);
    expect(denovo.get(p(3))).toBe(urls.get(p(3)));
    expect(await runWithTeam(TEAM, () => signedMediaUrl(p(1)))).toBe(urls.get(p(1)));
    expect(chamadas).toHaveLength(1);
  });

  it("cache é por time: o outro time assina de novo", async () => {
    await runWithTeam(TEAM, () => signedMediaUrls([p(10), p(11)]));
    await runWithTeam(OUTRO, () => signedMediaUrls([p(10), p(11)]));
    expect(chamadas).toHaveLength(2);
  });

  it("API de lote falhou → assina uma a uma (fallback)", async () => {
    loteQuebrado = true;
    const urls = await runWithTeam(TEAM, () => signedMediaUrls([p(20), p(21)]));
    expect(chamadas.map((c) => c.url.endsWith("/conversas-midia"))).toEqual([true, false, false]);
    expect(urls.get(p(21))).toContain("token=um");
  });

  it("objeto inexistente → null (e não vai para o cache)", async () => {
    const sumiu = `conv-${sufixo}/sumiu.jpg`;
    const urls = await runWithTeam(TEAM, () => signedMediaUrls([p(30), sumiu]));
    expect(urls.get(sumiu)).toBeNull();
    await runWithTeam(TEAM, () => signedMediaUrls([p(30), sumiu]));
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]!.url).toContain(encodeURI(sumiu)); // só o que faltou, no modo unitário
  });

  it("Storage não configurado → tudo null, sem request", async () => {
    Object.assign(env, { SUPABASE_URL: undefined });
    try {
      const urls = await runWithTeam(TEAM, () => signedMediaUrls([p(40)]));
      expect(urls.get(p(40))).toBeNull();
      expect(chamadas).toHaveLength(0);
    } finally {
      Object.assign(env, { SUPABASE_URL: URL_FALSA });
    }
  });
});
