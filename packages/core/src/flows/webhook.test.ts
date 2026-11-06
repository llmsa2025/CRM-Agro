import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Webhook de fluxo (auditoria S5 — item 0.6): token do servidor, único, e corpo
 * validado. Fila do motor mockada (nada é enviado de verdade).
 */
const scheduleStep = vi.fn();
vi.mock("./queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { createFlow, updateFlow, activateFlow, regenerateWebhookToken, enrollByWebhook } = await import("./service");
const { parseWebhookLead, WEBHOOK_MAX_CAMPOS } = await import("./webhook-payload");
const { WEBHOOK_TOKEN_RE, hashDoWebhookToken } = await import("./webhook-token");
const { triggerTypeSchema } = await import("./schema");

const TEAM_A = "00000000-0000-0000-0000-0000000000fa";
const TEAM_B = "00000000-0000-0000-0000-0000000000fb";
// Id de nó é chave global (FlowNode.id): cada fluxo do teste usa um id novo.
let seq = 0;
const noUnico = () => [{ id: `wh-n${Date.now()}-${seq++}`, tipo: "wait", config: { minutos: 1 }, nextNodeId: null }] as never;

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (webhook)"],
    [TEAM_B, "Team B (webhook)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  scheduleStep.mockClear();
  const w = { teamId: { in: [TEAM_A, TEAM_B] } };
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

describe("token do servidor", () => {
  it("o fluxo nasce sem URL; só regenerateWebhookToken cria o token (forte, do servidor, com hash no banco)", async () => {
    const f = await runWithTeam(TEAM_A, () =>
      createFlow({ nome: "W", triggerType: "webhook", triggerConfig: { webhookToken: "abc" }, nodes: noUnico() }),
    );
    // Nada de token na criação (nem o "abc" do cliente), e o retorno nunca traz o segredo.
    const semUrl = await basePrisma.flow.findUniqueOrThrow({ where: { id: f.id } });
    expect(semUrl.webhookToken).toBeNull();
    expect(semUrl.webhookTokenHash).toBeNull();
    expect(f.webhookTem).toBe(false);

    const { webhookToken, geradoEm } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(f.id));
    expect(webhookToken).toMatch(WEBHOOK_TOKEN_RE);
    expect(webhookToken).not.toBe("abc");
    const gravado = await basePrisma.flow.findUniqueOrThrow({ where: { id: f.id } });
    expect(gravado.webhookTokenHash).toBe(hashDoWebhookToken(webhookToken));
    expect(gravado.webhookTokenGeradoEm?.getTime()).toBe(geradoEm.getTime());
  });

  it("copiar o token de outro time NÃO sequestra o webhook (o do cliente é ignorado, o fluxo fica sem token)", async () => {
    const b = await runWithTeam(TEAM_B, () => createFlow({ nome: "B", triggerType: "webhook", nodes: noUnico() }));
    const { webhookToken: tokenB } = await runWithTeam(TEAM_B, () => regenerateWebhookToken(b.id));
    const a = await runWithTeam(TEAM_A, () =>
      createFlow({ nome: "A", triggerType: "webhook", triggerConfig: { webhookToken: tokenB }, nodes: noUnico() }),
    );
    expect(a.webhookTem).toBe(false);
    // E numa edição posterior também não pega.
    await runWithTeam(TEAM_A, () => updateFlow(a.id, { triggerType: "webhook", triggerConfig: { webhookToken: tokenB } }));
    const depois = await basePrisma.flow.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois.webhookTokenHash).toBeNull();
    expect(depois.webhookToken).toBeNull();
    expect(JSON.stringify(depois.triggerConfig)).not.toContain(tokenB);
    // Quando A gera o dele, é outro, e o de B continua sendo só do B.
    const { webhookToken: tokenA } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(a.id));
    expect(tokenA).not.toBe(tokenB);
    await runWithTeam(TEAM_B, () => activateFlow(b.id));
    expect((await enrollByWebhook(tokenB, { nome: "Lead", telefone: "11955550000" })).ok).toBe(true);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(0);
  });

  it("editar o fluxo mantém o token; regenerar troca e o antigo para de funcionar", async () => {
    const f = await runWithTeam(TEAM_A, () => createFlow({ nome: "W", triggerType: "webhook", nodes: noUnico() }));
    const { webhookToken: antigo } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(f.id));
    const hashAntes = (await basePrisma.flow.findUniqueOrThrow({ where: { id: f.id } })).webhookTokenHash;
    await runWithTeam(TEAM_A, () => updateFlow(f.id, { nome: "W2", triggerType: "webhook", triggerConfig: {} }));
    expect((await basePrisma.flow.findUniqueOrThrow({ where: { id: f.id } })).webhookTokenHash).toBe(hashAntes);

    await runWithTeam(TEAM_A, () => activateFlow(f.id));
    expect((await enrollByWebhook(antigo, { telefone: "11988887777" })).ok).toBe(true);

    const { webhookToken: novo } = await runWithTeam(TEAM_A, () => regenerateWebhookToken(f.id));
    expect(novo).not.toBe(antigo);
    expect((await enrollByWebhook(antigo, { telefone: "11988887777" })).ok).toBe(false);
    expect((await enrollByWebhook(novo, { telefone: "11977776666" })).ok).toBe(true);
  });

  it("lead do token de B entra no time B (lookup pelo hash)", async () => {
    const b = await runWithTeam(TEAM_B, () => createFlow({ nome: "B", triggerType: "webhook", nodes: noUnico() }));
    const { webhookToken } = await runWithTeam(TEAM_B, () => regenerateWebhookToken(b.id));
    await runWithTeam(TEAM_B, () => activateFlow(b.id));
    expect((await enrollByWebhook(webhookToken, { nome: "Lead", telefone: "11966665555" })).ok).toBe(true);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_B } })).toBe(1);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(0);
  });

  it("token só no triggerConfig (sem coluna) não vale mais; token malformado nem vai ao banco", async () => {
    await basePrisma.flow.create({
      data: {
        teamId: TEAM_A,
        nome: "legado",
        triggerType: "webhook",
        status: "active",
        triggerConfig: { webhookToken: "legado-legado-legado-legado-legado-00" } as never,
      },
    });
    expect((await enrollByWebhook("legado-legado-legado-legado-legado-00", { telefone: "11911112222" })).ok).toBe(false);
    expect((await enrollByWebhook("x' OR 1=1 --", { telefone: "11911112222" })).ok).toBe(false);
  });

  it("gatilho 'webhook' é aceito pelo schema (MF-14)", () => {
    expect(triggerTypeSchema.safeParse("webhook").success).toBe(true);
  });
});

