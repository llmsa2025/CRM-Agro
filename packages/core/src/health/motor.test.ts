import { describe, it, expect, beforeEach, vi } from "vitest";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "@crmagro/config";

/**
 * Saúde do motor e alerta (item 1.10 — MF-24). Redis de TESTE real (filas com
 * nome próprio do teste); o e-mail do alerta é MOCKADO.
 */
const { metricasDaFila, avaliarMotor, workersVivos, WORKER_HEARTBEAT_PREFIXO, LIMITE_ATRASO_FLOW_MS } = await import("./motor");
const { alertarSeDegradado, motivosDoRelatorio } = await import("./alerta");
const { redisEstado } = await import("../shared/redis-cache");

const sufixo = Math.random().toString(36).slice(2, 8);
const vazia = { waiting: 0, delayed: 0, active: 0, failed: 0, atrasoMs: 0 };

describe("métricas das filas", () => {
  it("conta a fila e mede há quanto tempo o job PRONTO mais antigo espera", async () => {
    const nome = `saude-teste-${sufixo}`;
    const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const q = new Queue(nome, { connection: conn });
    try {
      const agora = Date.now();
      await q.add("x", {}, { timestamp: agora - 12 * 60_000 });
      await q.add("y", {});
      await q.add("z", {}, { delay: 60_000 });
      const m = await metricasDaFila(nome, agora);
      expect(m).toMatchObject({ waiting: 2, delayed: 1, active: 0 });
      expect(m.atrasoMs).toBeGreaterThanOrEqual(12 * 60_000 - 1000);
    } finally {
      await q.obliterate({ force: true });
      await q.close();
      conn.disconnect();
    }
  });

  it("degraded: fila flow > 10 min, social > 30 min, ou qualquer órfã", () => {
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 0 })).toEqual([]);
    expect(avaliarMotor({ flow: { ...vazia, atrasoMs: LIMITE_ATRASO_FLOW_MS + 60_000 }, social: vazia, orfas: 0 })[0]).toMatch(/flow atrasada 11 min/);
    expect(avaliarMotor({ flow: vazia, social: { ...vazia, atrasoMs: 20 * 60_000 }, orfas: 0 })).toEqual([]);
    expect(avaliarMotor({ flow: vazia, social: { ...vazia, atrasoMs: 31 * 60_000 }, orfas: 0 })[0]).toMatch(/social/);
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 2 })[0]).toMatch(/2 inscrição\(ões\) órfã/);
  });

  it("degraded: inscrição segurada pela pausa com o fluxo no ar (o incidente de 02/10/2026)", () => {
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 0, seguradasComFluxoNoAr: 0 })).toEqual([]);
    const m = avaliarMotor({ flow: vazia, social: vazia, orfas: 0, seguradasComFluxoNoAr: 1018 });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/1018 inscrição\(ões\) segurada\(s\) pela pausa com o fluxo no ar/);
  });

  it("degraded: worker com o RLS (pool do crmagro_app) quebrado; sem RLS ou com RLS ok, nada a avisar", () => {
    expect(avaliarMotor({ flow: vazia, social: vazia, orfas: 0, workersComRlsQuebrado: 0 })).toEqual([]);
    const m = avaliarMotor({ flow: vazia, social: vazia, orfas: 0, workersComRlsQuebrado: 1 });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/1 worker\(s\) com o RLS quebrado/);
    expect(m[0]).toMatch(/desligue o RLS do worker/);
  });

  it("heartbeat com o estado do RLS do worker: o motor lê o campo `rls` de cada processo", async () => {
    const pid = 800000 + Math.floor(Math.random() * 99999);
    await redisEstado().set(
      `${WORKER_HEARTBEAT_PREFIXO}${pid}`,
      JSON.stringify({ at: new Date().toISOString(), pid, primary: false, ultimoJobEm: null, rls: "problema" }),
      "EX",
      30,
    );
    try {
      const vivos = await workersVivos(redisEstado());
      expect(vivos.find((w) => w.pid === pid)?.rls).toBe("problema");
    } finally {
      await redisEstado().del(`${WORKER_HEARTBEAT_PREFIXO}${pid}`);
    }
  });

  it("heartbeat por processo: cada worker aparece com o último job", async () => {
    const pid = 900000 + Math.floor(Math.random() * 99999);
    await redisEstado().set(
      `${WORKER_HEARTBEAT_PREFIXO}${pid}`,
      JSON.stringify({ at: new Date().toISOString(), pid, primary: false, ultimoJobEm: "2026-09-26T10:00:00.000Z" }),
      "EX",
      30,
    );
    const vivos = await workersVivos(redisEstado());
    expect(vivos.find((w) => w.pid === pid)).toMatchObject({ primary: false, ultimoJobEm: "2026-09-26T10:00:00.000Z" });
  });
});

