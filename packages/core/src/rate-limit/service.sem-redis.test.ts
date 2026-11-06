import { beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Redis FORA DE VERDADE (sem mock do ioredis): o REDIS_URL aponta para uma porta fechada.
 * Regressão do achado de 01/10/2026: o cliente do limitador enfileirava o comando e esperava a
 * reconexão sem prazo, então `rateLimit` ficava pendurado (mais de 8 s sem responder) e o
 * login junto. Agora tem de responder rápido e continuar limitando.
 */
vi.mock("@crmagro/config", async (orig) => {
  const m = await orig<typeof import("@crmagro/config")>();
  return { ...m, env: new Proxy(m.env, { get: (t, p) => (p === "REDIS_URL" ? "redis://127.0.0.1:9" : (t as never)[p as never]) }) };
});

const { peekRateLimit, rateLimit, reabrirRedisDoLimite, resetRateLimit } = await import("./service");

describe("limitador com o Redis realmente fora", () => {
  beforeEach(() => reabrirRedisDoLimite());

  it("responde em menos de 3 s (antes travava) e continua limitando", async () => {
    const inicio = Date.now();
    const a = await rateLimit("sem-redis:1", 1, 60_000);
    const b = await rateLimit("sem-redis:1", 1, 60_000);
    const consulta = await peekRateLimit("sem-redis:1", 1, 60_000);
    await resetRateLimit("sem-redis:2", 60_000);
    expect(Date.now() - inicio).toBeLessThan(3000);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
    expect(consulta.allowed).toBe(false);
  }, 15_000);

  it("falhaFecha continua negando (porta pública que gasta cota compartilhada)", async () => {
    const r = await Promise.race([
      rateLimit("sem-redis:fecha", 5, 60_000, { falhaFecha: true }),
      new Promise<null>((res) => setTimeout(() => res(null), 10_000)),
    ]);
    expect(r).toMatchObject({ allowed: false, semRedis: true });
  }, 15_000);
});
