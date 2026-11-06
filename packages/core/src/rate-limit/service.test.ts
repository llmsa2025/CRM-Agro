import { beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Limite por chave: a chave do IP (IPv6 pelo /64) e o `falhaFecha` (Redis fora
 * = nega, para as portas públicas que gastam a cota de e-mail). Sem Redis de
 * verdade: os dois clientes são trocados por um que sempre falha.
 */
const quebrado = vi.hoisted(() => ({
  incr: async () => {
    throw new Error("ECONNREFUSED");
  },
  expire: async () => 0,
  get: async () => {
    throw new Error("ECONNREFUSED");
  },
  del: async () => 0,
  on: () => undefined,
}));
vi.mock("ioredis", () => ({
  default: class {
    constructor() {
      return quebrado;
    }
  },
}));
vi.mock("../shared/redis-cache", () => ({ redisEstado: () => quebrado, redisCache: () => quebrado }));

const { chaveDoIp, limparLimitesEmMemoria, peekRateLimit, rateLimit, reabrirRedisDoLimite, resetRateLimit } = await import("./service");

describe("chaveDoIp", () => {
  it("IPv4 fica inteiro; texto que não é IP volta como veio", () => {
    expect(chaveDoIp("200.1.2.3")).toBe("200.1.2.3");
    expect(chaveDoIp(" 200.1.2.3 ")).toBe("200.1.2.3");
    expect(chaveDoIp("sem-ip")).toBe("sem-ip");
  });

  it("IPv6: só o /64 (qualquer endereço do mesmo /64 dá a mesma chave)", () => {
    const k = "2001:db8:a:b::/64";
    expect(chaveDoIp("2001:db8:a:b::1")).toBe(k);
    expect(chaveDoIp("2001:0db8:000a:000b:1234:5678:9abc:def0")).toBe(k);
    expect(chaveDoIp("2001:DB8:A:B:ffff:0:0:1")).toBe(k);
    expect(chaveDoIp("[2001:db8:a:b::99]")).toBe(k);
    expect(chaveDoIp("2001:db8:a:b::1%eth0")).toBe(k);
    expect(chaveDoIp("2001:db8:a:c::1")).not.toBe(k);
    expect(chaveDoIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(chaveDoIp("::1")).toBe("0:0:0:0::/64");
    // IPv4 no fim ocupa dois grupos: não muda o /64.
    expect(chaveDoIp("1::2:3:4:5:1.2.3.4")).toBe("1:0:2:3::/64");
  });

  it("IPv4 mapeado em IPv6 vira o IPv4", () => {
    expect(chaveDoIp("::ffff:200.1.2.3")).toBe("200.1.2.3");
    expect(chaveDoIp("::FFFF:200.1.2.3")).toBe("200.1.2.3");
  });
});

describe("Redis fora do ar", () => {
  beforeEach(() => {
    limparLimitesEmMemoria();
    reabrirRedisDoLimite();
  });

  it("padrão: não nega por falha de infra, mas CONTINUA limitando em memória (antes liberava tudo)", async () => {
    expect(await rateLimit("x", 2, 60_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await rateLimit("x", 2, 60_000)).toMatchObject({ allowed: true, remaining: 0 });
    // A 3ª passa do teto: antes, com o Redis fora, passava para sempre.
    const terceira = await rateLimit("x", 2, 60_000);
    expect(terceira.allowed).toBe(false);
    expect(terceira.retryAfterMs).toBeGreaterThan(0);
  });

  it("peek consulta sem consumir, e vê o que o rateLimit já gastou", async () => {
    expect(await peekRateLimit("p", 1, 60_000)).toMatchObject({ allowed: true });
    expect(await peekRateLimit("p", 1, 60_000)).toMatchObject({ allowed: true }); // consultar não gasta
    await rateLimit("p", 1, 60_000);
    expect(await peekRateLimit("p", 1, 60_000)).toMatchObject({ allowed: false });
  });

  it("chaves diferentes não se misturam, e reset zera só a chave pedida", async () => {
    await rateLimit("a", 1, 60_000);
    await rateLimit("b", 1, 60_000);
    expect((await rateLimit("a", 1, 60_000)).allowed).toBe(false);
    await resetRateLimit("a", 60_000);
    expect((await rateLimit("a", 1, 60_000)).allowed).toBe(true);
    expect((await rateLimit("b", 1, 60_000)).allowed).toBe(false);
  });

  it("a janela vencida recomeça", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      await rateLimit("j", 1, 60_000);
      expect((await rateLimit("j", 1, 60_000)).allowed).toBe(false);
      vi.setSystemTime(new Date("2026-10-01T12:01:01Z"));
      expect((await rateLimit("j", 1, 60_000)).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falhaFecha: NEGA e marca semRedis (a tela diz 'indisponível', não 'muitas tentativas')", async () => {
    expect(await rateLimit("x", 1, 60_000, { falhaFecha: true })).toMatchObject({ allowed: false, semRedis: true });
    expect(await peekRateLimit("x", 1, 60_000, { falhaFecha: true })).toMatchObject({ allowed: false, semRedis: true });
  });
});
