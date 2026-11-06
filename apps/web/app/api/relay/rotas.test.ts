import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

/**
 * Rotas do relay da leitura de seguidores, com os serviços trocados por falsos (a regra de verdade está
 * em packages/core/src/captacao/instagram-extensao.ts, com teste de banco):
 *  - POST /api/relay/captura-lote: origem, token, corpo, identidade do token e o mapa de erros;
 *  - GET /api/relay/poll: a tarefa `ig_followers` só sai para quem o servidor confirma como dono.
 */
// `vi.mock` sobe para o topo do arquivo: o que ele usa precisa nascer em `vi.hoisted`.
const h = vi.hoisted(() => {
  class ForbiddenError extends Error {}
  class LoteOcupado extends Error {}
  class ErroDeLote extends Error {
    constructor(public readonly codigo: string) {
      super("detalhe interno que não pode vazar");
    }
  }
  return {
    ForbiddenError,
    LoteOcupado,
    ErroDeLote,
    contextos: [] as { teamId: string; identidade: unknown }[],
    registrar: vi.fn(),
    recusar: vi.fn(),
    entregar: vi.fn(),
    autenticar: vi.fn(),
    esperarJob: vi.fn(),
  };
});
const { ForbiddenError, LoteOcupado, ErroDeLote, contextos, registrar, recusar, entregar, autenticar, esperarJob } = h;

vi.mock("@crmagro/db", () => ({
  runWithTeam: (teamId: string, fn: () => unknown, identidade: unknown) => {
    h.contextos.push({ teamId, identidade });
    return fn();
  },
}));
vi.mock("@crmagro/core", () => ({
  ForbiddenError: h.ForbiddenError,
  LoteOcupado: h.LoteOcupado,
  registrarLoteDaExtensao: (...a: unknown[]) => h.registrar(...a),
  aoEntregarJobAExtensao: (...a: unknown[]) => h.entregar(...a),
  aoRecusarJobAExtensao: (...a: unknown[]) => h.recusar(...a),
  tipoDeJobPermitido: (t: unknown) => ["http_fetch", "dom_action", "social_send", "ig_followers"].includes(String(t)),
}));
vi.mock("./_auth", () => ({
  authenticate: (...a: unknown[]) => h.autenticar(...a),
  unauthorized: () => Response.json({ error: "unauthorized" }, { status: 401 }),
}));
const entregarResultado = vi.fn();
vi.mock("./_store", () => ({
  waitForJob: (...a: unknown[]) => h.esperarJob(...a),
  deliverResult: (...a: unknown[]) => entregarResultado(...a),
}));

import { POST as postarLote } from "./captura-lote/route";
import { GET as poll } from "./poll/route";
import { POST as resultado } from "./result/route";

const ANA = { teamId: "time-a", userId: "ana", role: "member", token: "rly_x" };
const LOTE = "3f2a9c1e-5b7d-4e2a-9c1e-5b7d3f2a9c1e";
const corpo = { lote: LOTE, jobId: "job-1", itens: [{ username: "a" }] };

const pedido = (extra: { origin?: string; body?: string; headers?: Record<string, string> } = {}) =>
  new Request("https://app.crmagro.example/api/relay/captura-lote", {
    method: "POST",
    headers: { authorization: "Bearer rly_x", "content-type": "application/json", ...(extra.origin ? { origin: extra.origin } : {}), ...extra.headers },
    body: extra.body ?? JSON.stringify(corpo),
  });

beforeEach(() => {
  contextos.length = 0;
  registrar.mockReset().mockResolvedValue({ estado: "rodando", criados: 1, encerrada: false });
  entregar.mockReset().mockResolvedValue(true);
  autenticar.mockReset().mockResolvedValue(ANA);
  esperarJob.mockReset().mockResolvedValue(null);
  recusar.mockReset().mockResolvedValue(undefined);
  entregarResultado.mockReset().mockResolvedValue(true);
});

