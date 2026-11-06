import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Redis FORA: a trava por motivo falhava no primeiro `set` e o alerta morria mudo.
 * Agora cai numa trava em memória: o alerta sai UMA vez e não repete a cada checagem.
 * O Redis do estado é trocado por um que recusa tudo; banco e e-mail são os de teste/espiões.
 */
const redisQuebrado = vi.hoisted(() => {
  const falha = () => Promise.reject(new Error("Connection is closed."));
  const fake = {
    set: falha,
    get: falha,
    multi: () => ({ incr: () => ({ expire: () => ({ exec: falha }) }) }),
  };
  return fake;
});
vi.mock("../shared/redis-cache", async (orig) => ({
  ...(await orig<typeof import("../shared/redis-cache")>()),
  redisEstado: () => redisQuebrado,
}));
vi.mock("../push/service", async (orig) => ({
  ...(await orig<typeof import("../push/service")>()),
  enviarPush: vi.fn(async () => ({ enviados: 0, removidas: 0, falhas: 0 })),
}));

const { alertarSeDegradado, limparTravasDoAlertaEmMemoriaParaTeste } = await import("./alerta");

const antes = process.env.ALERT_EMAILS;
const ok = { status: "healthy" as const, latency_ms: 1 };
const relatorio = (fora: "worker" | "evolution") =>
  ({
    status: "degraded" as const,
    timestamp: new Date().toISOString(),
    uptime_seconds: 1,
    checks: {
      database: ok,
      redis: ok,
      evolution: ok,
      worker: ok,
      emailPlataforma: ok,
      [fora]: { status: "unhealthy", latency_ms: 1, error: "fora" },
    },
  }) as unknown as Parameters<typeof alertarSeDegradado>[0];

beforeEach(() => {
  limparTravasDoAlertaEmMemoriaParaTeste();
  process.env.ALERT_EMAILS = "redis-fora@exemplo.com.br";
});
afterAll(() => {
  if (antes === undefined) delete process.env.ALERT_EMAILS;
  else process.env.ALERT_EMAILS = antes;
});

describe("Redis fora", () => {
  it("o alerta sai mesmo assim (e-mail e push), e não repete a cada checagem", async () => {
    const enviar = vi.fn(async () => {});
    const push = vi.fn(async () => {});
    expect(await alertarSeDegradado(relatorio("worker"), enviar, push)).toHaveLength(1);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    // Segunda checagem logo depois: a trava em memória segura.
    expect(await alertarSeDegradado(relatorio("worker"), enviar, push)).toEqual([]);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    // Motivo novo avisa.
    await alertarSeDegradado(relatorio("evolution"), enviar, push);
    expect(enviar).toHaveBeenCalledTimes(2);
  });
});