describe("corpo do webhook", () => {
  it("aceita apelidos comuns e normaliza telefone/e-mail", () => {
    const r = parseWebhookLead({ name: "Maria", phone: "(65) 99999-1234", email: "MARIA@EXEMPLO.COM.BR", company: "Fazenda X" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.nome).toBe("Maria");
      expect(r.data.telefone).toMatch(/^\+?55/);
      expect(r.data.email).toBe("maria@exemplo.com.br");
      expect(r.data.empresa).toBe("Fazenda X");
    }
  });

  it("recusa: sem telefone/e-mail válido, texto longo, nome longo, campos demais, objeto aninhado", () => {
    expect(parseWebhookLead({ nome: "Sem contato", telefone: "123" }).ok).toBe(false);
    expect(parseWebhookLead({ telefone: "11999998888", obs: "x".repeat(201) }).ok).toBe(false);
    expect(parseWebhookLead({ telefone: "11999998888", nome: "n".repeat(121) }).ok).toBe(false);
    const muitos = Object.fromEntries(Array.from({ length: WEBHOOK_MAX_CAMPOS + 1 }, (_, i) => [`c${i}`, "v"]));
    expect(parseWebhookLead({ ...muitos, telefone: "11999998888" }).ok).toBe(false);
    expect(parseWebhookLead({ telefone: "11999998888", extra: { a: 1 } }).ok).toBe(false);
    expect(parseWebhookLead([1, 2, 3]).ok).toBe(false);
  });
});
