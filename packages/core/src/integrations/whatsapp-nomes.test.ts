import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import type { ContatoDaAgenda, InstanciaEvolution } from "@crmagro/channels";

/**
 * Nomes das conversas do WhatsApp (28/09): limpeza do nome do DONO gravado por
 * mensagem enviada e nome salvo na AGENDA do celular. A Evolution é mockada —
 * só leitura (fetchInstances/findContacts), nada vai à rede.
 */
const evo = vi.hoisted(() => ({
  fetchEvolutionInstance: vi.fn<(...a: unknown[]) => Promise<InstanciaEvolution | null>>(),
  fetchEvolutionContacts: vi.fn<(...a: unknown[]) => Promise<ContatoDaAgenda[]>>(),
}));
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  ...evo,
}));

const { limparNomesErrados, aplicarNomesDaAgenda, sincronizarNomesWhatsApp, lerEstadoNomes, NOMES_WHATSAPP_INTERVALO_MS } =
  await import("./whatsapp-nomes");

const TEAM = "00000000-0000-0000-0000-0000000006d1";
const OTHER = "00000000-0000-0000-0000-0000000006d2";
const INSTANCE = `nomes-${Math.random().toString(36).slice(2, 8)}`;
const DONO = "Marcos Dono da Conta";
const NUMERO_DONO = "+5565999990000";
let accountId = "";
let outraContaId = "";
const conta = () => ({ accountId, teamId: TEAM, instance: INSTANCE });
const instancia = (extra: Partial<InstanciaEvolution> = {}): InstanciaEvolution => ({
  nome: INSTANCE, estado: "open", nomeDoPerfil: DONO, numeroDoDono: NUMERO_DONO, ...extra,
});

async function conv(dados: Record<string, unknown>, teamId = TEAM) {
  return basePrisma.conversation.create({ data: { teamId, canal: "whatsapp", ...dados } as never });
}
const nomeDe = async (id: string) => (await basePrisma.conversation.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  for (const id of [TEAM, OTHER]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: "Teste nomes WhatsApp" } });
});
beforeEach(async () => {
  for (const teamId of [TEAM, OTHER]) {
    await basePrisma.conversation.deleteMany({ where: { teamId } });
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  }
  accountId = (await basePrisma.channelAccount.create({ data: {
    teamId: TEAM, label: "WA", provider: "evolution", canal: "whatsapp", externalId: INSTANCE, status: "connected",
    meta: { outraConfig: "preservada" },
  } })).id;
  outraContaId = (await basePrisma.channelAccount.create({ data: {
    teamId: TEAM, label: "Comercial", provider: "evolution", canal: "whatsapp", externalId: `${INSTANCE}-b`, status: "connected",
  } })).id;
  evo.fetchEvolutionInstance.mockReset().mockResolvedValue(instancia());
  evo.fetchEvolutionContacts.mockReset().mockResolvedValue([]);
});
afterAll(async () => {
  for (const teamId of [TEAM, OTHER]) {
    await basePrisma.conversation.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  }
  await basePrisma.team.deleteMany({ where: { id: { in: [TEAM, OTHER] } } });
});

