import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { createGoal } from "../goals/service";
import { saveAiConversation, getAiConversation, listAiConversations, deleteAiConversation } from "../ai/conversations";
import { autenticarWebhookWhatsApp, tokenDoWebhookDaInstancia } from "../integrations/whatsapp-webhook-token";
import { autenticarWebhookVoopi, assinaturaDaLigacaoVoopi } from "../calls/voopi-webhook-auth";
import { verifyRelayToken, createRelayToken, revokeRelayToken } from "../relay/tokens";
import { getSessionState, sessionIsCurrent } from "../auth/session";
import { acceptInvite } from "../auth/invites";
import { destinoDoEvento, _limparDestinos } from "../events/destino";
import { createAppointment, listAppointments, updateAppointment } from "../agenda/service";
import { OwnedNotFound } from "../tenancy/assert-owned";
import { redisCache } from "../shared/redis-cache";
import { createContactWithCompany } from "../companies/service";
import { create as criarContato } from "../contacts/service";
import { applyStatusUpdate } from "../conversations/service";

/**
 * Auditoria de isolamento 09/2026 — padrão "dois times": nada do time A chega
 * ao time B (e vice-versa). Relatório: a documentação interna.
 *
 * Proteções que já existiam ganham um teste que as trava; as falhas corrigidas
 * nesta auditoria (S-11 meta com dono de outro time) provam a correção.
 * Nenhum envio: webhooks são testados só na AUTENTICAÇÃO (funções puras), o
 * convite é gravado direto no banco (nenhum e-mail sai) e o time não tem caixa
 * de e-mail conectada.
 */
const TEAM_A = "00000000-0000-0000-0000-00000005ec1a";
const TEAM_B = "00000000-0000-0000-0000-00000005ec1b";
const sufixo = Math.random().toString(36).slice(2, 7);
let donoA: { id: string }, donoB: { id: string }, membroB: { id: string };

const como = <T>(teamId: string, u: { id: string }, role: string, fn: () => Promise<T>) => runWithTeam(teamId, fn, { userId: u.id, role });