describe("alerta de saúde", () => {
  const relatorio = (motivo: string) => ({
    status: "degraded" as const,
    timestamp: new Date().toISOString(),
    uptime_seconds: 1,
    checks: {
      database: { status: "healthy" as const, latency_ms: 1 },
      redis: { status: "healthy" as const, latency_ms: 1 },
      evolution: { status: "healthy" as const, latency_ms: 1 },
      worker: { status: "healthy" as const, latency_ms: 1 },
      emailPlataforma: { status: "healthy" as const, latency_ms: 0 },
      motor: { status: "unhealthy" as const, latency_ms: 1, error: motivo, filas: { flow: vazia, social: vazia }, orfas: 0, falhasUltimaHora: 0, workers: [], motivos: [motivo] },
    },
  });

  beforeEach(async () => {
    process.env.ALERT_EMAILS = "ops@exemplo.com.br";
    const r = redisEstado();
    const chaves = await r.keys(`alerta:saude:motor:teste ${sufixo}*`);
    if (chaves.length) await r.del(...chaves);
  });

  it("avisa uma vez por motivo em 30 min; motivo novo avisa de novo", async () => {
    const enviar = vi.fn(async () => {});
    const m1 = `teste ${sufixo} fila flow atrasada 12 min`;
    expect(await alertarSeDegradado(relatorio(m1), enviar)).toEqual([`motor: ${m1}`]);
    // Mesmo motivo com outro número (13 min): não repete o e-mail.
    expect(await alertarSeDegradado(relatorio(`teste ${sufixo} fila flow atrasada 13 min`), enviar)).toEqual([]);
    expect(enviar).toHaveBeenCalledTimes(1);
    // Texto puro e HTML (modelo da marca) com o motivo; o HTML escapa o texto.
    expect(enviar).toHaveBeenCalledWith(
      ["ops@exemplo.com.br"],
      expect.stringContaining("[CRM Agro] degraded"),
      expect.stringContaining(m1),
      expect.stringContaining(m1),
    );
    await alertarSeDegradado(relatorio(`teste ${sufixo} órfãs`), enviar);
    expect(enviar).toHaveBeenCalledTimes(2);
  });

  it("mesmo motivo persistente: o e-mail espera cada vez mais (30 min → 2 h → 6 h); o push segue a cada 30 min", async () => {
    const enviar = vi.fn(async () => {});
    const push = vi.fn(async () => {});
    const m = `teste ${sufixo} persistente fila flow atrasada 40 min`;
    const chave = `motor:${m.replace(/\d+/g, "#")}`;
    const r = redisEstado();
    const ttls: number[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        await alertarSeDegradado(relatorio(m), enviar, push);
        ttls.push(await r.ttl(`alerta:saude:email:${chave}`));
        // Simula a espera vencida (a trava do e-mail e a do push).
        await r.del(`alerta:saude:email:${chave}`, `alerta:saude:${chave}`);
      }
      expect(enviar).toHaveBeenCalledTimes(4);
      expect(ttls[0]).toBeGreaterThan(29 * 60);
      expect(ttls[0]).toBeLessThanOrEqual(30 * 60);
      expect(ttls[1]).toBeGreaterThan(119 * 60);
      expect(ttls[1]).toBeLessThanOrEqual(2 * 60 * 60);
      expect(ttls[2]).toBeGreaterThan(359 * 60);
      expect(ttls[3]).toBeGreaterThan(359 * 60);

      // Só a trava do PUSH venceu: o push sai de novo, o e-mail não.
      await alertarSeDegradado(relatorio(m), enviar, push);
      await r.del(`alerta:saude:${chave}`);
      await alertarSeDegradado(relatorio(m), enviar, push);
      expect(push).toHaveBeenCalledTimes(6);
      expect(enviar).toHaveBeenCalledTimes(5);
    } finally {
      await r.del(`alerta:saude:email:${chave}`, `alerta:saude:email:n:${chave}`, `alerta:saude:${chave}`);
    }
  });

  it("tudo saudável não avisa; dependência fora vira motivo pelo nome", async () => {
    const enviar = vi.fn(async () => {});
    const ok = { ...relatorio("x"), status: "healthy" as const };
    expect(await alertarSeDegradado(ok, enviar)).toEqual([]);
    const semEvolution = relatorio("x");
    semEvolution.checks.evolution = { status: "unhealthy" as const, latency_ms: 1, error: "instância close" } as never;
    expect(motivosDoRelatorio(semEvolution).map((m) => m.chave)).toContain("evolution");
    expect(enviar).not.toHaveBeenCalled();
  });
});