describe("limpeza do nome errado", () => {
  it("apaga o nome do dono, 'Você', número e rótulo antigo — sem tocar em nome certo, outra conta ou outro time", async () => {
    const doDono = await conv({ channelAccountId: accountId, externalNumber: "+5565911110001", externalName: DONO });
    const comContato = await conv({ channelAccountId: accountId, contactId: (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Maicon" } })).id, externalName: DONO });
    const voce = await conv({ channelAccountId: accountId, externalNumber: "+5565911110002", externalName: "Você" });
    const numero = await conv({ channelAccountId: accountId, externalNumber: "+5565911110003", externalName: "5565911110003" });
    const rotulo = await conv({ channelAccountId: accountId, externalNumber: "123@lid", externalName: "Conversa do WhatsApp · 0123" });
    const certo = await conv({ channelAccountId: accountId, externalNumber: "+5565911110004", externalName: "Maicon" });
    // "Mensagem para mim": a conversa com o PRÓPRIO número do dono tem o nome dele de verdade.
    const paraMim = await conv({ channelAccountId: accountId, externalNumber: "+556599990000", externalName: DONO });
    const orfa = await conv({ channelAccountId: null, externalNumber: "+5565911110005", externalName: DONO });
    const outraConta = await conv({ channelAccountId: outraContaId, externalNumber: "+5565911110006", externalName: DONO });
    const outroTime = await conv({ externalNumber: "+5565911110007", externalName: DONO }, OTHER);

    expect(await limparNomesErrados(conta(), { nomeDoPerfil: DONO, numeroDoDono: NUMERO_DONO })).toBe(6);
    for (const c of [doDono, comContato, voce, numero, rotulo, orfa]) expect((await nomeDe(c.id)).externalName).toBeNull();
    expect((await nomeDe(certo.id)).externalName).toBe("Maicon");
    expect((await nomeDe(paraMim.id)).externalName).toBe(DONO); // variante sem o nono dígito também é do dono
    expect((await nomeDe(outraConta.id)).externalName).toBe(DONO);
    expect((await nomeDe(outroTime.id)).externalName).toBe(DONO);
    // Idempotente.
    expect(await limparNomesErrados(conta(), { nomeDoPerfil: DONO, numeroDoDono: NUMERO_DONO })).toBe(0);
  });

  it("não mexe no cadastro do contato (Contact.nome)", async () => {
    const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: DONO } });
    await conv({ channelAccountId: accountId, contactId: c.id, externalName: DONO });
    await limparNomesErrados(conta(), { nomeDoPerfil: DONO, numeroDoDono: NUMERO_DONO });
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).nome).toBe(DONO);
  });
});

describe("nome da agenda do celular", () => {
  it("casa com e sem o nono dígito, pelo cadastro ou pelo número, e o @lid pelo id; ignora o dono e 'nome' que é número", async () => {
    const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Cadastro" } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contato.id, canal: "whatsapp", valor: "+5565922220001", isPrimary: true } });
    const porCadastro = await conv({ channelAccountId: accountId, contactId: contato.id });
    const semNono = await conv({ channelAccountId: accountId, externalNumber: "+556522220002" }); // conversa sem o 9
    const lid = await conv({ channelAccountId: accountId, externalNumber: "555000111@lid" });
    const nomeNumero = await conv({ channelAccountId: accountId, externalNumber: "+5565922220003" });
    const semAgenda = await conv({ channelAccountId: accountId, externalNumber: "+5565922220004", nomeAgenda: "Nome antigo" });
    const outraConta = await conv({ channelAccountId: outraContaId, externalNumber: "+5565922220002" });
    const doDono = await conv({ channelAccountId: accountId, externalNumber: NUMERO_DONO });

    const gravadas = await aplicarNomesDaAgenda(conta(), [
      { jid: "5565922220001@s.whatsapp.net", numero: "+5565922220001", nome: "Maicon Fornecedor" },
      { jid: "5565922220002@s.whatsapp.net", numero: "+5565922220002", nome: "Joana Agenda" }, // agenda com o 9
      { jid: "555000111@lid", numero: null, nome: "Pedro do LID" },
      { jid: "5565922220003@s.whatsapp.net", numero: "+5565922220003", nome: "5565922220003" },
      { jid: "5565999990000@s.whatsapp.net", numero: NUMERO_DONO, nome: "Eu mesmo" },
    ], NUMERO_DONO);

    expect(gravadas).toBe(3);
    expect((await nomeDe(porCadastro.id)).nomeAgenda).toBe("Maicon Fornecedor");
    expect((await nomeDe(semNono.id)).nomeAgenda).toBe("Joana Agenda");
    expect((await nomeDe(lid.id)).nomeAgenda).toBe("Pedro do LID");
    expect((await nomeDe(nomeNumero.id)).nomeAgenda).toBeNull();
    expect((await nomeDe(semAgenda.id)).nomeAgenda).toBe("Nome antigo"); // lista parcial não apaga nome
    expect((await nomeDe(outraConta.id)).nomeAgenda).toBeNull(); // agenda é do celular DESTA conta
    expect((await nomeDe(doDono.id)).nomeAgenda).toBeNull();
    // Rodar de novo não regrava nada.
    expect(await aplicarNomesDaAgenda(conta(), [{ jid: "555000111@lid", numero: null, nome: "Pedro do LID" }], NUMERO_DONO)).toBe(0);
  });
});