async function limpar() {
  for (const teamId of [TEAM_A, TEAM_B]) {
    await basePrisma.appointment.deleteMany({ where: { teamId } });
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
    await basePrisma.goal.deleteMany({ where: { teamId } });
    await basePrisma.aiConversation.deleteMany({ where: { teamId } });
    await basePrisma.message.deleteMany({ where: { teamId } });
    await basePrisma.conversation.deleteMany({ where: { teamId } });
    await basePrisma.relayAgentToken.deleteMany({ where: { teamId } });
    await basePrisma.invite.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
    await basePrisma.user.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  await limpar();
  for (const [id, name] of [
    [TEAM_A, "Seg dois times A (test)"],
    [TEAM_B, "Seg dois times B (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const mk = (teamId: string, n: string, role: string) =>
    basePrisma.user.create({ data: { teamId, name: n, email: `seg-2t-${n}-${sufixo}@teste.crmagro`, role } });
  donoA = await mk(TEAM_A, "donoa", "owner");
  donoB = await mk(TEAM_B, "donob", "owner");
  membroB = await mk(TEAM_B, "membrob", "member");
});

afterAll(limpar);

describe("metas — FK de dono vinda da tela (S-11, corrigido)", () => {
  it("meta do time A com dono do time B é recusada e nada é gravado; dono do próprio time passa", async () => {
    await expect(
      como(TEAM_A, donoA, "owner", () => createGoal({ periodo: "2026-09", metaValor: 1000, toquesPorDia: 10, ownerId: membroB.id })),
    ).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await basePrisma.goal.count({ where: { teamId: TEAM_A } })).toBe(0);
    const ok = await como(TEAM_A, donoA, "owner", () => createGoal({ periodo: "2026-09", metaValor: 1000, toquesPorDia: 10, ownerId: donoA.id }));
    expect(ok.ownerId).toBe(donoA.id);
  });
});

describe("assistente de IA — conversa do time A não existe para o time B", () => {
  it("B não lista, não abre, não sobrescreve e não apaga a conversa de A", async () => {
    const conversaA = await como(TEAM_A, donoA, "owner", () =>
      saveAiConversation({ messages: [{ role: "user", content: `segredo do time A ${sufixo}` }] }),
    );
    expect((await como(TEAM_B, donoB, "owner", () => listAiConversations())).map((c) => c.id)).not.toContain(conversaA.id);
    expect(await como(TEAM_B, donoB, "owner", () => getAiConversation(conversaA.id))).toBeNull();
    // Salvar com o id alheio cria OUTRA conversa no time B; a do A fica intacta.
    const deB = await como(TEAM_B, donoB, "owner", () =>
      saveAiConversation({ id: conversaA.id, messages: [{ role: "user", content: "invadido" }] }),
    );
    expect(deB.id).not.toBe(conversaA.id);
    await como(TEAM_B, donoB, "owner", () => deleteAiConversation(conversaA.id));
    const intacta = await basePrisma.aiConversation.findUniqueOrThrow({ where: { id: conversaA.id } });
    expect(intacta.teamId).toBe(TEAM_A);
    expect(JSON.stringify(intacta.messages)).toContain(`segredo do time A ${sufixo}`);
  });
});

describe("webhooks — autenticação amarrada ao dono (funções puras, nada é recebido)", () => {
  const SEGREDO = `segredo-${sufixo}`;
  const opts = { segredo: SEGREDO, producao: true, aceitarLegado: false };

  it("WhatsApp: o token da instância do time A não autentica a instância do time B", () => {
    const tokenA = tokenDoWebhookDaInstancia("inst-time-a", SEGREDO);
    expect(autenticarWebhookWhatsApp({ instance: "inst-time-a", header: tokenA, query: null }, opts)).toMatchObject({ ok: true, via: "instancia" });
    expect(autenticarWebhookWhatsApp({ instance: "inst-time-b", header: tokenA, query: null }, opts)).toMatchObject({ ok: false });
    // Sem instância no corpo não há como conferir: recusado.
    expect(autenticarWebhookWhatsApp({ instance: null, header: tokenA, query: null }, opts)).toMatchObject({ ok: false });
    // Produção sem segredo: fail-closed.
    expect(autenticarWebhookWhatsApp({ instance: "inst-time-a", header: tokenA, query: null }, { segredo: null, producao: true })).toMatchObject({
      ok: false,
      motivo: "sem_segredo_em_producao",
    });
  });

  it("Voopi: a assinatura de uma ligação não vale para outra (o callbackUrl do time não abre as ligações dos outros)", () => {
    const ligacaoA = "11111111-1111-4111-8111-111111111111";
    const ligacaoB = "22222222-2222-4222-8222-222222222222";
    const sig = assinaturaDaLigacaoVoopi(ligacaoA, SEGREDO);
    expect(autenticarWebhookVoopi({ token: null, ref: ligacaoA, sig }, { segredo: SEGREDO, producao: true })).toMatchObject({ ok: true, via: "assinado", ref: ligacaoA });
    expect(autenticarWebhookVoopi({ token: null, ref: ligacaoB, sig }, { segredo: SEGREDO, producao: true })).toMatchObject({ ok: false });
    expect(autenticarWebhookVoopi({ token: null, ref: ligacaoA, sig }, { segredo: null, producao: true })).toMatchObject({ ok: false });
  });
});

describe("extensão (relay) — o token resolve o time dele e nada mais", () => {
  it("token do time A resolve o time A; revogado não vale; dono que mudou de time perde o papel", async () => {
    const criado = await como(TEAM_A, donoA, "owner", () => createRelayToken({ label: `seg ${sufixo}`, userId: donoA.id }));
    expect(await verifyRelayToken(criado.token)).toEqual({ teamId: TEAM_A, userId: donoA.id, role: "owner" });
    // Token gravado no time A mas com o dono sendo pessoa do time B: sem papel (nada de escrita).
    const cru = `rly_seg_${sufixo}_${Date.now()}`;
    await basePrisma.relayAgentToken.create({
      data: { teamId: TEAM_A, userId: donoB.id, label: "cruzado", tokenPrefix: cru.slice(0, 8), tokenHash: createHash("sha256").update(cru).digest("hex") },
    });
    expect(await verifyRelayToken(cru)).toEqual({ teamId: TEAM_A, userId: donoB.id, role: null });
    // O time B não revoga o token do time A (extensão de tenancy).
    await como(TEAM_B, donoB, "owner", () => revokeRelayToken(criado.id));
    expect(await verifyRelayToken(criado.token)).not.toBeNull();
    await como(TEAM_A, donoA, "owner", () => revokeRelayToken(criado.id));
    expect(await verifyRelayToken(criado.token)).toBeNull();
  });
});

describe("sessão — o token só vale para o time e a versão atuais", () => {
  it("time trocado, papel trocado ou versão velha derrubam; conta desativada vira 'sem sessão'", async () => {
    const estado = await getSessionState(donoA.id);
    expect(estado).toMatchObject({ teamId: TEAM_A, role: "owner" });
    const token = { teamId: TEAM_A, role: "owner", sessionVersion: estado!.sessionVersion };
    expect(sessionIsCurrent(token, estado)).toBe(true);
    expect(sessionIsCurrent({ ...token, teamId: TEAM_B }, estado)).toBe(false);
    expect(sessionIsCurrent({ ...token, role: "admin" }, estado)).toBe(false);
    expect(sessionIsCurrent({ ...token, sessionVersion: estado!.sessionVersion + 1 }, estado)).toBe(false);
    expect(sessionIsCurrent({ teamId: TEAM_A, role: "owner" }, estado)).toBe(false); // token antigo sem versão

    const desativado = await basePrisma.user.create({
      data: { teamId: TEAM_A, name: "desativado", email: `seg-2t-desat-${sufixo}@teste.crmagro`, role: "member", desativadoEm: new Date() },
    });
    await redisCache().del(`crmagro:sess:${desativado.id}`).catch(() => 0);
    expect(await getSessionState(desativado.id)).toBeNull();
  });
});

describe("convite — nunca muda alguém de time", () => {
  it("convite do time A para e-mail que já é do time B: recusado e a pessoa continua no B", async () => {
    const token = `inv_seg_${sufixo}_${Date.now()}`;
    await basePrisma.invite.create({
      data: {
        teamId: TEAM_A,
        email: `seg-2t-membrob-${sufixo}@teste.crmagro`,
        role: "admin",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        tokenPrefix: token.slice(0, 8),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    expect(await acceptInvite(token, { name: "x", passwordHash: "hash-qualquer" })).toEqual({ ok: false, reason: "email_in_other_team" });
    const pessoa = await basePrisma.user.findUniqueOrThrow({ where: { id: membroB.id } });
    expect(pessoa).toMatchObject({ teamId: TEAM_B, role: "member" });
  });
});

describe("tempo real — evento com id de outro time não acha dono", () => {
  it("mensagem do time A apontando conta do time B vai só para quem vê tudo do A (nunca para a pessoa do B)", async () => {
    _limparDestinos();
    const contaB = await basePrisma.channelAccount.create({
      data: { teamId: TEAM_B, canal: "whatsapp", label: "WA do B", provider: "evolution", status: "connected", ownerId: membroB.id },
    });
    const destino = await destinoDoEvento(TEAM_A, {
      type: "message:received",
      channelAccountId: contaB.id,
      conversationId: "x",
      message: {} as never,
    } as never);
    expect(destino).toEqual({ time: false, dono: null });
    _limparDestinos();
  });
});

// S-03 (inbound de instância sem conta): teste próprio em
// seguranca/inbound-instancia.test.ts — precisa simular "a única conta conectada
// do sistema" com um mock do `@crmagro/db` que não pode vazar para este arquivo.

describe("recibo ✓✓ — só mexe em mensagem da conta da instância que o mandou (S-14, corrigido)", () => {
  it("recibo da instância do B (ou sem instância/instância desconhecida) não muda a mensagem do A; o da conta do A muda", async () => {
    const mk = (teamId: string, externalId: string) =>
      basePrisma.channelAccount.create({ data: { teamId, canal: "whatsapp", label: externalId, provider: "evolution", externalId, status: "connected" } });
    const contaA = await mk(TEAM_A, `seg-2t-rec-a-${sufixo}`);
    const outraDoA = await mk(TEAM_A, `seg-2t-rec-a2-${sufixo}`);
    const contaB = await mk(TEAM_B, `seg-2t-rec-b-${sufixo}`);
    const conv = await basePrisma.conversation.create({
      data: { teamId: TEAM_A, channelAccountId: contaA.id, canal: "whatsapp", externalNumber: "+5566977776666" },
    });
    const pid = `S14-${sufixo}`;
    const m = await basePrisma.message.create({
      data: { teamId: TEAM_A, conversationId: conv.id, direcao: "out", tipo: "text", conteudo: "oi", status: "sent", providerMessageId: pid },
    });
    const status = async () => (await basePrisma.message.findUniqueOrThrow({ where: { id: m.id } })).status;

    for (const instance of [contaB.externalId, outraDoA.externalId, `nao-existe-${sufixo}`, null]) {
      await applyStatusUpdate({ providerMessageId: pid, status: "read", errorCode: "463", instance });
      expect(await status()).toBe("sent");
    }
    // O ack de erro de outra instância também não pausou a conta do A.
    expect((await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: contaA.id } })).paused).toBe(false);

    await applyStatusUpdate({ providerMessageId: pid, status: "delivered", errorCode: null, instance: contaA.externalId });
    expect(await status()).toBe("delivered");
  });
});

describe("agenda — compromisso do time A não existe para o time B", () => {
  it("B não lista nem remarca", async () => {
    const c = await como(TEAM_A, donoA, "owner", () => createAppointment({ titulo: `Visita A ${sufixo}`, inicio: "2032-03-01T13:00:00.000Z" }));
    const doB = await como(TEAM_B, donoB, "owner", () => listAppointments({ from: "2032-03-01T00:00:00.000Z", to: "2032-03-02T00:00:00.000Z" }));
    expect(doB.map((x) => x.id)).not.toContain(c.id);
    await expect(como(TEAM_B, donoB, "owner", () => updateAppointment(c.id, { titulo: "invadido" }))).rejects.toBeInstanceOf(OwnedNotFound);
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: c.id } })).titulo).toBe(`Visita A ${sufixo}`);
  });
});

describe("responsável do contato (PR #156) — nada cruza o time", () => {
  it("o gestor do time A não põe como responsável uma pessoa do time B", async () => {
    await expect(
      como(TEAM_A, donoA, "owner", () => createContactWithCompany({ person: { nome: `Cruzado ${sufixo}` }, responsavelId: membroB.id })),
    ).rejects.toMatchObject({ name: "ResponsavelInvalido" });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A, nome: `Cruzado ${sufixo}` } })).toBe(0);
  });

  it("'já cadastrado' só olha o próprio time: telefone que existe no time B não é oráculo no time A", async () => {
    const telefone = `+5566999${String(Date.now()).slice(-6)}`;
    await como(TEAM_B, donoB, "owner", () => criarContato({ nome: `Só no B ${sufixo}`, telefone, tags: [] }));
    const noA = await como(TEAM_A, donoA, "owner", () => criarContato({ nome: `Também no A ${sufixo}`, telefone, tags: [] }));
    expect(noA.teamId).toBe(TEAM_A);
    expect(noA.ownerId).toBe(donoA.id);
  });
});
