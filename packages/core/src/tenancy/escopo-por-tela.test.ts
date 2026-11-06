import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { list, getById } from "../contacts/service";
import { ContactNotFound } from "../contacts/errors";
import { listConversations } from "../conversations/service";
import { countUnreadConversations } from "../conversations/ultima-mensagem";
import { getFunnelBoard } from "../funnels/board";
import { listCalls } from "../calls/service";
import { kpis } from "../dashboard/service";
import { pontosDoMapa, filtrosDaQuery } from "../geo/mapa";
import { listarPessoasDoTime } from "../dono/service";
import { listAppointments } from "../agenda/service";
import { listAiConversations } from "../ai/conversations";
import { assertOwned, OwnedNotFound } from "./assert-owned";
import { moduloDeEscopoDaTela, veTudoNaTela, verTudoEmDoLegado, MODULOS_COM_DONO } from "../auth/modulos";
import { redisCache } from "../shared/redis-cache";

/**
 * "Ver tudo" POR TELA (pedido do dono, 28/09): o administrador escolhe, por
 * pessoa e por tela, "só os meus" ou "de todos". Dois vendedores do mesmo
 * time; A é liberado numa tela e não na outra — e o inverso. O que cada tela
 * mostra segue SÓ a sua escolha (e o cache não mistura as combinações).
 */
const TEAM = "00000000-0000-0000-0000-00000000f3e1";
const sufixo = Math.random().toString(36).slice(2, 7);
let master: { id: string }, a: { id: string }, b: { id: string };
let doA = "", doB = "", contaA = "", contaB = "", convB = "", funilId = "";

const como = <T>(u: { id: string }, role: string, fn: () => Promise<T>, verTudoEm: string[] = []) =>
  runWithTeam(TEAM, fn, { userId: u.id, role, verTudoEm });

async function limparCaches() {
  for (const padrao of [`inbox:naolidas:${TEAM}*`, `dash:${TEAM}:*`, `mapa:${TEAM}:*`]) {
    const chaves = await redisCache().keys(padrao).catch(() => [] as string[]);
    if (chaves.length) await redisCache().del(...chaves);
  }
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Ver tudo por tela (test)" } });
  const mk = (n: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `${n}-${sufixo}@por-tela.dev`, role } });
  master = await mk("master", "owner");
  await basePrisma.team.update({ where: { id: TEAM }, data: { masterId: master.id } });
  a = await mk("a", "member");
  b = await mk("b", "member");
  const ponto = { latitude: -12.5, longitude: -55.7 };
  doA = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead do A", ownerId: a.id, ...ponto } })).id;
  doB = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead do B", ownerId: b.id, ...ponto } })).id;
  const conta = (dono: { id: string }, label: string) =>
    basePrisma.channelAccount.create({ data: { teamId: TEAM, canal: "whatsapp", label, provider: "evolution", ownerId: dono.id, status: "connected" } });
  contaA = (await conta(a, "WhatsApp do A")).id;
  contaB = (await conta(b, "WhatsApp do B")).id;
  const conv = (accountId: string, nome: string) =>
    basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: accountId, externalNumber: `+55659${Math.floor(Math.random() * 1e8)}`, externalName: nome, unreadCount: 1 },
    });
  await conv(contaA, "Cliente do A");
  convB = (await conv(contaB, "Cliente do B")).id;
  const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
  funilId = funil.id;
  const etapa = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Novo", ordem: 0 } });
  for (const [contactId, dono] of [
    [doA, a],
    [doB, b],
  ] as const) {
    await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: etapa.id, contactId, ownerId: dono.id, valor: 100 } });
    await basePrisma.call.create({ data: { teamId: TEAM, contactId, phoneNumber: "+5565999990000", direction: "outbound", provider: "manual", userId: dono.id } });
    await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: `Visita de ${dono === a ? "A" : "B"}`, inicio: new Date(), responsavelId: dono.id } });
    await basePrisma.aiConversation.create({ data: { teamId: TEAM, userId: dono.id, titulo: `IA de ${dono === a ? "A" : "B"}`, messages: [] } });
  }
  await limparCaches();
});

afterAll(async () => {
  for (const m of ["aiConversation", "appointment", "call", "deal", "stage", "funnel", "message", "conversation", "channelAccount", "contact", "user"] as const) {
    await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: TEAM } });
  }
  await limparCaches();
});

const contatos = async (verTudoEm: string[]) => (await como(a, "member", () => list(), verTudoEm)).items.map((c) => c.nome).sort();
const conversas = async (conta: string, verTudoEm: string[]) =>
  (await como(a, "member", () => listConversations(conta), verTudoEm)).items.map((c) => c.displayName);

