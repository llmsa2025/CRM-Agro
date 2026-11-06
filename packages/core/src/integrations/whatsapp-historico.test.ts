import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { env } from "@crmagro/config";
import type { InboundMessage, WhatsAppHistoryPage } from "@crmagro/channels";

const fetchPage = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<WhatsAppHistoryPage>>());
// Nomes (agenda/limpeza) rodam no mesmo job: aqui a Evolution "não tem" a
// instância, então a rodada de nomes sai sem mexer em nada (teste próprio em
// whatsapp-nomes.test.ts). Nada vai à rede.
const evoNomes = vi.hoisted(() => ({
  fetchEvolutionInstance: vi.fn(async () => null),
  fetchEvolutionContacts: vi.fn(async () => []),
}));
vi.mock("@crmagro/channels", async (original) => ({
  ...await original<typeof import("@crmagro/channels")>(), fetchWhatsAppHistoryPage: fetchPage, ...evoNomes,
}));
const { importarPaginaHistorico, processarHistoricoWhatsApp, lerEstadoHistorico } = await import("./whatsapp-historico");
const { listConversations, sendMessage, sendMediaMessage, registerContactForConversation, HistoricoSemTelefone } = await import("../conversations/service");
const { ROTULO_CONVERSA_SEM_NUMERO } = await import("../conversations/nome");
const TEAM = "00000000-0000-0000-0000-0000000006b1";
const OTHER = "00000000-0000-0000-0000-0000000006b2";
const INSTANCE = "history-test";
let accountId: string;
const job = () => ({ accountId, teamId: TEAM, instance: INSTANCE });
const ts = 1700000000;
const msg = (id: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  providerMessageId: id, instance: INSTANCE, from: "+5565999991111", fromMe: false,
  text: "mensagem antiga", timestamp: ts, name: "Cliente", media: null, ...extra,
});
const page = (messages: InboundMessage[], total = messages.length, pages = 1): WhatsAppHistoryPage => ({ messages, total, pages, records: messages.length });

beforeAll(async () => {
  // A importação é opt-in (WA_HISTORICO_MODO; ausente = desligada). Estes testes
  // cobrem o modo "completo"; o desligado está em whatsapp-historico-modo.test.ts.
  env.WA_HISTORICO_MODO = "completo";
  for (const id of [TEAM, OTHER]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: "Teste histórico WhatsApp" } });
});
beforeEach(async () => {
  await basePrisma.conversation.deleteMany({ where: { teamId: { in: [TEAM, OTHER] } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: [TEAM, OTHER] } } });
  await basePrisma.channelAccount.deleteMany({ where: { teamId: { in: [TEAM, OTHER] } } });
  const a = await basePrisma.channelAccount.create({ data: {
    teamId: TEAM, label: "WA", provider: "evolution", canal: "whatsapp", externalId: INSTANCE,
    status: "connected", meta: { outraConfig: "preservada" },
  } });
  accountId = a.id;
  fetchPage.mockReset();
});
afterAll(async () => {
  await basePrisma.team.deleteMany({ where: { id: { in: [TEAM, OTHER] } } });
});

