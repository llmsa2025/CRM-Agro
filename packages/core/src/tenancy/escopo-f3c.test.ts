import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { listConversations, listMessages, markRead, sendMessage, startConversationWithNumber, registerContactForConversation } from "../conversations/service";
import { sendEmail, replyEmailInConversation } from "../email/service";
import { listDealOptionsForContact, createManualCall, listPendingCalls } from "../calls/service";
import { completeManualCall, enroll } from "../flows/service";
import { startCampaign } from "../campaigns/controle";
import { importDrafts } from "../captacao/service";
import { countUnreadConversations } from "../conversations/ultima-mensagem";
import { listEmailAccounts } from "../email/service";
import { listCalls, getCall } from "../calls/service";
import { CallNotFound } from "../calls/errors";
import { listCampaigns, getCampaign, CampaignNotFound } from "../campaigns/service";
import { listFlows, getFlow } from "../flows/service";
import { FlowNotFound } from "../flows/errors";
import { listDrafts, discardDrafts } from "../captacao/service";
import { destinoDoEvento, _limparDestinos } from "../events/destino";
import { OwnedNotFound } from "./assert-owned";
import { redisCache } from "../shared/redis-cache";

/**
 * Escopo por dono (F3c), "dois vendedores do mesmo time": cada um vê as
 * conversas do SEU número, as ligações que ELE fez, as campanhas e os fluxos
 * dele (+ compartilhados) e a fila de captação dele. Master vê tudo. O tempo
 * real vai só para o dono (+ quem vê tudo).
 *
 * Nenhum envio real: o `sendMessage` na conversa alheia é recusado ANTES de
 * resolver o provedor (a conta nem é lida).
 */
const TEAM = "00000000-0000-0000-0000-00000000f3c1";
const sufixo = Math.random().toString(36).slice(2, 7);
let master: { id: string }, a: { id: string }, b: { id: string };
let contaA = "", contaB = "", convA = "", convB = "";
let ligA = "", ligB = "", campA = "", campB = "", campComum = "", fluxoA = "", fluxoB = "", fluxoComum = "";
let rascA = "", rascB = "";
let contatoDoB = "", emailConvB = "", inscricaoNoDoB = "";

const como = <T>(u: { id: string }, role: string, fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: u.id, role });

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Escopo F3c (test)" } });
  const mk = (n: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `${n}-${sufixo}@f3c.dev`, role } });
  master = await mk("master", "owner");
  a = await mk("a", "member");
  b = await mk("b", "member");
  const conta = (dono: { id: string }, label: string, canal: "whatsapp" | "email" = "whatsapp") =>
    basePrisma.channelAccount.create({ data: { teamId: TEAM, canal, label, provider: canal === "email" ? "smtp" : "evolution", ownerId: dono.id, status: "connected" } });
  contaA = (await conta(a, "WhatsApp do A")).id;
  contaB = (await conta(b, "WhatsApp do B")).id;
  await conta(a, "E-mail do A", "email");
  await conta(b, "E-mail do B", "email");
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead", ownerId: master.id, compartilhado: true } });
  const conv = (accountId: string, nome: string) =>
    basePrisma.conversation.create({ data: { teamId: TEAM, canal: "whatsapp", channelAccountId: accountId, externalNumber: `+55659${Date.now() % 1e8}`, externalName: nome, unreadCount: 1 } });
  convA = (await conv(contaA, "Cliente do A")).id;
  convB = (await conv(contaB, "Cliente do B")).id;
  for (const c of [convA, convB]) {
    await basePrisma.message.create({ data: { teamId: TEAM, conversationId: c, direcao: "in", tipo: "text", conteudo: "oi" } });
  }
  const lig = (u: { id: string }) =>
    basePrisma.call.create({ data: { teamId: TEAM, contactId: contato.id, phoneNumber: "+5565999990000", direction: "outbound", provider: "manual", userId: u.id } });
  ligA = (await lig(a)).id;
  ligB = (await lig(b)).id;
  const camp = (nome: string, dono: { id: string }, compartilhado = false) =>
    basePrisma.campaign.create({ data: { teamId: TEAM, nome, createdById: dono.id, compartilhado } });
  campA = (await camp("Campanha do A", a)).id;
  campB = (await camp("Campanha do B", b)).id;
  campComum = (await camp("Campanha do time", master, true)).id;
  const fluxo = (nome: string, dono: { id: string }, compartilhado = false) =>
    basePrisma.flow.create({ data: { teamId: TEAM, nome, triggerType: "manual", createdById: dono.id, compartilhado } });
  fluxoA = (await fluxo("Fluxo do A", a)).id;
  fluxoB = (await fluxo("Fluxo do B", b)).id;
  fluxoComum = (await fluxo("Fluxo do time", master, true)).id;
  const rasc = (dono: { id: string }, nome: string) =>
    basePrisma.prospectDraft.create({ data: { teamId: TEAM, origem: "maps", lote: `l-${sufixo}`, nome, ownerId: dono.id } });
  rascA = (await rasc(a, "Fazenda do A")).id;
  rascB = (await rasc(b, "Fazenda do B")).id;
  // Contato do B (não compartilhado), conversa de e-mail na caixa do B e uma
  // inscrição (tarefa de ligação) no contato do B.
  contatoDoB = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Só do B", ownerId: b.id } })).id;
  const caixaB = await basePrisma.channelAccount.findFirstOrThrow({ where: { teamId: TEAM, label: "E-mail do B" } });
  emailConvB = (await basePrisma.conversation.create({ data: { teamId: TEAM, canal: "email", channelAccountId: caixaB.id, contactId: contatoDoB } })).id;
  inscricaoNoDoB = (await basePrisma.enrollment.create({ data: { teamId: TEAM, flowId: fluxoComum, contactId: contatoDoB, currentNodeId: "n1", status: "waiting" } })).id;
  const chaves = await redisCache().keys(`inbox:naolidas:${TEAM}*`).catch(() => [] as string[]);
  if (chaves.length) await redisCache().del(...chaves);
  _limparDestinos();
});

