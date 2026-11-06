import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import IORedis from "ioredis";
import { basePrisma } from "@crmagro/db";
import { env } from "@crmagro/config";
import { runWithTeam } from "../test-support/identidade";
import { logger } from "../logger/index";
import { ForbiddenError } from "../auth/authz";

/**
 * Token do webhook de fluxo em HASH (programa de segurança de outubro, 10/2026).
 *
 * Prova, com banco de TESTE e Redis de teste, que:
 *  - o banco guarda só o sha256 do token (com `FLOW_WEBHOOK_TOKEN_HASH=on`) e o texto aparece uma única vez, ao gerar;
 *  - o lookup é pelo hash; regenerar invalida o token anterior; token errado e token de outro time não entram;
 *  - editar, salvar, ativar, pausar e reativar NUNCA trocam nem regeneram o token;
 *  - nenhum retorno de serviço (DTO), log, snapshot de versão ou chave de limite carrega o token, o hash ou o espelho;
 *  - fluxo antigo (só texto, sem hash) segue funcionando e ganha o hash sozinho.
 * Cada teste de segurança foi conferido contra o código sem a correção (ver o corpo do PR).
 * Fila do motor mockada: nada é enviado.
 */
const scheduleStep = vi.fn();
vi.mock("./queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const {
  activateFlow,
  archiveFlow,
  createFlow,
  enrollByWebhook,
  getFlow,
  lerWebhookDoFluxo,
  listFlows,
  listFlowsWithMetrics,
  pauseFlow,
  regenerateWebhookToken,
  updateFlow,
  updateFlowSettings,
} = await import("./service");
const { chaveDoLimiteDoWebhook, hashDoWebhookToken, hashesDoWebhookIguais, tirarSegredosDoFluxo, triggerConfigSemToken, WEBHOOK_TOKEN_RE } = await import("./webhook-token");
const { rateLimit } = await import("../rate-limit/service");

const TEAM_A = "00000000-0000-0000-0000-0000000000a1";
const TEAM_B = "00000000-0000-0000-0000-0000000000b1";
const TIMES = [TEAM_A, TEAM_B];
let seq = 0;
// Id de nó é chave global (FlowNode.id): cada fluxo do teste usa um id novo.
const noUnico = () => [{ id: `wh-hash-${Date.now()}-${seq++}`, tipo: "wait", config: { minutos: 1 }, nextNodeId: null }] as never;
const VIEWER = { userId: "viewer-teste", role: "viewer" } as const;

/** Cria um fluxo Webhook (sem URL) e já gera o token pelo caminho real. */
async function fluxoComUrl(teamId = TEAM_A, nome = "W") {
  const f = await runWithTeam(teamId, () => createFlow({ nome, triggerType: "webhook", nodes: noUnico() }));
  const { webhookToken } = await runWithTeam(teamId, () => regenerateWebhookToken(f.id));
  return { id: f.id, token: webhookToken };
}
const linha = (id: string) => basePrisma.flow.findUniqueOrThrow({ where: { id } });
const tudo = (x: unknown) => JSON.stringify(x);

beforeAll(async () => {
  for (const id of TIMES) {
    await basePrisma.team.upsert({ where: { id }, update: { name: `Time ${id.slice(-2)} (webhook hash)` }, create: { id, name: `Time ${id.slice(-2)} (webhook hash)` } });
  }
});

beforeEach(async () => {
  scheduleStep.mockClear();
  process.env.FLOW_WEBHOOK_TOKEN_HASH = "on";
  const w = { teamId: { in: TIMES } };
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowVersion.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});
afterEach(() => {
  process.env.FLOW_WEBHOOK_TOKEN_HASH = "";
  vi.restoreAllMocks();
});