describe("importação histórica", () => {
  it("preserva LID para consulta, sem telefone fictício nem envio para identificador anônimo", async () => {
    await importarPaginaHistorico(job(), [msg("lid-message", { from: "123456789@lid", name: null })]);
    const c = await basePrisma.conversation.findFirstOrThrow({ where: { channelAccountId: accountId } });
    expect(c.externalNumber).toBe("123456789@lid");
    expect(c.contactId).toBeNull();
    // Sem nome: nada de rótulo gravado como se fosse o pushName da pessoa.
    expect(c.externalName).toBeNull();
    await runAsSystem(TEAM, async () => {
      const item = (await listConversations(accountId)).items[0];
      expect(item?.numero).toBeNull();
      expect(item?.displayName).toBe(ROTULO_CONVERSA_SEM_NUMERO);
      expect(item?.nomeSugerido).toBeNull();
      await expect(sendMessage(c.id, "oi")).rejects.toBeInstanceOf(HistoricoSemTelefone);
      await expect(sendMediaMessage(c.id, { mediaPath: "x", mediaMime: "image/png", base64: "x" })).rejects.toBeInstanceOf(HistoricoSemTelefone);
      await expect(registerContactForConversation(c.id, "Cliente")).rejects.toBeInstanceOf(HistoricoSemTelefone);
    });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(0);
  });
  it("guarda datas, direção e mídia; retry não duplica, não gera atividades nem não-lidas", async () => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Cliente" } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: c.id, canal: "whatsapp", valor: "+5565999991111", isPrimary: true } });
    const batch = [msg("history-in", { text: "pare" }), msg("history-out", { fromMe: true, timestamp: ts + 1 }), msg("history-media", {
      timestamp: ts - 10, text: null, media: { kind: "image", mime: "image/jpeg", fileName: null, size: null },
    })];
    expect(await importarPaginaHistorico(job(), batch)).toBe(3);
    expect(await importarPaginaHistorico(job(), batch)).toBe(0);
    const conv = await basePrisma.conversation.findFirstOrThrow({ where: { channelAccountId: accountId } });
    expect(conv.contactId).toBe(c.id);
    expect(conv.unreadCount).toBe(0);
    expect(conv.lastMessageAt).toEqual(new Date((ts + 1) * 1000));
    expect(conv.lastMessageDirecao).toBe("out");
    const messages = await basePrisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => m.direcao)).toEqual(["in", "in", "out"]);
    expect(messages[0]?.conteudo).toContain("consulte o arquivo no celular");
    expect(await basePrisma.activity.count({ where: { teamId: TEAM } })).toBe(0);
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM } })).toBe(0);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).relacionamentoStatus).toBe("novo");
    await basePrisma.conversation.update({ where: { id: conv.id }, data: { unreadCount: 2, lastMessageAt: new Date(), lastMessagePreview: "mensagem ao vivo" } });
    await importarPaginaHistorico(job(), [msg("history-even-older", { timestamp: ts - 100 })]);
    const updated = await basePrisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(updated.unreadCount).toBe(2);
    expect(updated.lastMessagePreview).toBe("mensagem ao vivo");
  });

  it("nome da conversa: nunca de mensagem ENVIADA nem número; rótulo antigo do @lid é trocado pelo nome real", async () => {
    // Enviada pelo celular: o pushName é o do DONO — não pode virar o nome da conversa.
    await importarPaginaHistorico(job(), [
      msg("dono-1", { fromMe: true, name: "Dono da Conta", timestamp: ts + 5 }),
      msg("num-1", { name: "5565999991111", timestamp: ts + 4 }), // Evolution pôs o número
      msg("voce-1", { fromMe: true, name: "Você", timestamp: ts + 3 }),
    ]);
    const c = await basePrisma.conversation.findFirstOrThrow({ where: { channelAccountId: accountId } });
    expect(c.externalName).toBeNull();
    // Mensagem recebida com nome de verdade preenche o que falta.
    await importarPaginaHistorico(job(), [msg("real-1", { name: "Maicon", timestamp: ts - 50 })]);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: c.id } })).externalName).toBe("Maicon");
    // Conversa @lid com o rótulo antigo gravado como nome: o nome real substitui.
    const lid = await basePrisma.conversation.create({ data: {
      teamId: TEAM, channelAccountId: accountId, canal: "whatsapp", externalNumber: "987654321@lid", externalName: "Conversa do WhatsApp · 4321",
    } });
    await importarPaginaHistorico(job(), [msg("lid-2", { from: "987654321@lid", name: "Joana" })]);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: lid.id } })).externalName).toBe("Joana");
  });

  it("recupera mensagens órfãs da conta removida, sem mexer em outra conta ativa ou time", async () => {
    const orphan = await basePrisma.conversation.create({ data: { teamId: TEAM, canal: "whatsapp", externalNumber: "+5565999991111" } });
    await basePrisma.message.create({ data: { teamId: TEAM, conversationId: orphan.id, providerMessageId: "orphan", direcao: "in", tipo: "text", conteudo: "original" } });
    expect(await importarPaginaHistorico(job(), [msg("orphan")])).toBe(1);
    const m = await basePrisma.message.findFirstOrThrow({ where: { teamId: TEAM, providerMessageId: "orphan" }, include: { conversation: true } });
    expect(m.conversation.channelAccountId).toBe(accountId);
    expect(m.conteudo).toBe("original");
    expect(await importarPaginaHistorico({ ...job(), teamId: OTHER }, [msg("wrong-team")])).toBe(0);
    const b = await basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", provider: "evolution", externalId: "history-other", label: "Outra", status: "connected" } });
    expect(await importarPaginaHistorico({ ...job(), accountId: b.id, instance: "history-other" }, [msg("orphan", { instance: "history-other" })])).toBe(0);
    expect(await basePrisma.conversation.count({ where: { channelAccountId: b.id } })).toBe(0);
  });

  it("retoma a página que falhou, preserva meta e detecta histórico que chegou depois", async () => {
    fetchPage.mockResolvedValueOnce(page([msg("page1")], 2, 2)).mockRejectedValueOnce(new Error("Evolution fora"));
    await expect(processarHistoricoWhatsApp(job())).rejects.toThrow("Evolution fora");
    const state = async () => (await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: accountId } })).meta;
    expect(lerEstadoHistorico(await state())).toMatchObject({ status: "error", pagina: 2, importadas: 1 });
    fetchPage.mockResolvedValueOnce(page([msg("page1")], 2, 2)).mockResolvedValueOnce(page([msg("page2")], 2, 2));
    await processarHistoricoWhatsApp(job());
    expect(lerEstadoHistorico(await state())).toMatchObject({ status: "completed", importadas: 2 });
    expect(await state()).toMatchObject({ outraConfig: "preservada" });
    // Concluído: a conferência é leve (página de 1 item); só baixa a página
    // cheia quando o total mudou.
    fetchPage.mockClear().mockResolvedValue(page([msg("page1"), msg("page2"), msg("late")], 3, 1));
    await processarHistoricoWhatsApp(job());
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ page: 1, tamanho: 1 });
    expect(fetchPage.mock.calls[1]?.[0]).not.toHaveProperty("tamanho");
    expect(lerEstadoHistorico(await state())).toMatchObject({ status: "completed", importadas: 3, total: 3 });
    expect(await basePrisma.message.count({ where: { teamId: TEAM } })).toBe(3);
    fetchPage.mockClear().mockResolvedValue(page([], 3, 1));
    await processarHistoricoWhatsApp(job());
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ tamanho: 1 });
    // Falha na conferência leve não rebaixa o histórico concluído para "erro".
    fetchPage.mockRejectedValueOnce(new Error("Evolution fora"));
    await expect(processarHistoricoWhatsApp(job())).rejects.toThrow("Evolution fora");
    expect(lerEstadoHistorico(await state())).toMatchObject({ status: "completed" });
  });

  it("histórico inicialmente vazio é revisitado; conta excluída ou de outro time não consulta API", async () => {
    fetchPage.mockResolvedValueOnce(page([], 0, 0));
    await processarHistoricoWhatsApp(job());
    // Conferência leve vê o total novo e a página cheia traz a mensagem.
    fetchPage.mockResolvedValue(page([msg("late-first")]));
    await processarHistoricoWhatsApp(job());
    expect(await basePrisma.message.count({ where: { teamId: TEAM } })).toBe(1);
    fetchPage.mockClear();
    evoNomes.fetchEvolutionInstance.mockClear();
    await processarHistoricoWhatsApp({ ...job(), teamId: OTHER });
    await basePrisma.channelAccount.delete({ where: { id: accountId } });
    await processarHistoricoWhatsApp(job());
    expect(fetchPage).not.toHaveBeenCalled();
    expect(evoNomes.fetchEvolutionInstance).not.toHaveBeenCalled();
  });
});
