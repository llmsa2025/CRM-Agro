import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { redisEstado } from "../shared/redis-cache";

// A fila `capture` é mockada (nada vai para o Redis do BullMQ): só o status e
// os rascunhos são de verdade.
const adicionados: { nome: string; data: unknown; opts: { jobId?: string } }[] = [];
vi.mock("bullmq", () => ({
  Queue: class {
    async add(nome: string, data: unknown, opts: { jobId?: string }) {
      adicionados.push({ nome, data, opts });
    }
  },
}));

import {
  executarCaptura,
  CapturaFalhou,
  enqueueCapture,
  statusDaCaptura,
  lerStatusCaptura,
  salvarStatusCaptura,
  novoStatusCaptura,
  type CaptureJob,
  type ContextoColeta,
} from "./index";

/**
 * Execução de um job da fila `capture` (item 3.2, INT-11/INT-12): status
 * visível por time, gravação aos poucos, "vazio" ≠ "concluído", falha visível
 * e job retomado após queda do worker sem raspar de novo. O coletor aqui é
 * falso (o do worker é Playwright/fetch) — nenhum acesso a Google/Instagram.
 */
const TEAM = "00000000-0000-0000-0000-0000000004a1";
const OUTRO = "00000000-0000-0000-0000-0000000004a2";

let n = 0;
function jobMaps(teamId = TEAM): CaptureJob {
  n++;
  return { origem: "maps", teamId, lote: crypto.randomUUID(), termo: `teste ${n}`, limite: 40 };
}
const item = (nome: string) => ({ nome, empresa: nome, telefone: null, extra: { endereco: null } });

async function rascunhos(teamId: string, lote: string) {
  return basePrisma.prospectDraft.findMany({ where: { teamId, lote }, orderBy: { nome: "asc" } });
}

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Captação A (test)"], [OUTRO, "Team Captação B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const r = redisEstado();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});

beforeEach(async () => {
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.prospectDraft.deleteMany({ where: { teamId: OUTRO } });
  adicionados.length = 0;
});

describe("executarCaptura — status e gravação", () => {
  it("grava aos poucos no time do job e termina 'concluída'; o status é só do time", async () => {
    const job = jobMaps();
    const vistosNoMeio: (string | undefined)[] = [];
    const st = await executarCaptura(job, async (ctx: ContextoColeta) => {
      await ctx.gravar([item("Agro A"), item("Agro B")]);
      ctx.progresso(2);
      // No meio da coleta o que já veio está no banco e o status diz "rodando".
      vistosNoMeio.push((await lerStatusCaptura(TEAM, job.lote))?.estado);
      expect(await rascunhos(TEAM, job.lote)).toHaveLength(2);
      await ctx.gravar([item("Agro C")]);
      ctx.progresso(3);
      return { interrupcao: null };
    });
    expect(vistosNoMeio).toEqual(["rodando"]);
    expect(st).toMatchObject({ estado: "concluida", criados: 3, processados: 3, motivo: null });
    expect((await rascunhos(TEAM, job.lote)).map((r) => r.nome)).toEqual(["Agro A", "Agro B", "Agro C"]);
    expect(await rascunhos(OUTRO, job.lote)).toHaveLength(0);

    // Dois times: o lote do A não existe para o B.
    expect(await runWithTeam(TEAM, () => statusDaCaptura(job.lote))).toMatchObject({ estado: "concluida", criados: 3 });
    expect(await runWithTeam(OUTRO, () => statusDaCaptura(job.lote))).toBeNull();
    // Sem contexto de time ou com lote que não é uuid: null (fail-closed).
    expect(await statusDaCaptura(job.lote)).toBeNull();
    expect(await runWithTeam(TEAM, () => statusDaCaptura("*"))).toBeNull();
  });

  it("terminar sem nada é 'vazia' (com o motivo), não 'concluída'", async () => {
    const job = jobMaps();
    const st = await executarCaptura(job, async () => ({ interrupcao: null }));
    expect(st).toMatchObject({ estado: "vazia", motivo: "sem_resultados", criados: 0 });
    expect(st.mensagem).toMatch(/Nenhum resultado/);
  });

  it("bloqueio do Google com parcial: o parcial fica gravado, status 'parcial' e o job FALHA (visível)", async () => {
    const job = jobMaps();
    await expect(
      executarCaptura(job, async (ctx) => {
        await ctx.gravar([item("Antes do bloqueio 1"), item("Antes do bloqueio 2")]);
        return { interrupcao: { motivo: "bloqueio_google", detalhe: "sorry" } };
      }),
    ).rejects.toBeInstanceOf(CapturaFalhou);
    expect(await rascunhos(TEAM, job.lote)).toHaveLength(2);
    const st = await lerStatusCaptura(TEAM, job.lote);
    expect(st).toMatchObject({ estado: "parcial", motivo: "bloqueio_google", criados: 2 });
    expect(st?.mensagem).toMatch(/Google bloqueou/);
  });

  it("bloqueio logo na busca: 'falhou' com o motivo", async () => {
    const job = jobMaps();
    await expect(executarCaptura(job, async () => ({ interrupcao: { motivo: "bloqueio_google", detalhe: "captcha" } }))).rejects.toMatchObject({
      motivo: "bloqueio_google",
    });
    expect(await lerStatusCaptura(TEAM, job.lote)).toMatchObject({ estado: "falhou", motivo: "bloqueio_google" });
  });

  it("teto de tempo com parcial: 'parcial' e o job NÃO falha (o que veio está na fila)", async () => {
    const job = jobMaps();
    const st = await executarCaptura(job, async (ctx) => {
      await ctx.gravar([item("Lido antes do teto")]);
      return { interrupcao: { motivo: "tempo_esgotado", detalhe: "15 min" } };
    });
    expect(st).toMatchObject({ estado: "parcial", motivo: "tempo_esgotado", criados: 1 });
  });

  it("erro inesperado no meio: parcial preservado, status 'parcial' com a causa e o job falha", async () => {
    const job = jobMaps();
    await expect(
      executarCaptura(job, async (ctx) => {
        await ctx.gravar([item("Já gravado")]);
        throw new Error("Target page, context or browser has been closed");
      }),
    ).rejects.toMatchObject({ name: "CapturaFalhou", motivo: "erro" });
    expect(await rascunhos(TEAM, job.lote)).toHaveLength(1);
    const st = await lerStatusCaptura(TEAM, job.lote);
    expect(st).toMatchObject({ estado: "parcial", motivo: "erro", criados: 1 });
    expect(st?.mensagem).toMatch(/browser has been closed/);
  });
});

