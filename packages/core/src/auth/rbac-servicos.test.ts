import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, runWithTeam, runAsSystem } from "@crmagro/db";

/**
 * RBAC nos serviços do core (auditoria S7/N13 — item 0.3).
 *
 * O portão fica no SERVIÇO, não na tela: rota de API, server action e worker
 * passam pelo mesmo lugar. Aqui chamamos os serviços reais com cada papel e
 * conferimos que viewer/member são barrados ANTES de qualquer escrita.
 *
 * Fila do motor mockada (enfileirar de verdade enviaria WhatsApp real).
 */
const scheduleStep = vi.fn();
vi.mock("../flows/queue", () => ({
  scheduleStep: (...args: unknown[]) => scheduleStep(...args),
  getFlowQueue: () => ({}),
}));

const { ForbiddenError } = await import("./authz");
const { create, removeMany, importCsv, mergeContacts } = await import("../contacts/service");
const { fetchContactsForExport } = await import("../contacts/export");
const { createDeal } = await import("../funnels/service");
const { activateFlow, enroll, enrollByWebhook } = await import("../flows/service");
const { sendMessage, deleteConversation } = await import("../conversations/service");
const { createRelayToken } = await import("../relay/tokens");
const { connectSocialAccount } = await import("../social/service");
const { createTag } = await import("../tags/service");
const { modoEfetivoIa } = await import("../ai/agent");

const TEAM = "00000000-0000-0000-0000-0000000000c9";
const como = (role: string) => ({ userId: `user-${role}`, role });
const VIEWER = como("viewer");
const MEMBER = como("member");
const ADMIN = como("admin");

beforeAll(async () => {
  await basePrisma.team.upsert({
    where: { id: TEAM },
    update: { name: "Team RBAC (test)" },
    create: { id: TEAM, name: "Team RBAC (test)" },
  });
  // Usuários de verdade (F3): o contato que o membro cria é DELE, e o negócio
  // desse contato passa pelo escopo por dono.
  for (const role of ["viewer", "member", "admin"]) {
    const id = `user-${role}`;
    await basePrisma.user.upsert({ where: { id }, update: { teamId: TEAM, role }, create: { id, teamId: TEAM, role, name: role, email: `${id}@rbac.test` } });
  }
});

beforeEach(async () => {
  scheduleStep.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.deal.deleteMany({ where: w });
  await basePrisma.stage.deleteMany({ where: w });
  await basePrisma.funnel.deleteMany({ where: w });
  await basePrisma.contactTag.deleteMany({ where: w });
  await basePrisma.tag.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.relayAgentToken.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
});

async function contato(nome = "Fulano") {
  return basePrisma.contact.create({ data: { teamId: TEAM, nome } });
}

async function fluxoRascunho() {
  const flow = await basePrisma.flow.create({
    data: { teamId: TEAM, nome: "Fluxo", triggerType: "manual", status: "draft" },
  });
  await basePrisma.flowNode.create({
    data: { id: `n-${flow.id}`, teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never },
  });
  return flow;
}