describe("'ver tudo' por tela — dois vendedores do mesmo time", () => {
  it("Contatos de todos, Conversas só as dele (e Funis/Ligações, não liberados, só os dele)", async () => {
    const soContatos = ["contatos"];
    expect(await contatos(soContatos)).toEqual(["Lead do A", "Lead do B"]);
    await expect(como(a, "member", () => getById(doB), soContatos)).resolves.toMatchObject({ nome: "Lead do B" });
    await expect(como(a, "member", () => assertOwned("contact", doB, { leitura: true }), soContatos)).resolves.toBeUndefined();

    expect(await conversas(contaA, soContatos)).toEqual(["Cliente do A"]);
    expect(await conversas(contaB, soContatos)).toEqual([]);
    expect(await como(a, "member", () => countUnreadConversations(), soContatos)).toBe(1);
    await expect(como(a, "member", () => assertOwned("conversation", convB, { leitura: true }), soContatos)).rejects.toBeInstanceOf(OwnedNotFound);

    const board = await como(a, "member", () => getFunnelBoard(funilId), soContatos);
    expect(board.stages.flatMap((s) => s.deals.map((d) => d.contact.nome))).toEqual(["Lead do A"]);
    expect((await como(a, "member", () => listCalls(), soContatos)).items).toHaveLength(1);

    // Painel e Mapa seguem Contatos (os contatos) e Funis (os negócios).
    const k = await como(a, "member", () => kpis(), soContatos);
    expect({ contatos: k.totalContatos, negocios: k.negociosAtivos.count }).toEqual({ contatos: 2, negocios: 1 });
    const pts = await como(a, "member", () => pontosDoMapa(filtrosDaQuery(new URLSearchParams(""))), soContatos);
    expect(pts.tipo === "pontos" ? [...pts.nome].sort() : []).toEqual(["Lead do A", "Lead do B"]);

    // "Por vendedor": a equipe aparece na tela liberada; nas outras, só ele.
    expect((await como(a, "member", () => listarPessoasDoTime("contatos"), soContatos)).map((p) => p.nome).sort()).toEqual(["a", "b", "master"]);
    expect((await como(a, "member", () => listarPessoasDoTime("conversas"), soContatos)).map((p) => p.id)).toEqual([a.id]);
  });

  it("o inverso: Conversas de todos, Contatos só os dele (o cache não reaproveita a combinação anterior)", async () => {
    const soConversas = ["conversas"];
    expect(await contatos(soConversas)).toEqual(["Lead do A"]);
    await expect(como(a, "member", () => getById(doB), soConversas)).rejects.toBeInstanceOf(ContactNotFound);
    await expect(como(a, "member", () => assertOwned("contact", doB, { leitura: true }), soConversas)).rejects.toBeInstanceOf(OwnedNotFound);

    expect(await conversas(contaB, soConversas)).toEqual(["Cliente do B"]);
    expect(await como(a, "member", () => countUnreadConversations(), soConversas)).toBe(2);
    await expect(como(a, "member", () => assertOwned("conversation", convB, { leitura: true }), soConversas)).resolves.toBeUndefined();

    const k = await como(a, "member", () => kpis(), soConversas);
    expect({ contatos: k.totalContatos, negocios: k.negociosAtivos.count }).toEqual({ contatos: 1, negocios: 1 });
    const pts = await como(a, "member", () => pontosDoMapa(filtrosDaQuery(new URLSearchParams(""))), soConversas);
    expect(pts.tipo === "pontos" ? [...pts.nome] : []).toEqual(["Lead do A"]);
  });

  it("Agenda também é por tela; o histórico do assistente de IA é pessoal (nenhuma tela libera)", async () => {
    const hoje = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
    const agenda = async (verTudoEm: string[]) => (await como(a, "member", () => listAppointments(hoje), verTudoEm)).map((c) => c.titulo).sort();
    expect(await agenda(["contatos"])).toEqual(["Visita de A"]);
    expect(await agenda(["agenda"])).toEqual(["Visita de A", "Visita de B"]);
    const ia = async (verTudoEm: string[]) => (await como(a, "member", () => listAiConversations(), verTudoEm)).map((c) => c.titulo).sort();
    expect(await ia([...MODULOS_COM_DONO])).toEqual(["IA de A"]);
    expect((await como(master, "owner", () => listAiConversations())).map((c) => c.titulo).sort()).toEqual(["IA de A", "IA de B"]);
  });

  it("sem nenhuma tela liberada, só os dele; com todas, igual ao master", async () => {
    expect(await contatos([])).toEqual(["Lead do A"]);
    expect(await conversas(contaB, [])).toEqual([]);
    expect(await contatos([...MODULOS_COM_DONO])).toEqual(["Lead do A", "Lead do B"]);
    expect(await conversas(contaB, [...MODULOS_COM_DONO])).toEqual(["Cliente do B"]);
  });
});

describe("'ver tudo' por tela — regras puras (tempo real e sessões antigas)", () => {
  it("cada tela do menu segue o 'ver tudo' da sua entidade; master/admin sempre veem", () => {
    expect(moduloDeEscopoDaTela("integracoes")).toBe("conversas");
    expect(moduloDeEscopoDaTela("painel")).toBe("contatos");
    expect(moduloDeEscopoDaTela("mapa")).toBe("contatos");
    expect(moduloDeEscopoDaTela("agenda")).toBe("agenda");
    expect(moduloDeEscopoDaTela("configuracoes")).toBeNull();
    expect(veTudoNaTela("member", ["contatos"], "conversas")).toBe(false);
    expect(veTudoNaTela("member", ["contatos"], "contatos")).toBe(true);
    expect(veTudoNaTela("admin", [], "conversas")).toBe(true);
    expect(veTudoNaTela("owner", null, "fluxos")).toBe(true);
  });

  it("token/job de antes da troca: 'verTudo: true' vale todas as telas; lista nova é normalizada", () => {
    expect(verTudoEmDoLegado(undefined, true)).toEqual([...MODULOS_COM_DONO]);
    expect(verTudoEmDoLegado(undefined, false)).toEqual([]);
    expect(verTudoEmDoLegado(["conversas", "x", "contatos"], true)).toEqual(["contatos", "conversas"]);
    expect(verTudoEmDoLegado("contatos")).toEqual([]);
  });
});