describe("executarCaptura — status bate com o banco", () => {
  it("gravação que falha no meio de um bloco: o status conta o que ficou no banco (não o contador em memória)", async () => {
    const job = jobMaps();
    await expect(
      executarCaptura(job, async (ctx) => {
        await ctx.gravar([item("Contado 1"), item("Contado 2")]);
        // Simula um insertDrafts que gravou 1 linha e caiu antes de devolver a contagem.
        await basePrisma.prospectDraft.create({ data: { teamId: TEAM, origem: "maps", lote: job.lote, nome: "Gravado sem contar" } });
        throw new Error("conexão com o banco caiu");
      }),
    ).rejects.toBeInstanceOf(CapturaFalhou);
    expect(await lerStatusCaptura(TEAM, job.lote)).toMatchObject({ estado: "parcial", criados: 3 });
  });

  it("job retomado: o 'criados' vem do banco, mesmo com o status salvo atrasado", async () => {
    const job = jobMaps();
    const atrasado = novoStatusCaptura({ lote: job.lote, origem: "maps", estado: "rodando" });
    atrasado.criados = 0; // a queda veio antes de o status registrar a gravação
    await salvarStatusCaptura(TEAM, atrasado);
    await basePrisma.prospectDraft.create({ data: { teamId: TEAM, origem: "maps", lote: job.lote, nome: "Já gravado" } });
    await expect(executarCaptura(job, vi.fn())).resolves.toMatchObject({ estado: "parcial", motivo: "interrompida", criados: 1 });
  });
});

describe("executarCaptura — job devolvido à fila", () => {
  it("retomado após queda do worker (status 'rodando'): NÃO raspa de novo; fecha como interrompido com o que já veio", async () => {
    const job = jobMaps();
    const antes = novoStatusCaptura({ lote: job.lote, origem: "maps", estado: "rodando", total: 40 });
    antes.criados = 7;
    await salvarStatusCaptura(TEAM, antes);
    await basePrisma.prospectDraft.createMany({
      data: Array.from({ length: 7 }, (_, k) => ({ teamId: TEAM, origem: "maps", lote: job.lote, nome: `Antes da queda ${k}` })),
    });
    const coletor = vi.fn(async () => ({ interrupcao: null }));
    const st = await executarCaptura(job, coletor);
    expect(coletor).not.toHaveBeenCalled();
    expect(st).toMatchObject({ estado: "parcial", motivo: "interrompida", criados: 7 });
  });

  it("retomado sem nada gravado: 'falhou' e o job falha", async () => {
    const job = jobMaps();
    await salvarStatusCaptura(TEAM, novoStatusCaptura({ lote: job.lote, origem: "maps", estado: "rodando" }));
    const coletor = vi.fn(async () => ({ interrupcao: null }));
    await expect(executarCaptura(job, coletor)).rejects.toMatchObject({ motivo: "interrompida" });
    expect(coletor).not.toHaveBeenCalled();
  });

  it("re-entrega de lote já terminado é idempotente", async () => {
    const job = jobMaps();
    const fim = novoStatusCaptura({ lote: job.lote, origem: "maps", estado: "concluida" });
    fim.criados = 3;
    await salvarStatusCaptura(TEAM, fim);
    const coletor = vi.fn(async () => ({ interrupcao: null }));
    await expect(executarCaptura(job, coletor)).resolves.toMatchObject({ estado: "concluida", criados: 3 });
    expect(coletor).not.toHaveBeenCalled();
  });
});

describe("enqueueCapture", () => {
  it("grava 'na fila' antes do job e usa jobId sem ':' (um job por lote)", async () => {
    const job = jobMaps();
    await enqueueCapture(job);
    expect(await runWithTeam(TEAM, () => statusDaCaptura(job.lote))).toMatchObject({ estado: "na_fila", total: 40, origem: "maps" });
    expect(adicionados).toHaveLength(1);
    expect(adicionados[0]!.opts.jobId).toBe(`captura_${job.lote}`);
    expect(adicionados[0]!.opts.jobId).not.toContain(":");
  });
});