describe("POST /api/relay/captura-lote", () => {
  it("grava com a identidade do DONO DO TOKEN (time, pessoa e papel), nunca a do corpo", async () => {
    const r = await postarLote(pedido({ body: JSON.stringify({ ...corpo, teamId: "time-b", userId: "outro" }) }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, estado: "rodando", criados: 1, encerrada: false });
    expect(contextos).toEqual([{ teamId: "time-a", identidade: { userId: "ana", role: "member" } }]);
    expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ lote: LOTE, jobId: "job-1" }));
  });

  it("sem token válido: 401 e nada é gravado", async () => {
    autenticar.mockResolvedValue(null);
    const r = await postarLote(pedido());
    expect(r.status).toBe(401);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("página de OUTRO site (Origin http) é recusada antes de olhar o token", async () => {
    const r = await postarLote(pedido({ origin: "https://evil.com" }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "origem_nao_permitida" });
    expect(autenticar).not.toHaveBeenCalled();
    expect(registrar).not.toHaveBeenCalled();
  });

  it("a extensão (Origin chrome-extension://, ou sem Origin) passa", async () => {
    expect((await postarLote(pedido({ origin: "chrome-extension://abcdefghijklmnop" }))).status).toBe(200);
    expect((await postarLote(pedido())).status).toBe(200);
  });

  it("corpo que não é JSON: 400; grande demais: 413 (sem ler o resto)", async () => {
    expect((await postarLote(pedido({ body: "{isso não é json" }))).status).toBe(400);
    const grande = await postarLote(pedido({ body: JSON.stringify({ ...corpo, itens: [], lixo: "x".repeat(300_000) }) }));
    expect(grande.status).toBe(413);
    const declarado = await postarLote(pedido({ headers: { "content-length": "999999" } }));
    expect(declarado.status).toBe(413);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("mapa de erros: lote inválido 400, sem lote 404, de outra pessoa 403, encerrado 409, ocupado 409, sem permissão 403", async () => {
    const casos: [Error, number, string][] = [
      [new ZodError([]), 400, "lote_invalido"],
      [new ErroDeLote("lote_inexistente"), 404, "lote_inexistente"],
      [new ErroDeLote("lote_de_outra_pessoa"), 403, "lote_de_outra_pessoa"],
      [new ErroDeLote("lote_encerrado"), 409, "lote_encerrado"],
      [new LoteOcupado(), 409, "lote_ocupado"],
      [new ForbiddenError(), 403, "ForbiddenError"],
    ];
    for (const [erro, status, codigo] of casos) {
      registrar.mockRejectedValueOnce(erro);
      const r = await postarLote(pedido());
      expect(r.status, codigo).toBe(status);
      expect(await r.json(), codigo).toEqual({ error: codigo });
    }
  });

  it("erro inesperado: 500 sem vazar o detalhe", async () => {
    registrar.mockRejectedValueOnce(new Error("senha do banco: 1234"));
    const r = await postarLote(pedido());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("1234");
  });
});

describe("GET /api/relay/poll", () => {
  const pedidoPoll = (agente: string | null = "agent-1") => new Request(`https://app.crmagro.example/api/relay/poll${agente ? `?agentId=${agente}` : ""}`, { headers: { authorization: "Bearer rly_x" } });
  const tarefa = (type: string) => ({ id: "job-1", teamId: "time-a", type, spec: { lote: LOTE } });

  it("sem token: 401; sem agentId: 400", async () => {
    autenticar.mockResolvedValueOnce(null);
    expect((await poll(pedidoPoll())).status).toBe(401);
    expect((await poll(pedidoPoll(null))).status).toBe(400);
  });

  it("sem tarefa: { job: null }, e a presença é da PESSOA do token", async () => {
    expect(await (await poll(pedidoPoll())).json()).toEqual({ job: null });
    expect(esperarJob).toHaveBeenCalledWith("time-a", "agent-1", 25_000, "ana");
  });

  it("ig_followers: confirma com o servidor (no contexto do token) e só então entrega", async () => {
    esperarJob.mockResolvedValueOnce(tarefa("ig_followers"));
    const r = await (await poll(pedidoPoll())).json();
    expect(r.job).toMatchObject({ id: "job-1", type: "ig_followers" });
    expect(entregar).toHaveBeenCalledTimes(1);
    expect(contextos).toEqual([{ teamId: "time-a", identidade: { userId: "ana", role: "member" } }]);
  });

  it("ig_followers que o servidor não reconhece como desta pessoa NÃO é entregue", async () => {
    esperarJob.mockResolvedValueOnce(tarefa("ig_followers"));
    entregar.mockResolvedValueOnce(false);
    expect(await (await poll(pedidoPoll())).json()).toEqual({ job: null });
  });

  it("falha ao confirmar: não entrega", async () => {
    esperarJob.mockResolvedValueOnce(tarefa("ig_followers"));
    entregar.mockRejectedValueOnce(new Error("redis fora"));
    expect(await (await poll(pedidoPoll())).json()).toEqual({ job: null });
  });

  it("os outros tipos seguem como antes, sem passar pela confirmação", async () => {
    esperarJob.mockResolvedValueOnce(tarefa("social_send"));
    expect((await (await poll(pedidoPoll())).json()).job.type).toBe("social_send");
    expect(entregar).not.toHaveBeenCalled();
  });

  it("tipo fora do catálogo nunca sai do servidor", async () => {
    esperarJob.mockResolvedValueOnce(tarefa("rodar_codigo"));
    expect(await (await poll(pedidoPoll())).json()).toEqual({ job: null });
  });
});

describe("POST /api/relay/result: tarefa devolvida com erro", () => {
  const pedidoResultado = (corpo: unknown) =>
    new Request("https://app.crmagro.example/api/relay/result", { method: "POST", headers: { authorization: "Bearer rly_x", "content-type": "application/json" }, body: JSON.stringify(corpo) });

  it("resultado com erro avisa o servidor, no contexto do dono do token, para fechar a busca", async () => {
    const r = await resultado(pedidoResultado({ jobId: "job-1", ok: false, error: "not_implemented" }));
    expect(r.status).toBe(200);
    expect(recusar).toHaveBeenCalledWith("job-1", "not_implemented");
    expect(contextos).toEqual([{ teamId: "time-a", identidade: { userId: "ana", role: "member" } }]);
  });

  it("resultado bom não mexe em busca nenhuma", async () => {
    await resultado(pedidoResultado({ jobId: "job-1", ok: true }));
    expect(recusar).not.toHaveBeenCalled();
    expect(entregarResultado).toHaveBeenCalled();
  });

  it("falha ao fechar a busca não derruba a resposta ao agente", async () => {
    recusar.mockRejectedValueOnce(new Error("redis fora"));
    expect((await resultado(pedidoResultado({ jobId: "job-1", ok: false, error: "x" }))).status).toBe(200);
  });

  it("sem token: 401", async () => {
    autenticar.mockResolvedValueOnce(null);
    expect((await resultado(pedidoResultado({ jobId: "job-1", ok: false, error: "x" }))).status).toBe(401);
    expect(recusar).not.toHaveBeenCalled();
  });
});