describe("viewer só lê", () => {
  it("não cria, não apaga, não importa, não exporta contato", async () => {
    const c = await contato();
    await runWithTeam(
      TEAM,
      async () => {
        await expect(create({ nome: "Novo" } as never)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(removeMany([c.id])).rejects.toBeInstanceOf(ForbiddenError);
        await expect(importCsv("nome,telefone\nA,11999990000")).rejects.toBeInstanceOf(ForbiddenError);
        await expect(fetchContactsForExport({})).rejects.toBeInstanceOf(ForbiddenError);
      },
      VIEWER,
    );
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(1);
  });

  it("não envia mensagem, não ativa nem inscreve em fluxo, não gera token nem conecta social", async () => {
    const c = await contato();
    const flow = await fluxoRascunho();
    await runWithTeam(
      TEAM,
      async () => {
        await expect(sendMessage("qualquer", "oi")).rejects.toBeInstanceOf(ForbiddenError);
        await expect(activateFlow(flow.id)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(enroll(c.id, flow.id)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(createRelayToken({ label: "x" })).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          connectSocialAccount({ canal: "instagram", label: "x", cookie: "sessionid=1" } as never),
        ).rejects.toBeInstanceOf(ForbiddenError);
        await expect(createTag({ nome: "T" })).rejects.toBeInstanceOf(ForbiddenError);
      },
      VIEWER,
    );
    expect(scheduleStep).not.toHaveBeenCalled();
    expect(await basePrisma.relayAgentToken.count({ where: { teamId: TEAM } })).toBe(0);
  });
});

describe("member opera o dia a dia, mas não o que é destrutivo/em massa", () => {
  it("cria contato e negócio", async () => {
    const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "F", tipo: "vendas" } });
    const etapa = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "E", ordem: 0 } });
    await runWithTeam(
      TEAM,
      async () => {
        const { id } = (await create({ nome: "Novo" } as never)) as { id: string };
        const deal = await createDeal({ funnelId: funil.id, stageId: etapa.id, contactId: id });
        expect(deal.teamId).toBe(TEAM);
      },
      MEMBER,
    );
  });

  it("não apaga em massa, não exporta, não unifica, não ativa fluxo, não apaga conversa, não gera token", async () => {
    const a = await contato("A");
    const b = await contato("B");
    const flow = await fluxoRascunho();
    await runWithTeam(
      TEAM,
      async () => {
        await expect(removeMany([a.id, b.id])).rejects.toBeInstanceOf(ForbiddenError);
        await expect(fetchContactsForExport({})).rejects.toBeInstanceOf(ForbiddenError);
        await expect(mergeContacts(a.id, [b.id])).rejects.toBeInstanceOf(ForbiddenError);
        await expect(activateFlow(flow.id)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(deleteConversation("qualquer")).rejects.toBeInstanceOf(ForbiddenError);
        await expect(createRelayToken({ label: "x" })).rejects.toBeInstanceOf(ForbiddenError);
      },
      MEMBER,
    );
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(2);
  });
});

describe("admin", () => {
  it("apaga em massa e exporta", async () => {
    const a = await contato("A");
    await runWithTeam(
      TEAM,
      async () => {
        expect((await fetchContactsForExport({})).length).toBe(1);
        expect(await removeMany([a.id])).toEqual({ deleted: 1 });
      },
      ADMIN,
    );
  });
});

describe("sem identidade e sistema", () => {
  it("contexto só com teamId (sem papel) é negado — fail-closed", async () => {
    await runWithTeam(TEAM, async () => {
      await expect(create({ nome: "Novo" } as never)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it("o sistema (motor/webhook) escreve em nome do time", async () => {
    await runAsSystem(TEAM, async () => {
      await expect(create({ nome: "Do motor" } as never)).resolves.toBeTruthy();
    });
    // Webhook de fluxo: entra sem sessão e abre o contexto do sistema sozinho.
    const flow = await basePrisma.flow.create({
      data: {
        teamId: TEAM,
        nome: "Webhook",
        triggerType: "webhook",
        status: "active",
        webhookToken: "tokrbac-tokrbac-tokrbac-tokrbac-01",
        triggerConfig: { webhookToken: "tokrbac-tokrbac-tokrbac-tokrbac-01" } as never,
      },
    });
    await basePrisma.flowNode.create({
      data: { id: `w-${flow.id}`, teamId: TEAM, flowId: flow.id, tipo: "wait" as never, config: {} as never },
    });
    expect((await enrollByWebhook("tokrbac-tokrbac-tokrbac-tokrbac-01", { nome: "Lead", telefone: "11955554444" })).ok).toBe(true);
    expect(scheduleStep).toHaveBeenCalledTimes(1);
  });
});

describe("IA: a escrita depende do papel de quem pede (S16)", () => {
  it("viewer e job sem identidade ficam só leitura; member mantém a escrita", () => {
    runWithTeam(TEAM, () => expect(modoEfetivoIa("read_write")).toBe("read_only"), VIEWER);
    runWithTeam(TEAM, () => expect(modoEfetivoIa("read_write")).toBe("read_only"));
    runWithTeam(TEAM, () => expect(modoEfetivoIa("read_write")).toBe("read_write"), MEMBER);
    runWithTeam(TEAM, () => expect(modoEfetivoIa("off")).toBe("off"), MEMBER);
  });
});
