import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Banco fora (justamente quando o alerta mais importa): a configuração da tela
 * não pode ser lida, então vale o `.env` e o alerta SAI. A leitura da
 * `AlertaConfig` é a única coisa trocada por um erro; o resto é real.
 */
vi.mock("@crmagro/db", async (orig) => {
  const real = await orig<typeof import("@crmagro/db")>();
  const base = new Proxy(real.basePrisma, {
    get: (t, p, r) =>
      p === "alertaConfig"
        ? {
            findUnique: async () => {
              throw new Error("banco fora do ar: db.interno:5432");
            },
          }
        : Reflect.get(t, p, r),
  });
  return { ...real, basePrisma: base };
});
vi.mock("../push/service", async (orig) => ({
  ...(await orig<typeof import("../push/service")>()),
  enviarPush: vi.fn(async () => ({ enviados: 0, removidas: 0, falhas: 0 })),
}));

const { alertarSeDegradado } = await import("./alerta");
const { configEfetiva } = await import("./alertas-config");
const { redisEstado } = await import("../shared/redis-cache");

const antes = process.env.ALERT_EMAILS;

beforeEach(async () => {
  process.env.ALERT_EMAILS = "env-banco-fora@exemplo.com.br";
  await redisEstado().del(
    "alerta:saude:database",
    "alerta:saude:email:database",
    "alerta:saude:email:n:database",
  );
});
afterAll(async () => {
  await redisEstado().del(
    "alerta:saude:database",
    "alerta:saude:email:database",
    "alerta:saude:email:n:database",
  );
  if (antes === undefined) delete process.env.ALERT_EMAILS;
  else process.env.ALERT_EMAILS = antes;
});

describe("banco fora", () => {
  it("a configuração cai no .env e o alerta do banco sai mesmo assim", async () => {
    expect((await configEfetiva()).origem).toBe("env");
    const ok = { status: "healthy" as const, latency_ms: 1 };
    const relatorio = {
      status: "unhealthy" as const,
      timestamp: new Date().toISOString(),
      uptime_seconds: 1,
      checks: {
        database: { status: "unhealthy" as const, latency_ms: 1, error: "sem conexão" },
        redis: ok,
        evolution: ok,
        worker: ok,
        emailPlataforma: ok,
      },
    } as unknown as Parameters<typeof alertarSeDegradado>[0];
    const enviar = vi.fn(async () => {});
    await alertarSeDegradado(
      relatorio,
      enviar,
      vi.fn(async () => {}),
    );
    expect(enviar).toHaveBeenCalledTimes(1);
    expect((enviar.mock.calls[0] as unknown as [string[]])[0]).toEqual([
      "env-banco-fora@exemplo.com.br",
    ]);
  });
});
