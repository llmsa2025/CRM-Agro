import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma, encryptCredentials } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * E-mail com cota, aquecimento e espaçamento (item 1.7 — MF-15/INT-06). O
 * provedor SMTP é MOCKADO: nenhum e-mail sai de verdade.
 */
vi.mock("./queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));
const smtp = vi.hoisted(() => {
  let n = 0;
  return { send: vi.fn(async () => ({ providerMessageId: `<m-${Date.now()}-${n++}@teste>` })) };
});
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  return { ...real, getChannelProvider: () => ({ send: smtp.send }) };
});

const { executeNode } = await import("./executor");
const { effectiveDailyLimit, reservarEspacoDeEmail } = await import("../channels-limit/service");
const { redisEstado } = await import("../shared/redis-cache");
const { ChannelSendFailed, transporteSmtpPara } = await import("@crmagro/channels");

const TEAM = "00000000-0000-0000-0000-0000000000ca";
const sufixo = Math.random().toString(36).slice(2, 8);
let contaId = "";
let contatoId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team E-mail (test)" } });
});

beforeEach(async () => {
  smtp.send.mockClear();
  const w = { teamId: TEAM };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelAccountUsage.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  const conta = await basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "email",
      label: "Comercial",
      provider: "smtp",
      status: "connected",
      credentials: encryptCredentials({ host: "smtp.exemplo", port: 465, secure: true, user: `u-${sufixo}`, pass: "x", from: "vendas@exemplo.com.br" }) as never,
    },
  });
  contaId = conta.id;
  await redisEstado().del(`email:espaco:${contaId}`);
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  contatoId = c.id;
  await redisEstado().del(`flow:contact:${c.id}:sends`);
  await basePrisma.channelIdentifier.create({
    data: { teamId: TEAM, contactId: c.id, canal: "email", valor: `lead.${sufixo}@exemplo.com.br`, isPrimary: true },
  });
});

const node = { id: "mail", tipo: "send_email", config: { subject: "Oi", body: "Olá {nome}" }, nextNodeId: null } as never;
const ctx = () => ({
  id: "e",
  teamId: TEAM,
  contactId: contatoId,
  lastOutboundAt: null,
  contact: { id: contatoId, nome: "Lead", tags: [], ownerId: null, email: `lead.${sufixo}@exemplo.com.br` },
});
const usoDoDia = async () =>
  (await basePrisma.channelAccountUsage.findFirst({ where: { channelAccountId: contaId } }))?.sent ?? 0;

describe("aquecimento de e-mail", () => {
  it("rampa própria: 30 → 60 → 120 → 300/dia (WhatsApp segue 20 → … → 400)", () => {
    const now = new Date();
    const dias = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const base = { id: "x", dailyLimit: null, warmupStartedAt: null, paused: false, canal: "email" };
    expect(effectiveDailyLimit({ ...base, createdAt: dias(0) }, now)).toBe(30);
    expect(effectiveDailyLimit({ ...base, createdAt: dias(5) }, now)).toBe(60);
    expect(effectiveDailyLimit({ ...base, createdAt: dias(10) }, now)).toBe(120);
    expect(effectiveDailyLimit({ ...base, createdAt: dias(40) }, now)).toBe(300);
    expect(effectiveDailyLimit({ ...base, canal: "whatsapp", createdAt: dias(40) }, now)).toBe(400);
  });
});

describe("send_email", () => {
  it("envia, conta na cota da conta de e-mail e grava a marca de enviado", async () => {
    const r = await runWithTeam(TEAM, () => executeNode(ctx(), node));
    expect(r.nextNodeId).toBeNull();
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(await usoDoDia()).toBe(1);
  });

  it("segundo e-mail da MESMA conta logo em seguida é espaçado (30–90 s)", async () => {
    await runWithTeam(TEAM, () => executeNode(ctx(), node));
    const r = await runWithTeam(TEAM, () => executeNode(ctx(), node));
    expect(r).toMatchObject({ deferred: true, motivo: "espaçamento entre e-mails da conta" });
    expect(r.delayMs!).toBeGreaterThan(1000);
    expect(r.delayMs!).toBeLessThanOrEqual(105_000);
    expect(smtp.send).toHaveBeenCalledTimes(1);
  });

  it("provedor avisa limite diário (550 5.4.5) → esgota a cota de hoje e adia para o próximo dia", async () => {
    smtp.send.mockImplementationOnce(async () => {
      throw new ChannelSendFailed("SMTP: 550 5.4.5 Daily sending quota exceeded", "not_sent", false, 550);
    });
    const r = await runWithTeam(TEAM, () => executeNode(ctx(), node));
    expect(r).toMatchObject({ deferred: true, motivo: "limite diário do provedor de e-mail" });
    expect(await usoDoDia()).toBe(30); // teto do dia 0 da rampa de e-mail
  });

  it("sem conta de e-mail → pula sem gastar nada", async () => {
    await basePrisma.channelAccount.deleteMany({ where: { teamId: TEAM } });
    const r = await runWithTeam(TEAM, () => executeNode(ctx(), node));
    expect(r).toMatchObject({ skipped: true, motivo: "nenhuma conta de e-mail conectada" });
    expect(smtp.send).not.toHaveBeenCalled();
  });
});

describe("espaçamento e transporte", () => {
  it("reservarEspacoDeEmail: primeira passa, segunda espera o intervalo", async () => {
    const id = `esp-${sufixo}`;
    await redisEstado().del(`email:espaco:${id}`);
    expect(await reservarEspacoDeEmail(id)).toEqual({ ok: true });
    const segunda = await reservarEspacoDeEmail(id);
    expect(segunda.ok).toBe(false);
  });

  it("transporte SMTP reaproveitado por conta (mesmas credenciais = mesmo pool)", () => {
    const cfg = { host: "smtp.x", port: 587, secure: false, user: "a", pass: "1", from: "a@x" };
    expect(transporteSmtpPara(cfg)).toBe(transporteSmtpPara({ ...cfg }));
    expect(transporteSmtpPara(cfg)).not.toBe(transporteSmtpPara({ ...cfg, pass: "2" }));
  });
});