describe("o hash", () => {
  it("é o sha256 hex do token (vetor conhecido)", () => {
    expect(hashDoWebhookToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashDoWebhookToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o Postgres calcula o MESMO hash que o Node (é o que o backfill da migration usa)", async () => {
    for (const texto of ["abc", "Zm9vYmFyLXRva2VuLWRlLXRlc3RlLTAwMDAwMA", "token-com-acentuação-çãé", "x".repeat(64)]) {
      const [r] = await basePrisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(convert_to(${texto}, 'UTF8')), 'hex') AS h`;
      expect(r!.h, texto).toBe(hashDoWebhookToken(texto));
    }
  });

  it("o SQL de backfill da própria migration preenche o hash dos tokens atuais, só uma vez, e as URLs antigas valem", async () => {
    const sql = readFileSync(join(__dirname, "..", "..", "..", "db", "prisma", "migrations", "20261007130000_flow_webhook_token_hash", "migration.sql"), "utf8");
    const update = /UPDATE "Flow"[\s\S]*?;/.exec(sql)?.[0];
    expect(update, "UPDATE do backfill na migration").toBeTruthy();
    const antigo = "tokantigo-tokantigo-tokantigo-0001";
    const f = await basePrisma.flow.create({ data: { teamId: TEAM_A, nome: "pré-hash", triggerType: "webhook", status: "active", webhookToken: antigo } });
    const jaTemHash = await basePrisma.flow.create({
      data: { teamId: TEAM_A, nome: "já tem hash", triggerType: "webhook", webhookToken: "tokantigo-tokantigo-tokantigo-0002", webhookTokenHash: "hash-que-o-backfill-nao-pode-mexer" },
    });
    const semToken = await basePrisma.flow.create({ data: { teamId: TEAM_A, nome: "sem token", triggerType: "manual" } });

    await basePrisma.$executeRawUnsafe(update!);
    expect((await linha(f.id)).webhookTokenHash).toBe(hashDoWebhookToken(antigo));
    expect((await linha(f.id)).webhookToken).toBe(antigo); // a migration NÃO apaga o texto
    expect((await linha(jaTemHash.id)).webhookTokenHash).toBe("hash-que-o-backfill-nao-pode-mexer");
    expect((await linha(semToken.id)).webhookTokenHash).toBeNull();
    expect(await basePrisma.$executeRawUnsafe(update!)).toBe(0); // idempotente

    // A URL que já estava distribuída continua valendo (agora pelo hash).
    await basePrisma.flowNode.create({ data: { id: `bf-${f.id}`, teamId: TEAM_A, flowId: f.id, tipo: "wait" as never, config: {} as never } });
    expect((await enrollByWebhook(antigo, { telefone: "11999990001" })).ok).toBe(true);
  });

  it("comparação de hashes em tempo constante: igual, diferente, tamanho diferente e vazio", () => {
    const h = hashDoWebhookToken("t");
    expect(hashesDoWebhookIguais(h, h)).toBe(true);
    expect(hashesDoWebhookIguais(hashDoWebhookToken("u"), h)).toBe(false);
    expect(hashesDoWebhookIguais(h.slice(1), h)).toBe(false);
    expect(hashesDoWebhookIguais(null, h)).toBe(false);
    expect(hashesDoWebhookIguais("", h)).toBe(false);
  });
});

describe("o que o banco guarda", () => {
  it("chave ligada: só o hash. Sem texto puro, sem espelho no triggerConfig; o texto vem uma vez, na resposta", async () => {
    const f = await runWithTeam(TEAM_A, () => createFlow({ nome: "W", triggerType: "webhook", triggerConfig: { janelaEnvio: { modo: "empresa" } }, nodes: noUnico() }));
    const antes = Date.now();
    const { webhookToken, geradoEm } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(f.id));
    expect(webhookToken).toMatch(WEBHOOK_TOKEN_RE);
    const gravado = await linha(f.id);
    expect(gravado.webhookToken).toBeNull();
    expect(gravado.webhookTokenHash).toBe(hashDoWebhookToken(webhookToken));
    expect(gravado.webhookTokenGeradoEm!.getTime()).toBe(geradoEm.getTime());
    expect(geradoEm.getTime()).toBeGreaterThanOrEqual(antes - 1000);
    // O token não está em lugar nenhum da linha (nem no JSON do gatilho), e as outras chaves do gatilho ficam.
    expect(tudo(gravado)).not.toContain(webhookToken);
    expect(gravado.triggerConfig).toEqual({ janelaEnvio: { modo: "empresa" } });
  });

  it("chave desligada (padrão): grava o hash SEMPRE, e o texto + espelho também (voltar a versão não derruba URL)", async () => {
    process.env.FLOW_WEBHOOK_TOKEN_HASH = "";
    const f = await runWithTeam(TEAM_A, () => createFlow({ nome: "W", triggerType: "webhook", nodes: noUnico() }));
    const { webhookToken } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(f.id));
    const gravado = await linha(f.id);
    expect(gravado.webhookTokenHash).toBe(hashDoWebhookToken(webhookToken));
    expect(gravado.webhookToken).toBe(webhookToken);
    expect((gravado.triggerConfig as { webhookToken?: string }).webhookToken).toBe(webhookToken);
    // Ligar a chave depois não invalida a URL: o lookup é sempre pelo hash.
    process.env.FLOW_WEBHOOK_TOKEN_HASH = "on";
    await runWithTeam(TEAM_A, () => activateFlow(f.id));
    expect((await enrollByWebhook(webhookToken, { telefone: "11977770001" })).ok).toBe(true);
  });

  it("regenerar troca o token e o anterior deixa de valer; o hash e a data mudam; o texto novo nunca é o antigo", async () => {
    const { id, token: antigo } = await fluxoComUrl();
    await runWithTeam(TEAM_A, () => activateFlow(id));
    const antes = await linha(id);
    expect((await enrollByWebhook(antigo, { telefone: "11977770002" })).ok).toBe(true);

    const { webhookToken: novo } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(id));
    const depois = await linha(id);
    expect(novo).not.toBe(antigo);
    expect(depois.webhookTokenHash).toBe(hashDoWebhookToken(novo));
    expect(depois.webhookTokenHash).not.toBe(antes.webhookTokenHash);
    expect(depois.webhookTokenGeradoEm!.getTime()).toBeGreaterThanOrEqual(antes.webhookTokenGeradoEm!.getTime());
    expect((await enrollByWebhook(antigo, { telefone: "11977770003" })).ok).toBe(false);
    expect((await enrollByWebhook(novo, { telefone: "11977770004" })).ok).toBe(true);
  });

  it("regenerar um fluxo ANTIGO (texto + espelho) apaga os dois: o texto antigo some do banco", async () => {
    const velho = "tokvelho-tokvelho-tokvelho-tokv01";
    const f = await basePrisma.flow.create({
      data: {
        teamId: TEAM_A,
        nome: "antigo",
        triggerType: "webhook",
        status: "active",
        webhookToken: velho,
        webhookTokenHash: hashDoWebhookToken(velho),
        triggerConfig: { webhookToken: velho, jitterMin: 2 } as never,
        compartilhado: true,
      },
    });
    await basePrisma.flowNode.create({ data: { id: `ant-${f.id}`, teamId: TEAM_A, flowId: f.id, tipo: "wait" as never, config: {} as never } });
    const { webhookToken: novo } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(f.id));
    const depois = await linha(f.id);
    expect(depois.webhookToken).toBeNull();
    expect(tudo(depois)).not.toContain(velho);
    expect(depois.triggerConfig).toEqual({ jitterMin: 2 });
    expect((await enrollByWebhook(velho, { telefone: "11977770005" })).ok).toBe(false);
    expect((await enrollByWebhook(novo, { telefone: "11977770006" })).ok).toBe(true);
  });

  it.each(["on", ""])("editar, salvar, ativar, pausar e reativar NÃO trocam o token (chave %j)", async (chave) => {
    process.env.FLOW_WEBHOOK_TOKEN_HASH = chave;
    const { id, token } = await fluxoComUrl();
    const hash = hashDoWebhookToken(token);
    const mesmo = async () => expect((await linha(id)).webhookTokenHash).toBe(hash);

    await runWithTeam(TEAM_A, () => updateFlow(id, { nome: "Outro nome", triggerType: "webhook", triggerConfig: {} }));
    await mesmo();
    // O editor ANTIGO ainda manda um token no gatilho: o servidor ignora.
    await runWithTeam(TEAM_A, () => updateFlow(id, { triggerType: "webhook", triggerConfig: { webhookToken: "tokdoeditorantigo-tokdoeditorantigo", jitterMin: 1 } }));
    await mesmo();
    expect(tudo(await linha(id))).not.toContain("tokdoeditorantigo");
    await runWithTeam(TEAM_A, () => updateFlow(id, { nodes: noUnico() }));
    await mesmo();
    await runWithTeam(TEAM_A, () => updateFlowSettings(id, { nome: "Menu", janelaEnvio: { modo: "empresa" } }));
    await mesmo();
    await runWithTeam(TEAM_A, () => activateFlow(id));
    await mesmo();
    await runWithTeam(TEAM_A, () => pauseFlow(id));
    await mesmo();
    await runWithTeam(TEAM_A, () => activateFlow(id));
    await mesmo();
    // Trocar o gatilho e voltar também mantém a URL.
    await runWithTeam(TEAM_A, () => updateFlow(id, { triggerType: "manual", triggerConfig: {} }));
    await runWithTeam(TEAM_A, () => updateFlow(id, { triggerType: "webhook", triggerConfig: {} }));
    await mesmo();
    expect((await enrollByWebhook(token, { telefone: "11977770007" })).ok).toBe(true);
  });

  it("fluxo Webhook sem URL gerada não ativa: o servidor não gera sozinho um token que ninguém veria", async () => {
    const f = await runWithTeam(TEAM_A, () => createFlow({ nome: "Sem URL", triggerType: "webhook", nodes: noUnico() }));
    await expect(runWithTeam(TEAM_A, () => activateFlow(f.id))).rejects.toThrow(/gere a URL do webhook/i);
    expect((await linha(f.id)).status).toBe("draft");
    expect((await linha(f.id)).webhookTokenHash).toBeNull();
  });

  it("só quem pode editar fluxos gera a URL (somente leitura é barrado) e fluxo de outro time não existe para quem pede", async () => {
    const { id } = await fluxoComUrl(TEAM_A);
    await expect(runWithTeam(TEAM_A, () => regenerateWebhookToken(id), VIEWER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runWithTeam(TEAM_B, () => regenerateWebhookToken(id))).rejects.toThrow(/FlowNotFound|não encontrado|not found/i);
  });

  it("só gera URL em fluxo cujo gatilho é Webhook", async () => {
    const f = await runWithTeam(TEAM_A, () => createFlow({ nome: "Manual", triggerType: "manual", nodes: noUnico() }));
    await expect(runWithTeam(TEAM_A, () => regenerateWebhookToken(f.id))).rejects.toThrow(/não é Webhook/);
  });
});

describe("lookup pelo hash", () => {
  it("token errado, vazio, malformado ou de fluxo inativo não entra e não grava nada", async () => {
    const { id, token } = await fluxoComUrl(); // rascunho: ainda não está no ar
    for (const ruim of ["", "token-que-nao-existe-00000000000000", "x' OR 1=1 --", token.slice(1), `${token}x`, token.toUpperCase(), hashDoWebhookToken(token)]) {
      expect((await enrollByWebhook(ruim, { telefone: "11911110001" })).ok, ruim.slice(0, 12)).toBe(false);
    }
    expect((await enrollByWebhook(token, { telefone: "11911110001" })).ok).toBe(false); // rascunho
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(0);
    await runWithTeam(TEAM_A, () => activateFlow(id));
    expect((await enrollByWebhook(token, { telefone: "11911110001" })).ok).toBe(true);
  });

  it("o hash NÃO serve de token (quem lê o banco não consegue chamar o webhook com ele)", async () => {
    const { id, token } = await fluxoComUrl();
    await runWithTeam(TEAM_A, () => activateFlow(id));
    const hash = (await linha(id)).webhookTokenHash!;
    expect(hash).toBe(hashDoWebhookToken(token));
    expect((await enrollByWebhook(hash, { telefone: "11911110002" })).ok).toBe(false);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(0);
  });

  it("token de um time entra no time dele e em nenhum outro", async () => {
    const a = await fluxoComUrl(TEAM_A, "A");
    const b = await fluxoComUrl(TEAM_B, "B");
    await runWithTeam(TEAM_A, () => activateFlow(a.id));
    await runWithTeam(TEAM_B, () => activateFlow(b.id));
    expect((await enrollByWebhook(b.token, { nome: "Lead B", telefone: "11922220001" })).ok).toBe(true);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_B } })).toBe(1);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(0);
    expect(await basePrisma.enrollment.count({ where: { flowId: a.id } })).toBe(0);
  });

  it("linha COM hash só entra pelo hash: o texto puro de uma linha com hash não vale", async () => {
    const texto = "tokdotexto-tokdotexto-tokdotexto-01";
    const outro = "tokdohash-tokdohash-tokdohash-0002";
    const f = await basePrisma.flow.create({
      data: { teamId: TEAM_A, nome: "x", triggerType: "webhook", status: "active", webhookToken: texto, webhookTokenHash: hashDoWebhookToken(outro) },
    });
    await basePrisma.flowNode.create({ data: { id: `h1-${f.id}`, teamId: TEAM_A, flowId: f.id, tipo: "wait" as never, config: {} as never } });
    expect((await enrollByWebhook(texto, { telefone: "11933330001" })).ok).toBe(false);
    expect((await enrollByWebhook(outro, { telefone: "11933330001" })).ok).toBe(true);
  });

  it("fluxo ANTIGO (só texto, sem hash) continua valendo e ganha o hash na primeira chamada", async () => {
    const texto = "tokpretexto-tokpretexto-tokprete-01";
    const f = await basePrisma.flow.create({ data: { teamId: TEAM_A, nome: "pré", triggerType: "webhook", status: "active", webhookToken: texto } });
    await basePrisma.flowNode.create({ data: { id: `h2-${f.id}`, teamId: TEAM_A, flowId: f.id, tipo: "wait" as never, config: {} as never } });
    expect((await enrollByWebhook(texto, { telefone: "11944440001" })).ok).toBe(true);
    expect((await linha(f.id)).webhookTokenHash).toBe(hashDoWebhookToken(texto));
    // Depois de apagado o texto (script do dono), segue valendo só pelo hash.
    await basePrisma.flow.update({ where: { id: f.id }, data: { webhookToken: null } });
    expect((await enrollByWebhook(texto, { telefone: "11944440002" })).ok).toBe(true);
  });
});

describe("DTO e retornos: nunca o token, o hash nem o espelho", () => {
  /** Um fluxo no PIOR caso: texto puro + hash + espelho no gatilho, tudo com o mesmo segredo. */
  async function fluxoAntigoNoPiorCaso() {
    const segredo = "toksegredo-toksegredo-toksegredo-01";
    const f = await basePrisma.flow.create({
      data: {
        teamId: TEAM_A,
        nome: "pior caso",
        triggerType: "webhook",
        status: "draft",
        compartilhado: true,
        webhookToken: segredo,
        webhookTokenHash: hashDoWebhookToken(segredo),
        webhookTokenGeradoEm: new Date("2026-10-01T12:00:00Z"),
        triggerConfig: { webhookToken: segredo, janelaEnvio: { modo: "empresa" } } as never,
      },
    });
    await basePrisma.flowNode.create({ data: { id: `dto-${f.id}`, teamId: TEAM_A, flowId: f.id, tipo: "wait" as never, config: {} as never, nextNodeId: null } });
    return { id: f.id, segredo, hash: hashDoWebhookToken(segredo) };
  }

  it("todo retorno do serviço de fluxo vem sem o segredo (leitura, listas, criar, editar, ativar, pausar, arquivar, ajustes)", async () => {
    const { id, segredo, hash } = await fluxoAntigoNoPiorCaso();
    const nova = await fluxoComUrl(TEAM_A, "nova");
    const retornos: Record<string, unknown> = {
      getFlow: await runWithTeam(TEAM_A, () => getFlow(id)),
      getFlowNova: await runWithTeam(TEAM_A, () => getFlow(nova.id)),
      listFlows: await runWithTeam(TEAM_A, () => listFlows({ limit: 50 })),
      listFlowsWithMetrics: await runWithTeam(TEAM_A, () => listFlowsWithMetrics()),
      createFlow: await runWithTeam(TEAM_A, () => createFlow({ nome: "c", triggerType: "webhook", triggerConfig: { webhookToken: segredo }, nodes: noUnico() })),
      updateFlow: await runWithTeam(TEAM_A, () => updateFlow(id, { triggerType: "webhook", triggerConfig: { jitterMin: 1 } })),
      updateFlowSettings: await runWithTeam(TEAM_A, () => updateFlowSettings(id, { nome: "ajuste" })),
      activateFlow: await runWithTeam(TEAM_A, () => activateFlow(id)),
      pauseFlow: await runWithTeam(TEAM_A, () => pauseFlow(id)),
      archiveFlow: await runWithTeam(TEAM_A, () => archiveFlow(id)),
    };
    for (const [nome, valor] of Object.entries(retornos)) {
      const texto = tudo(valor);
      expect(texto, `${nome} traz o token`).not.toContain(segredo);
      expect(texto, `${nome} traz o token novo`).not.toContain(nova.token);
      expect(texto, `${nome} traz o hash`).not.toContain(hash);
      expect(texto, `${nome} traz o hash novo`).not.toContain(hashDoWebhookToken(nova.token));
      expect(texto, `${nome} traz a coluna`).not.toMatch(/"webhookToken(Hash)?"/);
    }
    // O que a tela precisa saber vem resumido, e o resto do fluxo continua inteiro.
    const lido = retornos.getFlow as Awaited<ReturnType<typeof getFlow>>;
    expect(lido.webhookTem).toBe(true);
    expect(lido.nodes.length).toBe(1);
    expect(lido.triggerConfig).toEqual({ janelaEnvio: { modo: "empresa" } });
  });

  it("tirarSegredosDoFluxo e triggerConfigSemToken: tiram só o segredo, não alteram a entrada", () => {
    const entrada = { id: "f", nome: "n", webhookToken: "t", webhookTokenHash: "h", webhookTokenGeradoEm: new Date(0), triggerConfig: { webhookToken: "t", janelaEnvio: 1 } };
    const saida = tirarSegredosDoFluxo(entrada);
    expect(saida).toEqual({ id: "f", nome: "n", triggerConfig: { janelaEnvio: 1 }, webhookTem: true, webhookGeradoEm: new Date(0) });
    expect(entrada.webhookToken).toBe("t"); // a entrada não muda
    expect(entrada.triggerConfig.webhookToken).toBe("t");
    expect(tirarSegredosDoFluxo({ triggerConfig: null }).webhookTem).toBe(false);
    expect(tirarSegredosDoFluxo({ triggerConfig: null }).triggerConfig).toBeNull();
    expect(triggerConfigSemToken(null)).toBeNull();
    expect(triggerConfigSemToken([1])).toEqual([1]);
    expect(triggerConfigSemToken({ a: 1, webhookToken: "x" })).toEqual({ a: 1 });
  });

  it("a leitura da URL para a tela: fluxo antigo mostra o texto a quem edita, nunca ao somente leitura, e NUNCA devolve o hash", async () => {
    const { id, segredo, hash } = await fluxoAntigoNoPiorCaso();
    const dono = await runWithTeam(TEAM_A, () => lerWebhookDoFluxo(id));
    expect(dono.temUrl).toBe(true);
    expect(dono.tokenLegado).toBe(segredo);
    expect(dono.geradaEm?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    const leitor = await runWithTeam(TEAM_A, () => lerWebhookDoFluxo(id), VIEWER);
    expect(leitor.temUrl).toBe(true);
    expect(leitor.tokenLegado).toBeNull();
    expect(tudo(dono)).not.toContain(hash);
    expect(tudo(leitor)).not.toContain(hash);
    // Fluxo novo (só hash): não há texto para mostrar a ninguém.
    const nova = await fluxoComUrl(TEAM_A, "nova");
    const l = await runWithTeam(TEAM_A, () => lerWebhookDoFluxo(nova.id));
    expect(l).toMatchObject({ temUrl: true, tokenLegado: null });
    expect(tudo(l)).not.toContain(nova.token);
    // Fluxo de outro time não existe para quem pede.
    await expect(runWithTeam(TEAM_B, () => lerWebhookDoFluxo(id))).rejects.toThrow();
  });
});

describe("logs sem o token", () => {
  it("gerar, trocar, chamar o webhook (certo e errado) e ativar não deixam token nem hash em nenhum log", async () => {
    const espioes = (["trace", "debug", "info", "warn", "error", "fatal"] as const).map((n) => vi.spyOn(logger, n).mockImplementation((() => undefined) as never));
    const consoles = (["log", "info", "warn", "error", "debug"] as const).map((n) => vi.spyOn(console, n).mockImplementation(() => undefined));
    const { id, token } = await fluxoComUrl();
    await runWithTeam(TEAM_A, () => activateFlow(id));
    await enrollByWebhook(token, { telefone: "11955550001" });
    await enrollByWebhook(`${token}errado`, { telefone: "11955550002" });
    const { webhookToken: novo } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(id));
    await enrollByWebhook(token, { telefone: "11955550003" }); // o antigo, já inválido
    const registrado = tudo([...espioes, ...consoles].flatMap((e) => e.mock.calls));
    for (const segredo of [token, novo, hashDoWebhookToken(token), hashDoWebhookToken(novo)]) {
      expect(registrado).not.toContain(segredo);
    }
    // O espião está ligado de verdade: o log da geração existe, só com ids.
    expect(registrado).toContain("[flow] URL do webhook gerada");
    expect(registrado).toContain(id);
  });
});

describe("limite de requisições sem o token", () => {
  const redis = new IORedis(env.REDIS_URL);
  afterAll(async () => {
    await redis.quit();
  });
  async function chavesDoWebhook(): Promise<string[]> {
    const achadas: string[] = [];
    let cursor = "0";
    do {
      const [prox, lote] = await redis.scan(cursor, "MATCH", "rl:flowhook:*", "COUNT", 500);
      achadas.push(...lote);
      cursor = prox;
    } while (cursor !== "0");
    return achadas;
  }

  it("a chave usa o hash (cortado), nunca o token, e é estável por token", () => {
    const token = "toklimite-toklimite-toklimite-0001";
    const chave = chaveDoLimiteDoWebhook(token);
    expect(chave).toMatch(/^flowhook:t:[0-9a-f]{32}$/);
    expect(chave).not.toContain(token);
    expect(chave).not.toContain(hashDoWebhookToken(token)); // nem o hash inteiro
    expect(chaveDoLimiteDoWebhook(token)).toBe(chave);
    expect(chaveDoLimiteDoWebhook(`${token}2`)).not.toBe(chave);
  });

  it("no Redis (de teste) a chave gravada não contém o token; a chave antiga (com o token) contém, então o teste enxerga o vazamento", async () => {
    const token = `toklimite${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
    const chave = chaveDoLimiteDoWebhook(token);
    await rateLimit(chave, 30, 60_000);
    const depois = await chavesDoWebhook();
    expect(depois.some((k) => k.includes(chave))).toBe(true);
    expect(depois.some((k) => k.includes(token))).toBe(false);
    // Controle: o formato ANTIGO da chave deixaria o token no Redis.
    const antiga = `flowhook:${token.slice(0, 128)}`;
    await rateLimit(antiga, 30, 60_000);
    expect((await chavesDoWebhook()).some((k) => k.includes(token))).toBe(true);
    for (const k of await chavesDoWebhook()) if (k.includes(token) || k.includes(chave)) await redis.del(k);
  });
});

describe("snapshot e versão do fluxo não levam o token", () => {
  it("a versão do grafo e a inscrição guardam só os passos (nem token, nem hash, nem espelho)", async () => {
    const { id, token } = await fluxoComUrl();
    // O PIOR caso: um fluxo antigo com o texto e o espelho também.
    await basePrisma.flow.update({ where: { id }, data: { webhookToken: token, triggerConfig: { webhookToken: token } as never } });
    await runWithTeam(TEAM_A, () => activateFlow(id));
    expect((await enrollByWebhook(token, { telefone: "11966660001" })).ok).toBe(true);
    const versoes = await basePrisma.flowVersion.findMany({ where: { flowId: id } });
    const inscricoes = await basePrisma.enrollment.findMany({ where: { flowId: id } });
    expect(versoes.length).toBeGreaterThan(0);
    expect(inscricoes.length).toBeGreaterThan(0);
    const texto = tudo([versoes, inscricoes]);
    expect(texto).not.toContain(token);
    expect(texto).not.toContain(hashDoWebhookToken(token));
    expect(texto).not.toContain("webhookToken");
  });
});

describe("copiar um fluxo (duplicar)", () => {
  it("o clone nasce SEM URL e o token do original continua sendo só do original", async () => {
    const original = await fluxoComUrl(TEAM_A, "original");
    // O espelho do texto (fluxo antigo) é o que uma cópia ingênua do triggerConfig levaria junto.
    await basePrisma.flow.update({ where: { id: original.id }, data: { triggerConfig: { webhookToken: original.token, jitterMin: 3 } as never } });
    const fonte = await linha(original.id);
    const clone = await runWithTeam(TEAM_A, () =>
      createFlow({ nome: "Cópia", triggerType: fonte.triggerType, triggerConfig: fonte.triggerConfig as Record<string, unknown>, nodes: noUnico() }),
    );
    const gravado = await linha(clone.id);
    expect(clone.webhookTem).toBe(false);
    expect(gravado.webhookToken).toBeNull();
    expect(gravado.webhookTokenHash).toBeNull();
    expect(tudo(gravado)).not.toContain(original.token);
    expect(gravado.triggerConfig).toEqual({ jitterMin: 3 }); // as outras chaves vêm, o segredo não
    // O clone gera o dele, diferente, e o do original segue chamando só o original.
    const { webhookToken: doClone } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(clone.id));
    expect(doClone).not.toBe(original.token);
    expect((await linha(clone.id)).webhookTokenHash).not.toBe((await linha(original.id)).webhookTokenHash);
    await runWithTeam(TEAM_A, () => activateFlow(original.id));
    await runWithTeam(TEAM_A, () => activateFlow(clone.id));
    expect((await enrollByWebhook(original.token, { telefone: "11977771111" })).ok).toBe(true);
    expect(await basePrisma.enrollment.count({ where: { flowId: original.id } })).toBe(1);
    expect(await basePrisma.enrollment.count({ where: { flowId: clone.id } })).toBe(0);
  });
});

describe("código", () => {
  const RAIZ = join(__dirname, "..", "..", "..", "..");
  function arquivos(dir: string, saida: string[] = []): string[] {
    for (const nome of readdirSync(dir)) {
      if (["node_modules", ".next", "dist", "migrations", ".git"].includes(nome)) continue;
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
      else if (/\.(ts|tsx|mjs|js)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
    }
    return saida;
  }
  const fontes = ["apps", "packages"].flatMap((d) => arquivos(join(RAIZ, d))).map((f) => ({ rel: relative(RAIZ, f).replace(/\\/g, "/"), codigo: readFileSync(f, "utf8") }));
  const servico = fontes.find((f) => f.rel === "packages/core/src/flows/service.ts")!;

  it("encontra o código (o teste não pode passar vazio)", () => {
    expect(fontes.length).toBeGreaterThan(200);
    expect(servico.codigo.length).toBeGreaterThan(1000);
  });

  /** Todo objeto `data: { ... }` (create/update de Prisma) do arquivo, com chaves balanceadas. */
  function blocosData(codigo: string): string[] {
    const blocos: string[] = [];
    for (const m of codigo.matchAll(/\bdata:\s*(?:tenantData<[^>]*>\(\s*)?\{/g)) {
      let fundo = 1;
      let k = m.index! + m[0].length;
      while (k < codigo.length && fundo > 0) {
        if (codigo[k] === "{") fundo++;
        else if (codigo[k] === "}") fundo--;
        k++;
      }
      blocos.push(codigo.slice(m.index!, k));
    }
    return blocos;
  }

  it("nenhum `data:` de Prisma grava a coluna `webhookToken` à mão: o texto só entra por dadosDoTokenNovo", () => {
    const semHelper = fontes.filter((f) => f.rel !== "packages/core/src/flows/webhook-token.ts");
    const blocosComToken = semHelper.flatMap((f) => blocosData(f.codigo).filter((b) => /(?:^|[{,\s])webhookToken\s*(?::|,|\})/.test(b)).map((b) => `${f.rel}: ${b.replace(/\s+/g, " ").slice(0, 120)}`));
    expect(blocosComToken).toEqual([]);
    // A prova de que o extrator enxerga a gravação de verdade: ela existe, e vem do helper.
    expect(blocosData(servico.codigo).some((b) => b.includes("...dados"))).toBe(true);
    expect(servico.codigo).toContain("dadosDoTokenNovo(webhookToken)");
  });

  it("o hash só é gravado pelo helper ou pela autocorreção do lookup", () => {
    const semHelper = fontes.filter((f) => f.rel !== "packages/core/src/flows/webhook-token.ts");
    const blocos = semHelper.flatMap((f) => blocosData(f.codigo).filter((b) => /\bwebhookTokenHash\b/.test(b)).map((b) => `${f.rel}: ${b.replace(/\s+/g, " ")}`));
    expect(blocos).toEqual(["packages/core/src/flows/service.ts: data: { webhookTokenHash: hash }"]);
  });

  it("o servidor nunca lê token vindo do cliente (sem proposta, sem escolherWebhookToken, sem triggerConfig.webhookToken de entrada)", () => {
    expect(/escolherWebhookToken|isUniqueWebhookToken|const proposta|proposta:/.test(servico.codigo)).toBe(false);
    expect(/(input|cfg|cfgBase)\??\.(triggerConfig\??\.)?webhookToken/.test(servico.codigo)).toBe(false);
  });

  it("a rota pública do webhook não loga nem monta chave de limite com o token", () => {
    const rota = fontes.find((f) => f.rel === "apps/web/app/api/webhooks/flow/[token]/route.ts")!;
    expect(rota.codigo).toContain("chaveDoLimiteDoWebhook(token)");
    expect(rota.codigo).not.toMatch(/rateLimit\(`flowhook:\$\{token/);
    expect(rota.codigo).not.toMatch(/logger\.|console\./);
  });
});
