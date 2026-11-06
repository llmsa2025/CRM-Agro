import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Testes dos health checks de infraestrutura.
 *
 * Mocks:
 * - basePrisma.$queryRaw: simula SELECT 1
 * - Redis: simula ping
 * - fetch: simula resposta da Evolution API
 */

// Saúde do motor (item 1.10) tem teste próprio (motor.test.ts, Redis real);
// aqui ela é controlável para testar a agregação.
const motor = vi.hoisted(() => ({ status: "healthy" as "healthy" | "unhealthy" }));
vi.mock("./motor", () => ({
  checkMotor: async () => ({
    status: motor.status,
    latency_ms: 1,
    ...(motor.status === "unhealthy" ? { error: "fila flow atrasada 12 min" } : {}),
    filas: {},
    orfas: 0,
    falhasUltimaHora: 0,
    workers: [],
    motivos: motor.status === "unhealthy" ? ["fila flow atrasada 12 min"] : [],
  }),
}));

// Pool do papel crmagro_app (RLS): controlável, desligado por padrão (sem DATABASE_URL_APP).
const sondaApp = vi.hoisted(() => ({ atual: { ativo: false } as { ativo: boolean; ok?: boolean; papel?: string; problema?: string } }));
vi.mock("@crmagro/db", () => ({
  sondarBancoApp: async () => sondaApp.atual,
  basePrisma: {
    $queryRaw: vi.fn(),
    // Contas WhatsApp conectadas: sem nenhuma, o check cai no env (test-instance).
    channelAccount: { findMany: vi.fn(async () => []) },
  },
}));

// Estado do remetente da plataforma que o check `emailPlataforma` lê.
const remetente = vi.hoisted(() => ({ atual: { estado: "desligado" } as { estado: string; problemas?: string[] } }));
// Mutável: o teste do Cloudflare Access liga CF_ACCESS_* e desliga no fim. O mesmo objeto chega ao
// `evolutionHeaders` de @crmagro/channels (o vi.mock vale para todo import de @crmagro/config).
const envTeste = vi.hoisted(
  (): Record<string, string | undefined> => ({
    REDIS_URL: "redis://localhost:6379",
    EVOLUTION_API_URL: "http://localhost:8080",
    EVOLUTION_API_KEY: "test-key",
    EVOLUTION_INSTANCE: "test-instance",
  }),
);
vi.mock("@crmagro/config", () => ({
  env: envTeste,
  remetenteDaPlataforma: () => remetente.atual,
}));

vi.mock("ioredis", () => {
  const mockRedis = {
    ping: vi.fn().mockResolvedValue("PONG"),
    get: vi.fn().mockResolvedValue(JSON.stringify({ at: "2026-09-24T00:00:00.000Z" })),
    disconnect: vi.fn(),
    on: vi.fn(),
  };
  return {
    Redis: vi.fn(() => mockRedis),
    default: { Redis: vi.fn(() => mockRedis) },
  };
});

// stubGlobal + unstub no fim: trocar `global.fetch` direto VAZAVA para os
// arquivos seguintes do mesmo processo (pool single-fork) e quebrava quem usa
// fetch de verdade (ex.: flows/classificacao-envio.test.ts).
vi.stubGlobal("fetch", vi.fn());
afterAll(() => {
  vi.unstubAllGlobals();
});

import { checkDatabase, checkRedis, checkEvolution, checkWorker, checkBancoApp, runHealthChecks } from "./check";

/** Resposta do `GET /instance/fetchInstances`: [nome, connectionStatus]... */
function evo(...instancias: Array<[string, string]>) {
  return instancias.map(([name, connectionStatus]) => ({ name, connectionStatus, profileName: "Dono", token: "segredo" }));
}
import { basePrisma } from "@crmagro/db";
import { Redis } from "ioredis";

/** A instância de Redis mockada (a mesma devolvida a cada `new Redis`). */
function mockedRedis() {
  return new (Redis as unknown as new () => { get: ReturnType<typeof vi.fn> })();
}

