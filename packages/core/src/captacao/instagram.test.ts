import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { coletarSeguidoresInstagram, classificarRecusaInstagram } from "@crmagro/captation";
import { redisEstado } from "../shared/redis-cache";
import { executarCaptura, lerStatusCaptura, CapturaFalhou, type CaptureJob, type ContextoColeta } from "./index";

/**
 * Captação de seguidores do Instagram (item 3.2, INT-12): cada página vira
 * rascunho assim que chega; 429 no meio PARA e mantém o que veio (antes o
 * `throw` descartava ~1.450 seguidores); sessão caída falha visível; toda
 * requisição tem teto. `fetch` é FALSO — nada vai ao Instagram.
 */
const TEAM = "00000000-0000-0000-0000-0000000004a5";

type Pagina = { status: number; body?: unknown } | "timeout";

/** fetch falso: 1ª chamada = perfil; depois, as páginas na ordem. */
function instagramFalso(perfil: { status: number; body?: unknown }, paginas: Pagina[]) {
  const sinais: boolean[] = [];
  let i = -1;
  const f = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    sinais.push(init?.signal instanceof AbortSignal);
    const r = i++ < 0 ? perfil : paginas[i - 1] ?? { status: 200, body: { users: [] } };
    if (r === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetchImpl: f as unknown as typeof fetch, sinais };
}

const PERFIL_OK = { status: 200, body: { data: { user: { id: "123" } } } };
const pagina = (de: number, n: number, proxima: string | null) => ({
  status: 200,
  body: {
    users: Array.from({ length: n }, (_, k) => ({ username: `seguidor_${de + k}`, full_name: `Seguidor ${de + k}` })),
    next_max_id: proxima,
  },
});

function jobIg(): Extract<CaptureJob, { origem: "instagram" }> {
  return { origem: "instagram", teamId: TEAM, lote: crypto.randomUUID(), accountId: "conta-teste", perfil: "@perfil_teste", limite: 300 };
}

/** O mesmo coletor do worker (capture-handler), com o fetch falso. */
function coletorIg(job: Extract<CaptureJob, { origem: "instagram" }>, fetchImpl: typeof fetch) {
  return async (ctx: ContextoColeta) => {
    const r = await coletarSeguidoresInstagram({
      cookie: "sessionid=falso",
      perfil: job.perfil,
      limite: job.limite,
      fetchImpl,
      esperar: async () => {},
      aoPagina: async (itens) => {
        await ctx.gravar(itens.map((u) => ({ nome: u.nome, extra: { username: u.username } })));
      },
    });
    ctx.progresso(r.lidos);
    return { interrupcao: r.interrupcao };
  };
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Instagram (test)" } });
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});

beforeEach(async () => {
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: TEAM } });
});

describe("Instagram — grava por página e para no 429", () => {
  it("429 na 3ª página: as 2 primeiras (100) ficam na fila, status 'parcial' e o job NÃO falha", async () => {
    const job = jobIg();
    const { fetchImpl, sinais } = instagramFalso(PERFIL_OK, [pagina(0, 50, "a"), pagina(50, 50, "b"), { status: 429 }]);
    const st = await executarCaptura(job, coletorIg(job, fetchImpl));
    expect(st).toMatchObject({ estado: "parcial", motivo: "limite_instagram", criados: 100, processados: 100 });
    expect(st.mensagem).toMatch(/Instagram limitou/);
    expect(await basePrisma.prospectDraft.count({ where: { teamId: TEAM, lote: job.lote } })).toBe(100);
    expect(sinais.every(Boolean)).toBe(true); // toda requisição com teto
  });

  it("429 logo na 1ª página: 'falhou' visível (o job falha)", async () => {
    const job = jobIg();
    const { fetchImpl } = instagramFalso(PERFIL_OK, [{ status: 429 }]);
    await expect(executarCaptura(job, coletorIg(job, fetchImpl))).rejects.toMatchObject({ motivo: "limite_instagram" });
    expect(await lerStatusCaptura(TEAM, job.lote)).toMatchObject({ estado: "falhou", motivo: "limite_instagram" });
  });

  it("sessão caída no perfil: 'falhou' com o motivo de reconectar", async () => {
    const job = jobIg();
    const { fetchImpl } = instagramFalso({ status: 401 }, []);
    await expect(executarCaptura(job, coletorIg(job, fetchImpl))).rejects.toBeInstanceOf(CapturaFalhou);
    const st = await lerStatusCaptura(TEAM, job.lote);
    expect(st).toMatchObject({ estado: "falhou", motivo: "sessao_instagram" });
    expect(st?.mensagem).toMatch(/Reconecte a conta/);
  });

  it("timeout no meio: para com o que já veio", async () => {
    const job = jobIg();
    const { fetchImpl } = instagramFalso(PERFIL_OK, [pagina(0, 50, "a"), "timeout"]);
    const st = await executarCaptura(job, coletorIg(job, fetchImpl));
    expect(st).toMatchObject({ estado: "parcial", motivo: "erro", criados: 50 });
    expect(st.mensagem).toMatch(/sem resposta em 20s/);
  });

  it("respeita o limite e não repete quem a API devolve duas vezes", async () => {
    const repetida = pagina(40, 50, "b"); // seguidor_40..49 repetem da 1ª página
    const itens: string[] = [];
    const { fetchImpl } = instagramFalso(PERFIL_OK, [pagina(0, 50, "a"), repetida, pagina(90, 50, null)]);
    const r = await coletarSeguidoresInstagram({
      cookie: "x",
      perfil: "perfil_teste",
      limite: 120,
      fetchImpl,
      esperar: async () => {},
      aoPagina: async (p) => {
        itens.push(...p.map((u) => u.username));
      },
    });
    expect(r).toMatchObject({ lidos: 120, interrupcao: null });
    expect(new Set(itens).size).toBe(120);
  });

  it("429 disfarçado (HTTP 200/400 com 'Please wait a few minutes') e checkpoint", () => {
    expect(classificarRecusaInstagram(400, { message: "Please wait a few minutes before you try again.", status: "fail" })).toBe(
      "limite_instagram",
    );
    expect(classificarRecusaInstagram(200, { message: "checkpoint_required", status: "fail" })).toBe("sessao_instagram");
    expect(classificarRecusaInstagram(200, { users: [] })).toBeNull();
  });
});