describe("sincronizarNomesWhatsApp (job do worker)", () => {
  it("limpa, aplica a agenda, grava o estado no meta sem apagar o resto e respeita o intervalo", async () => {
    const errada = await conv({ channelAccountId: accountId, externalNumber: "+5565933330001", externalName: DONO });
    evo.fetchEvolutionContacts.mockResolvedValue([{ jid: "5565933330001@s.whatsapp.net", numero: "+5565933330001", nome: "Maicon" }]);
    const agora = new Date("2026-09-28T12:00:00Z");
    const r = await sincronizarNomesWhatsApp(conta(), { agora });
    expect(r).toEqual({ sincronizadoEm: agora.toISOString(), agenda: 1, contatosNaAgenda: 1, limpas: 1 });
    expect(await nomeDe(errada.id)).toMatchObject({ externalName: null, nomeAgenda: "Maicon" });
    const meta = (await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: accountId } })).meta;
    expect(meta).toMatchObject({ outraConfig: "preservada" });
    expect(lerEstadoNomes(meta)).toMatchObject({ agenda: 1, limpas: 1 });
    expect(evo.fetchEvolutionInstance).toHaveBeenCalledWith(expect.objectContaining({ instance: INSTANCE }));

    // Dentro do intervalo não consulta a Evolution; com `forcar` (histórico acabou de concluir), sim.
    evo.fetchEvolutionInstance.mockClear();
    expect(await sincronizarNomesWhatsApp(conta(), { agora: new Date(agora.getTime() + 60_000) })).toBeNull();
    expect(evo.fetchEvolutionInstance).not.toHaveBeenCalled();
    expect(await sincronizarNomesWhatsApp(conta(), { agora: new Date(agora.getTime() + 60_000), forcar: true })).not.toBeNull();
    expect(await sincronizarNomesWhatsApp(conta(), { agora: new Date(agora.getTime() + NOMES_WHATSAPP_INTERVALO_MS + 120_000) })).not.toBeNull();
  });

  it("conta desconectada, de outro time ou instância sumida da Evolution: não roda nem grava", async () => {
    expect(await sincronizarNomesWhatsApp({ ...conta(), teamId: OTHER })).toBeNull();
    await basePrisma.channelAccount.update({ where: { id: accountId }, data: { status: "disconnected" } });
    expect(await sincronizarNomesWhatsApp(conta())).toBeNull();
    expect(evo.fetchEvolutionInstance).not.toHaveBeenCalled();
    await basePrisma.channelAccount.update({ where: { id: accountId }, data: { status: "connected" } });
    evo.fetchEvolutionInstance.mockResolvedValueOnce(null);
    expect(await sincronizarNomesWhatsApp(conta())).toBeNull();
    expect(evo.fetchEvolutionContacts).not.toHaveBeenCalled();
    expect(lerEstadoNomes((await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: accountId } })).meta)).toBeNull();
  });

  it("agenda desligada na Evolution (lista vazia): só limpa, sem apagar nome de agenda já gravado", async () => {
    const c = await conv({ channelAccountId: accountId, externalNumber: "+5565944440001", externalName: "Você", nomeAgenda: "Joana" });
    const r = await sincronizarNomesWhatsApp(conta());
    expect(r).toMatchObject({ agenda: 0, contatosNaAgenda: 0, limpas: 1 });
    expect(await nomeDe(c.id)).toMatchObject({ externalName: null, nomeAgenda: "Joana" });
  });
});