afterAll(async () => {
  for (const m of ["enrollment", "activity", "channelIdentifier", "message", "conversation", "call", "campaign", "flow", "prospectDraft", "channelAccount", "contact", "user"] as const) {
    await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: TEAM } });
  }
});

describe("F3c — escopo por dono (dois vendedores do mesmo time)", () => {
  it("conversas: cada um vê as do SEU número; a do colega não abre, não marca lida, não envia", async () => {
    const nomes = async (u: { id: string }, role: string, conta: string) =>
      (await como(u, role, () => listConversations(conta))).items.map((c) => c.displayName);
    expect(await nomes(a, "member", contaA)).toEqual(["Cliente do A"]);
    expect(await nomes(a, "member", contaB)).toEqual([]);
    expect(await nomes(master, "owner", contaB)).toEqual(["Cliente do B"]);
    expect((await como(a, "member", () => listMessages(convB))).items).toEqual([]);
    expect((await como(a, "member", () => listMessages(convA))).items).toHaveLength(1);
    await expect(como(a, "member", () => markRead(convB))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(como(a, "member", () => sendMessage(convB, "teste"))).rejects.toThrow("ConversationNotFound");
  });

  it("badge de não lidas por pessoa (o cache não mistura)", async () => {
    expect(await como(master, "owner", () => countUnreadConversations())).toBe(2);
    expect(await como(a, "member", () => countUnreadConversations())).toBe(1);
    expect(await como(b, "member", () => countUnreadConversations())).toBe(1);
  });

  it("caixas de e-mail: cada um vê a sua", async () => {
    expect((await como(a, "member", () => listEmailAccounts())).map((c) => c.label)).toEqual(["E-mail do A"]);
    expect(await como(master, "owner", () => listEmailAccounts())).toHaveLength(2);
  });

  it("ligações: as de quem ligou", async () => {
    expect((await como(a, "member", () => listCalls())).items.map((c) => c.id)).toEqual([ligA]);
    await expect(como(a, "member", () => getCall(ligB))).rejects.toBeInstanceOf(CallNotFound);
    expect((await como(master, "owner", () => listCalls())).items).toHaveLength(2);
  });

  it("campanhas e fluxos: os dele + os compartilhados", async () => {
    expect((await como(a, "member", () => listCampaigns())).map((c) => c.id).sort()).toEqual([campA, campComum].sort());
    await expect(como(a, "member", () => getCampaign(campB))).rejects.toBeInstanceOf(CampaignNotFound);
    expect((await como(a, "member", () => listFlows())).items.map((f) => f.id).sort()).toEqual([fluxoA, fluxoComum].sort());
    await expect(como(a, "member", () => getFlow(fluxoB))).rejects.toBeInstanceOf(FlowNotFound);
    expect((await como(master, "owner", () => listFlows())).items).toHaveLength(3);
  });

  it("captação: a fila de quem capturou; descartar o do colega não faz nada", async () => {
    expect((await como(a, "member", () => listDrafts({ origem: "maps" }))).map((d) => d.id)).toEqual([rascA]);
    expect(await como(a, "member", () => discardDrafts([rascB]))).toEqual({ descartados: 0 });
    expect((await como(master, "owner", () => listDrafts({ origem: "maps" })))).toHaveLength(2);
  });

  it("tempo real: evento do número/ligação/campanha vai para o dono; compartilhada e Painel, para o time", async () => {
    const msg = (channelAccountId: string) =>
      ({ type: "message:received", channelAccountId, conversationId: "x", message: {} }) as never;
    expect(await destinoDoEvento(TEAM, msg(contaA))).toEqual({ time: false, dono: a.id });
    expect(await destinoDoEvento(TEAM, msg(contaB))).toEqual({ time: false, dono: b.id });
    expect(await destinoDoEvento(TEAM, { type: "call:ended", callId: ligB, contactId: "x", durationSeconds: 1 })).toEqual({ time: false, dono: b.id });
    expect(await destinoDoEvento(TEAM, { type: "campaign:changed", campaignId: campA, desfecho: "x" })).toEqual({ time: false, dono: a.id });
    expect(await destinoDoEvento(TEAM, { type: "campaign:changed", campaignId: campComum, desfecho: "x" })).toEqual({ time: true });
    expect(await destinoDoEvento(TEAM, { type: "dashboard:changed" })).toEqual({ time: true });
    // Conta de OUTRO time (ou inexistente): só quem vê tudo.
    expect(await destinoDoEvento("00000000-0000-0000-0000-0000000f3c99", msg(contaA))).toEqual({ time: false, dono: null });
  });

  it("por id (revisão do #153): nada age no contato, número, conversa, fluxo ou campanha do colega", async () => {
    // Nenhum envio real: todas as recusas vêm antes de resolver o provedor.
    await expect(como(a, "member", () => listDealOptionsForContact(contatoDoB))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(como(a, "member", () => createManualCall({ phoneNumber: "+5565999990001", contactId: contatoDoB }))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(como(a, "member", () => sendEmail(contatoDoB, { subject: "x", body: "x" }))).rejects.toThrow("contato não encontrado no time");
    await expect(como(a, "member", () => replyEmailInConversation(emailConvB, "x"))).rejects.toThrow("conversa de e-mail inválida");
    await expect(como(a, "member", () => completeManualCall(inscricaoNoDoB, { resumo: "x" }))).rejects.toBeInstanceOf(FlowNotFound);
    await expect(como(a, "member", () => startConversationWithNumber(contaB, "Novo", "+5565999990002"))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(como(a, "member", () => registerContactForConversation(convB, "Novo"))).rejects.toThrow("ConversationNotFound");
    await expect(como(a, "member", () => enroll(contatoDoB, fluxoB))).rejects.toBeInstanceOf(FlowNotFound);
    await expect(como(a, "member", () => startCampaign(campB))).rejects.toBeInstanceOf(CampaignNotFound);
    // Nada foi gravado no contato do B.
    expect(await basePrisma.call.count({ where: { teamId: TEAM, contactId: contatoDoB } })).toBe(0);
  });

  it("pendências de ligação: as ligações de quem ligou; tarefas do fluxo pelo dono do contato", async () => {
    const ids = async (u: { id: string }, role: string) => {
      const r = (await como(u, role, () => listPendingCalls())) as unknown as { calls?: { id: string }[] } | { id: string }[];
      return JSON.stringify(r);
    };
    await basePrisma.call.update({ where: { id: ligB }, data: { status: "scheduled" } });
    expect(await ids(a, "member")).not.toContain(ligB);
    expect(await ids(b, "member")).toContain(ligB);
  });

  it("captação: o master importa a fila do vendedor e o contato fica com o vendedor", async () => {
    await como(master, "owner", () => importDrafts([rascA]));
    const c = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM, nome: "Fazenda do A" } });
    expect(c.ownerId).toBe(a.id);
  });

  it("tempo real fail-closed: conta vazia/inexistente só vai para quem vê tudo", async () => {
    const msg = (channelAccountId: string) => ({ type: "message:received", channelAccountId, conversationId: "x", message: {} }) as never;
    expect(await destinoDoEvento(TEAM, msg(""))).toEqual({ time: false, dono: null });
    expect(await destinoDoEvento(TEAM, msg("00000000-0000-0000-0000-000000000000"))).toEqual({ time: false, dono: null });
  });
});
