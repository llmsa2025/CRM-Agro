import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { parseEvolutionInbound, type InboundMessage } from "@crmagro/channels";
import { runWithTeam } from "../test-support/identidade";

/**
 * Nome da conversa do WhatsApp (bug de 28/09): as conversas que o dono puxou
 * pelo celular apareciam com o nome DELE ("Você: Bom dia Maicon" → "o nome do dono…"),
 * porque o webhook gravava o pushName de toda mensagem — inclusive da ENVIADA,
 * em que o pushName é o do próprio dono. Fila do motor mockada: nada é enviado.
 */
vi.mock("../flows/queue", () => ({
  scheduleStep: vi.fn(),
  getFlowQueue: () => ({}),
}));

const { receiveInbound, listConversations } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000006c1";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `nome-conversa-${sufixo}`;
const NUMERO = "+5565988881234";
const DONO = "Marcos Dono da Conta";

let contaId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Nome da Conversa (test)" } });
});

beforeEach(async () => {
  const w = { teamId: TEAM };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  const conta = await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
  });
  contaId = conta.id;
});

let seq = 0;
function msg(extra: Partial<InboundMessage> = {}): InboundMessage {
  seq++;
  return {
    from: NUMERO, fromMe: false, text: `oi ${seq}`, media: null,
    providerMessageId: `NOME-${sufixo}-${seq}`, timestamp: null, name: "Maicon", instance: INSTANCIA, ...extra,
  };
}

const nomeGravado = async () =>
  (await basePrisma.conversation.findFirstOrThrow({ where: { teamId: TEAM, channelAccountId: contaId } })).externalName;

describe("pushName nunca vem de mensagem ENVIADA (fromMe)", () => {
  it("conversa aberta pelo celular do dono nasce SEM o nome dele", async () => {
    await receiveInbound(msg({ fromMe: true, name: DONO, text: "Bom dia Maicon" }));
    expect(await nomeGravado()).toBeNull();
  });

  it("a enviada não sobrescreve o nome que veio da resposta da pessoa", async () => {
    await receiveInbound(msg({ name: "Maicon" }));
    await receiveInbound(msg({ fromMe: true, name: DONO }));
    await receiveInbound(msg({ fromMe: true, name: "Você" }));
    expect(await nomeGravado()).toBe("Maicon");
  });

  it("do webhook de verdade (payload da Evolution) até o banco", async () => {
    const payload = {
      event: "messages.upsert",
      instance: INSTANCIA,
      data: {
        key: { remoteJid: "5565988881234@s.whatsapp.net", fromMe: true, id: `EVO-${sufixo}` },
        pushName: DONO,
        message: { conversation: "Bom dia Maicon" },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    };
    const parsed = parseEvolutionInbound(payload);
    expect(parsed?.fromMe).toBe(true);
    expect(parsed?.name).toBeNull();
    await receiveInbound(parsed!);
    expect(await nomeGravado()).toBeNull();
  });

  it("pushName que é só o número não vira nome", async () => {
    await receiveInbound(msg({ name: "5565988881234" }));
    expect(await nomeGravado()).toBeNull();
  });
});

describe("listConversations — ordem do nome (contato > agenda > pushName > número)", () => {
  it("aplica os 4 níveis e sugere o nome certo para o cadastro", async () => {
    const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maicon Cadastrado" } });
    const conv = (dados: Record<string, unknown>) =>
      basePrisma.conversation.create({ data: { teamId: TEAM, channelAccountId: contaId, canal: "whatsapp", ...dados } as never });
    const c1 = await conv({ contactId: contato.id, nomeAgenda: "Maicon Agenda", externalName: "Mai" });
    const c2 = await conv({ externalNumber: "+5565911112222", nomeAgenda: "Joana Agenda", externalName: "Jo" });
    const c3 = await conv({ externalNumber: "+5565933334444", externalName: "Pedro Perfil" });
    const c4 = await conv({ externalNumber: "+5565955556666" });
    const itens = await runWithTeam(TEAM, () => listConversations(contaId));
    const de = (id: string) => itens.items.find((i) => i.id === id)!;
    expect(de(c1.id)).toMatchObject({ displayName: "Maicon Cadastrado", nomeSugerido: "Maicon Agenda" });
    expect(de(c2.id)).toMatchObject({ displayName: "Joana Agenda", nomeSugerido: "Joana Agenda" });
    expect(de(c3.id)).toMatchObject({ displayName: "Pedro Perfil", nomeSugerido: "Pedro Perfil" });
    expect(de(c4.id)).toMatchObject({ displayName: "+5565955556666", nomeSugerido: null });
    // A busca acha pelo nome da agenda.
    const busca = await runWithTeam(TEAM, () => listConversations(contaId, { busca: "Joana Agenda" }));
    expect(busca.items.map((i) => i.id)).toEqual([c2.id]);
  });
});