describe("health checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkDatabase", () => {
    it("retorna healthy quando SELECT 1 funciona", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      const result = await checkDatabase();
      expect(result.status).toBe("healthy");
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it("retorna unhealthy quando DB falha", async () => {
      vi.mocked(basePrisma.$queryRaw).mockRejectedValue(new Error("Connection refused"));
      const result = await checkDatabase();
      expect(result.status).toBe("unhealthy");
      expect(result.error).toBe("Connection refused");
    });
  });

  describe("checkEvolution", () => {
    const contas = () => vi.mocked(basePrisma.channelAccount.findMany);

    it("sem conta conectada no banco: confere a instância do env (fallback)", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => evo(["test-instance", "open"]),
      } as Response);
      const result = await checkEvolution();
      expect(result.status).toBe("healthy");
      // Uma chamada só, para todas as instâncias.
      expect(String(vi.mocked(global.fetch).mock.calls.at(-1)?.[0])).toBe("http://localhost:8080/instance/fetchInstances");
      // Sem CF_ACCESS_*: só a apikey (VPS, Evolution em 127.0.0.1).
      expect(vi.mocked(global.fetch).mock.calls.at(-1)?.[1]?.headers).toEqual({ apikey: "test-key" });
    });

    it("com CF_ACCESS_* (web na Vercel): manda a chave do Cloudflare Access junto com a apikey", async () => {
      envTeste.CF_ACCESS_CLIENT_ID = "id-teste.access";
      envTeste.CF_ACCESS_CLIENT_SECRET = "segredo-teste";
      try {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => evo(["test-instance", "open"]),
        } as Response);
        const result = await checkEvolution();
        expect(result.status).toBe("healthy");
        expect(vi.mocked(global.fetch).mock.calls.at(-1)?.[1]?.headers).toEqual({
          apikey: "test-key",
          "CF-Access-Client-Id": "id-teste.access",
          "CF-Access-Client-Secret": "segredo-teste",
        });
      } finally {
        delete envTeste.CF_ACCESS_CLIENT_ID;
        delete envTeste.CF_ACCESS_CLIENT_SECRET;
      }
    });

    it("confere as contas conectadas do BANCO, não a instância fixa do env", async () => {
      contas().mockResolvedValueOnce([{ externalId: "numero-pessoal" }, { externalId: "comercial" }] as never);
      // A do env (test-instance) nem existe mais na Evolution — não importa.
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => evo(["numero-pessoal", "open"], ["comercial", "open"]),
      } as Response);
      expect((await checkEvolution()).status).toBe("healthy");
      expect(contas()).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ provider: "evolution", status: "connected" }) }),
      );
    });

    it("conta conectada no banco com a sessão CAÍDA ou sumida na Evolution → unhealthy, dizendo qual", async () => {
      contas().mockResolvedValueOnce([{ externalId: "numero-pessoal" }, { externalId: "comercial" }, { externalId: "apagada" }] as never);
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => evo(["numero-pessoal", "open"], ["comercial", "close"]),
      } as Response);
      const result = await checkEvolution();
      expect(result.status).toBe("unhealthy");
      expect(result.error).toBe("instância comercial: close; apagada: não existe na Evolution");
    });

    it("banco fora: cai no env em vez de derrubar o check da Evolution", async () => {
      contas().mockRejectedValueOnce(new Error("DB down"));
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => evo(["test-instance", "open"]),
      } as Response);
      expect((await checkEvolution()).status).toBe("healthy");
    });

    it("200 com a sessão CAÍDA não é saudável (exige open)", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => evo(["test-instance", "close"]),
      } as Response);
      const result = await checkEvolution();
      expect(result.status).toBe("unhealthy");
      expect(result.error).toBe("instância test-instance: close");
    });

    it("retorna unhealthy quando Evolution responde erro", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);
      const result = await checkEvolution();
      expect(result.status).toBe("unhealthy");
      expect(result.error).toBe("HTTP 500");
    });

    it("retorna unhealthy quando fetch falha", async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await checkEvolution();
      expect(result.status).toBe("unhealthy");
      expect(result.error).toBe("ECONNREFUSED");
    });
  });

  describe("checkRedis", () => {
    it("retorna healthy quando o PING responde PONG", async () => {
      const result = await checkRedis();
      expect(result.status).toBe("healthy");
    });
  });

  describe("checkWorker", () => {
    it("retorna healthy quando há heartbeat do worker", async () => {
      const result = await checkWorker();
      expect(result.status).toBe("healthy");
    });

    it("retorna unhealthy quando o worker não grava heartbeat (parado)", async () => {
      mockedRedis().get.mockResolvedValueOnce(null);
      const result = await checkWorker();
      expect(result.status).toBe("unhealthy");
      expect(result.error).toMatch(/heartbeat/);
    });
  });

  describe("runHealthChecks", () => {
    it("motor atrasado (fila > 10 min ou órfãs) → degraded, mesmo com tudo de pé (item 1.10)", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
      motor.status = "unhealthy";
      try {
        const report = await runHealthChecks();
        expect(report.checks.motor.status).toBe("unhealthy");
        expect(report.status).toBe("degraded");
      } finally {
        motor.status = "healthy";
      }
    });

    it("retorna healthy quando todos os checks passam", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
      const report = await runHealthChecks();
      expect(report.status).toBe("healthy");
      expect(report.checks.database.status).toBe("healthy");
      expect(report.checks.redis.status).toBe("healthy");
      expect(report.checks.evolution.status).toBe("healthy");
      expect(report.checks.worker.status).toBe("healthy");
      expect(report.uptime_seconds).toBeGreaterThanOrEqual(0);
    });

    it("remetente da plataforma inválido (PLATFORM_* pela metade) → degraded, sem derrubar nada", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
      remetente.atual = { estado: "invalido", problemas: ["PLATFORM_SMTP_PASS ausente"] };
      try {
        const report = await runHealthChecks();
        expect(report.status).toBe("degraded");
        expect(report.checks.emailPlataforma.status).toBe("unhealthy");
        expect(report.checks.emailPlataforma.error).toBe("remetente da plataforma inválido: PLATFORM_SMTP_PASS ausente");
      } finally {
        remetente.atual = { estado: "desligado" };
      }
      expect((await runHealthChecks()).checks.emailPlataforma.status).toBe("healthy");
    });

    it("retorna degraded quando o worker está parado", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
      mockedRedis().get.mockResolvedValueOnce(null);
      const report = await runHealthChecks();
      expect(report.status).toBe("degraded");
      expect(report.checks.worker.status).toBe("unhealthy");
    });

    it("retorna unhealthy quando DB falha", async () => {
      vi.mocked(basePrisma.$queryRaw).mockRejectedValue(new Error("DB down"));
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
      const report = await runHealthChecks();
      expect(report.status).toBe("unhealthy");
      expect(report.checks.database.status).toBe("unhealthy");
    });

    it("RLS desligado (sem DATABASE_URL_APP): o relatório não traz o check rls", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
      expect(await checkBancoApp()).toBeNull();
      const report = await runHealthChecks();
      expect(report.checks.rls).toBeUndefined();
      expect(report.status).toBe("healthy");
    });

    it("RLS ligado e o pool do crmagro_app em ordem: check rls healthy", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
      sondaApp.atual = { ativo: true, ok: true, papel: "crmagro_app" };
      try {
        const report = await runHealthChecks();
        expect(report.checks.rls?.status).toBe("healthy");
        expect(report.status).toBe("healthy");
      } finally {
        sondaApp.atual = { ativo: false };
      }
    });

    it("RLS ligado mas o login do crmagro_app falha: unhealthy (todo db() falharia), mesmo com o basePrisma verde", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
      sondaApp.atual = { ativo: true, ok: false, problema: "o banco recusou o login do crmagro_app" };
      try {
        const report = await runHealthChecks();
        expect(report.checks.database.status).toBe("healthy");
        expect(report.checks.rls?.status).toBe("unhealthy");
        expect(report.checks.rls?.error).toBe("RLS: o banco recusou o login do crmagro_app");
        expect(report.status).toBe("unhealthy");
      } finally {
        sondaApp.atual = { ativo: false };
      }
    });

    it("retorna degraded quando apenas Evolution falha", async () => {
      vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
      vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 500 } as Response);
      const report = await runHealthChecks();
      expect(report.status).toBe("degraded");
      expect(report.checks.evolution.status).toBe("unhealthy");
      expect(report.checks.database.status).toBe("healthy");
      expect(report.checks.redis.status).toBe("healthy");
    });
  });
});

