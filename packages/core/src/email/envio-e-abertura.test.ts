import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { basePrisma, encryptCredentials } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Item 3.4 (INT-21, S19) — lado do ENVIO: endereço inválido por bounce não
 * recebe de novo (o `send_email` pula antes da cota), resposta sai na mesma
 * thread, e o pixel de abertura ignora scanner, pré-carga e mensagem que não é
 * e-mail. O SMTP é MOCKADO: nenhum e-mail sai de verdade.
 */
vi.mock("../flows/queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));
const smtp = vi.hoisted(() => {
  let n = 0;
  return { send: vi.fn(async (_input: unknown) => ({ providerMessageId: `<env-${Date.now()}-${n++}@teste>` })) };
});
vi.mock("@crmagro/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@crmagro/channels")>();
  return { ...real, getChannelProvider: () => ({ send: smtp.send }) };
});

const { executeNode } = await import("../flows/executor");
const { sendEmail, replyEmailInConversation, markEmailOpened } = await import("./service");
const { classificarAbertura } = await import("./pixel");
const { redisEstado } = await import("../shared/redis-cache");

const TEAM = "00000000-0000-0000-0000-0000000003a6";
const sufixo = Math.random().toString(36).slice(2, 8);
const PRINCIPAL = `principal.${sufixo}@cliente.test`;
const RESERVA = `reserva.${sufixo}@cliente.test`;
let contaId = "";
let contatoId = "";

const emTime = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn);
const usoDoDia = async () =>
  (await basePrisma.channelAccountUsage.findFirst({ where: { channelAccountId: contaId } }))?.sent ?? 0;
const marcar = (valor: string) =>
  basePrisma.channelIdentifier.updateMany({
    where: { teamId: TEAM, valor },
    data: { invalido: true, invalidoMotivo: "5.1.1 — 550 User unknown" },
  });

async function limpar() {
  const w = { teamId: TEAM };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelAccountUsage.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "E-mail 3.4 (3a6)" } });
});

beforeEach(async () => {
  smtp.send.mockClear();
  await limpar();
  const conta = await basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "email",
      label: "Comercial",
      provider: "smtp",
      status: "connected",
      credentials: encryptCredentials({
        host: "smtp.crmagro.test",
        port: 465,
        secure: true,
        user: `u-${sufixo}`,
        pass: "x",
        from: "vendas@crmagro.test",
      }) as unknown as Prisma.InputJsonValue,
    },
  });
  contaId = conta.id;
  await redisEstado().del(`email:espaco:${contaId}`);
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  contatoId = c.id;
  await redisEstado().del(`flow:contact:${c.id}:sends`);
  await basePrisma.channelIdentifier.create({
    data: { teamId: TEAM, contactId: c.id, canal: "email", valor: PRINCIPAL, isPrimary: true },
  });
});

afterAll(async () => {
  await limpar();
});

const node = { id: "mail", tipo: "send_email", config: { subject: "Oi", body: "Olá {nome}" }, nextNodeId: "fim" } as never;
const ctx = () => ({
  id: "e",
  teamId: TEAM,
  contactId: contatoId,
  lastOutboundAt: null,
  contact: { id: contatoId, nome: "Lead", tags: [], ownerId: null, email: PRINCIPAL },
});

describe("send_email com endereço inválido (bounce)", () => {
  it("pula ANTES da cota, do espaçamento e do limite do contato — não gasta nada", async () => {
    await marcar(PRINCIPAL);
    const r = await emTime(() => executeNode(ctx(), node));
    expect(r).toMatchObject({ nextNodeId: "fim", skipped: true });
    expect(r.motivo).toContain("inválido (bounce)");
    expect(r.motivo).toContain("5.1.1");
    expect(smtp.send).not.toHaveBeenCalled();
    expect(await usoDoDia()).toBe(0);
    expect(await redisEstado().get(`email:espaco:${contaId}`)).toBeNull();
    expect(await redisEstado().get(`flow:contact:${contatoId}:sends`)).toBeNull();
  });

  it("com outro e-mail válido no contato, envia para ele", async () => {
    await basePrisma.channelIdentifier.create({
      data: { teamId: TEAM, contactId: contatoId, canal: "email", valor: RESERVA, isPrimary: false },
    });
    await marcar(PRINCIPAL);
    const r = await emTime(() => executeNode(ctx(), node));
    expect(r.skipped).toBeFalsy();
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(smtp.send.mock.calls[0]![0]).toMatchObject({ to: RESERVA });
    expect(await usoDoDia()).toBe(1);
  });

  it("envio manual para contato só com endereço inválido é recusado sem sair", async () => {
    await marcar(PRINCIPAL);
    await expect(emTime(() => sendEmail(contatoId, { subject: "Oi", body: "oi" }))).rejects.toMatchObject({
      name: "ChannelSendFailed",
      outcome: "not_sent",
      retryable: false,
    });
    expect(smtp.send).not.toHaveBeenCalled();
  });
});

describe("resposta na mesma thread", () => {
  it("replyEmailInConversation manda In-Reply-To e References do último e-mail recebido", async () => {
    const conv = await basePrisma.conversation.create({
      data: { teamId: TEAM, contactId: contatoId, canal: "email", channelAccountId: contaId, status: "open" },
    });
    await basePrisma.message.create({
      data: {
        teamId: TEAM,
        conversationId: conv.id,
        direcao: "in",
        tipo: "text",
        conteudo: "tenho interesse",
        providerMessageId: `<resp-${sufixo}@cliente.test>`,
        status: "read",
        meta: { subject: "Re: Proposta", references: [`<prop-${sufixo}@crmagro.test>`] },
      },
    });
    await emTime(() => replyEmailInConversation(conv.id, "Ótimo, vamos marcar", "Re: Proposta"));
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(smtp.send.mock.calls[0]![0]).toMatchObject({
      content: {
        subject: "Re: Proposta",
        inReplyTo: `<resp-${sufixo}@cliente.test>`,
        references: [`<prop-${sufixo}@crmagro.test>`, `<resp-${sufixo}@cliente.test>`],
      },
    });
  });
});

