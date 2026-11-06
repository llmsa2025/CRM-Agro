import IORedis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { env } from "@crmagro/config";
import { rateLimit } from "./service";

/**
 * Redis de VERDADE, processo "recém-nascido": o cliente do limitador é criado no 1º uso e ainda
 * está conectando. A 1ª chamada tem de ESPERAR a conexão e contar NO REDIS (antes, sem fila offline,
 * errava na hora, caía na memória e a contagem se dividia entre os dois).
 */
const redis = new IORedis(env.REDIS_URL);
const chave = `corrida-${Math.random().toString(36).slice(2, 9)}`;
afterAll(async () => {
  await redis.quit();
});

describe("1º uso do limitador com o Redis no ar", () => {
  it("a 1ª chamada já conta no Redis (nada fica só na memória)", async () => {
    const a = await rateLimit(chave, 2, 60_000);
    const b = await rateLimit(chave, 2, 60_000);
    const c = await rateLimit(chave, 2, 60_000);
    expect([a.allowed, b.allowed, c.allowed]).toEqual([true, true, false]);
    const bucket = Math.floor(Date.now() / 60_000);
    expect(Number(await redis.get(`rl:${chave}:${bucket}`))).toBe(3);
  });
});