describe("vigia do backup fora do servidor no relatório de saúde", () => {
  const todosDePe = () => {
    vi.mocked(basePrisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, status: 200, json: async () => evo(["test-instance", "open"]) } as Response);
  };

  it("desligado (padrão): o relatório não ganha a chave `backup` nem fica degraded", async () => {
    todosDePe();
    delete process.env.BACKUP_FORA_VIGIAR;
    const report = await runHealthChecks();
    expect(report.status).toBe("healthy");
    expect("backup" in report.checks).toBe(false);
  });

  it("ligado com a cópia falhando: degraded, com o motivo em checks.backup (o alerta existente avisa)", async () => {
    todosDePe();
    const dir = await mkdtemp(join(tmpdir(), "crmagro-health-backup-"));
    process.env.BACKUP_FORA_VIGIAR = "1";
    process.env.BACKUP_STATUS_DIR = dir;
    try {
      const agora = new Date().toISOString();
      await writeFile(join(dir, "copia-fora.json"), JSON.stringify({ versao: 1, ok: false, quando: agora, ultimoSucesso: null, motivo: "destino_inacessivel" }));
      const report = await runHealthChecks();
      expect(report.status).toBe("degraded");
      expect(report.checks.backup?.status).toBe("unhealthy");
      expect(report.checks.backup?.error).toBe("a cópia do backup para fora do servidor falhou: o destino da cópia não responde, ainda não houve cópia boa");
      // Cópia boa: volta a saudável.
      await writeFile(join(dir, "copia-fora.json"), JSON.stringify({ versao: 1, ok: true, quando: agora, ultimoSucesso: agora, motivo: "" }));
      const bom = await runHealthChecks();
      expect(bom.status).toBe("healthy");
      expect(bom.checks.backup?.status).toBe("healthy");
    } finally {
      delete process.env.BACKUP_FORA_VIGIAR;
      delete process.env.BACKUP_STATUS_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