describe("assinatura por caixa no envio (28/09)", () => {
  it("anexa a assinatura da caixa QUE ENVIA — a de outra caixa vira a padrão desta", async () => {
    const outra = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "email", label: "Outra caixa", provider: "smtp", status: "connected" },
    });
    await basePrisma.emailSignature.createMany({
      data: [
        { id: `sig-desta-${sufixo}`, teamId: TEAM, channelAccountId: contaId, nome: "Desta", html: "<p>ASSINATURA-DESTA</p>", isDefault: true },
        { id: `sig-outra-${sufixo}`, teamId: TEAM, channelAccountId: outra.id, nome: "Outra", html: "<p>ASSINATURA-OUTRA</p>", isDefault: true },
      ],
    });
    const html = () => (smtp.send.mock.calls.at(-1)![0] as { content: { html: string } }).content.html;

    await emTime(() => sendEmail(contatoId, { subject: "Oi", body: "oi", channelAccountId: contaId, signatureId: `sig-desta-${sufixo}` }));
    expect(html()).toContain("ASSINATURA-DESTA");

    await emTime(() => sendEmail(contatoId, { subject: "Oi", body: "oi", channelAccountId: contaId, signatureId: `sig-outra-${sufixo}` }));
    expect(html()).toContain("ASSINATURA-DESTA");
    expect(html()).not.toContain("ASSINATURA-OUTRA");

    await emTime(() => sendEmail(contatoId, { subject: "Oi", body: "oi", channelAccountId: contaId }));
    expect(html()).not.toContain("ASSINATURA-");
  });
});

describe("pixel de abertura", () => {
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
  const GMAIL = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

  async function saida(canal: "email" | "whatsapp", enviadaHaMs: number) {
    const conv = await basePrisma.conversation.create({
      data: {
        teamId: TEAM,
        contactId: contatoId,
        canal,
        channelAccountId: contaId,
        status: "open",
      },
    });
    return basePrisma.message.create({
      data: {
        teamId: TEAM,
        conversationId: conv.id,
        direcao: "out",
        tipo: "text",
        conteudo: "oi",
        status: "sent",
        createdAt: new Date(Date.now() - enviadaHaMs),
      },
    });
  }
  const ler = (id: string) => basePrisma.message.findUniqueOrThrow({ where: { id } });

  it("classifica: cedo demais, sem user-agent, scanner, proxy do Gmail e cliente", () => {
    const enviadoEm = new Date("2026-09-26T10:00:00Z");
    const depois = (s: number) => new Date(enviadoEm.getTime() + s * 1000);
    expect(classificarAbertura({ userAgent: CHROME, enviadoEm, agora: depois(20) })).toEqual({ conta: false, motivo: "cedo_demais" });
    expect(classificarAbertura({ userAgent: "", enviadoEm, agora: depois(120) })).toEqual({ conta: false, motivo: "sem_user_agent" });
    for (const ua of ["python-requests/2.31", "Mimecast Link Scanner", "Mozilla/5.0 (compatible; Barracuda)", "curl/8.4.0"]) {
      expect(classificarAbertura({ userAgent: ua, enviadoEm, agora: depois(120) })).toEqual({ conta: false, motivo: "scanner" });
    }
    expect(classificarAbertura({ userAgent: GMAIL, enviadoEm, agora: depois(120) })).toEqual({ conta: true, fonte: "proxy_google" });
    expect(classificarAbertura({ userAgent: CHROME, enviadoEm, agora: depois(120) })).toEqual({ conta: true, fonte: "cliente" });
  });

  it("hit de scanner ou de menos de 60 s não marca; o primeiro válido grava openedAt/openSource e não é sobrescrito", async () => {
    const msg = await saida("email", 30_000);
    await markEmailOpened(msg.id, { userAgent: CHROME });
    expect(await ler(msg.id)).toMatchObject({ status: "sent", openedAt: null });

    const agora = new Date(Date.now() + 60_000);
    await markEmailOpened(msg.id, { userAgent: "Proofpoint URL Defense" }, agora);
    expect(await ler(msg.id)).toMatchObject({ status: "sent", openedAt: null });

    await markEmailOpened(msg.id, { userAgent: GMAIL }, agora);
    const aberta = await ler(msg.id);
    expect(aberta).toMatchObject({ status: "read", openSource: "proxy_google" });
    expect(aberta.openedAt?.getTime()).toBe(agora.getTime());

    await markEmailOpened(msg.id, { userAgent: CHROME }, new Date(agora.getTime() + 3_600_000));
    expect(await ler(msg.id)).toMatchObject({ openSource: "proxy_google", openedAt: agora });
  });

  it("id de mensagem que não é e-mail (WhatsApp) é ignorado (S19)", async () => {
    const msg = await saida("whatsapp", 10 * 60_000);
    expect(await markEmailOpened(msg.id, { userAgent: CHROME })).toBeNull();
    expect(await ler(msg.id)).toMatchObject({ status: "sent", openedAt: null });
  });

  it("não regride e-mail que voltou (bounced)", async () => {
    const msg = await saida("email", 10 * 60_000);
    await basePrisma.message.update({ where: { id: msg.id }, data: { status: "bounced" } });
    await markEmailOpened(msg.id, { userAgent: CHROME });
    expect(await ler(msg.id)).toMatchObject({ status: "bounced", openedAt: null });
  });
});
