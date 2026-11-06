import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { ForbiddenError } from "../auth/authz";
import { getById, update, addNote, remove } from "../contacts/service";
import { setContactTag } from "../tags/service";
import { getFunnelBoard } from "../funnels/board";
import { moveDeal, updateDealValor, deleteDeal } from "../funnels/service";
import { listConversations, sendMessage, markRead } from "../conversations/service";
import { assertOwned, EdicaoNaoPermitida, OwnedNotFound } from "./assert-owned";
import { editarTudoEmDoLegado, normalizarEditarTudoEm } from "../auth/modulos";
import { redisCache } from "../shared/redis-cache";

/**
 * "Editar" POR TELA (pedido do dono, 28/09): por tela, "Só os meus", "Ver de
 * todos" (lê os dos colegas, NÃO altera) e "Ver e editar de todos". O vendedor
 * A olha os registros do vendedor B com cada uma das opções.
 *
 * Nenhum envio real: a conta do B aponta para uma instância que não existe e a
 * recusa (`EdicaoNaoPermitida`) tem de vir ANTES do provedor — o teste confere
 * o TIPO do erro, então uma falha de envio não passaria por recusa.
 */
const TEAM = "00000000-0000-0000-0000-00000000f3e2";
const sufixo = Math.random().toString(36).slice(2, 7);
const TELAS = ["contatos", "funis", "conversas"];
const SO_VER = { verTudoEm: TELAS, editarTudoEm: [] as string[] };
const VER_E_EDITAR = { verTudoEm: TELAS, editarTudoEm: TELAS };

let master: { id: string }, a: { id: string }, b: { id: string };
let doB = "", comum = "", tagId = "", dealB = "", etapa1 = "", etapa2 = "", funilId = "", contaB = "", convB = "";

const comoA = <T>(fn: () => Promise<T>, acesso: { verTudoEm: string[]; editarTudoEm: string[] }) =>
  runWithTeam(TEAM, fn, { userId: a.id, role: "member", ...acesso });

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Editar por tela (test)" } });
  const mk = (n: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `${n}-${sufixo}@editar.dev`, role } });
  master = await mk("master", "owner");
  await basePrisma.team.update({ where: { id: TEAM }, data: { masterId: master.id } });
  a = await mk("a", "member");
  b = await mk("b", "member");
  doB = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead do B", ownerId: b.id } })).id;
  comum = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead do time", ownerId: b.id, compartilhado: true } })).id;
  tagId = (await basePrisma.tag.create({ data: { teamId: TEAM, nome: `Quente ${sufixo}`, cor: "#f00" } })).id;
  const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
  funilId = funil.id;
  etapa1 = (await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Novo", ordem: 0 } })).id;
  etapa2 = (await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Proposta", ordem: 1 } })).id;
  dealB = (await basePrisma.deal.create({ data: { teamId: TEAM, funnelId: funil.id, stageId: etapa1, contactId: doB, ownerId: b.id, valor: 100 } })).id;
  // Número do B: instância que NÃO existe na Evolution (nada sai, mesmo se a guarda falhasse).
  contaB = (
    await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WhatsApp do B", provider: "evolution", externalId: `nao-existe-${sufixo}`, ownerId: b.id, status: "connected" },
    })
  ).id;
  convB = (
    await basePrisma.conversation.create({
      data: { teamId: TEAM, canal: "whatsapp", channelAccountId: contaB, externalNumber: "+5565900000000", externalName: "Cliente do B", unreadCount: 1 },
    })
  ).id;
  const chaves = await redisCache().keys(`inbox:naolidas:${TEAM}*`).catch(() => [] as string[]);
  if (chaves.length) await redisCache().del(...chaves);
});

afterAll(async () => {
  for (const m of ["message", "conversation", "channelAccount", "activity", "deal", "stage", "funnel", "contactTag", "tag", "channelIdentifier", "contact", "user"] as const) {
    await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: TEAM } });
  }
});

describe("editar por tela — Contatos", () => {
  it("'Ver de todos': lê o contato do colega, mas não edita, não marca tag, não anota (e excluir continua do administrador)", async () => {
    await expect(comoA(() => getById(doB), SO_VER)).resolves.toMatchObject({ nome: "Lead do B" });
    await expect(comoA(() => update(doB, { cidade: "Sinop" }), SO_VER)).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    await expect(comoA(() => setContactTag(doB, tagId), SO_VER)).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    await expect(comoA(() => addNote(doB, "nota do A"), SO_VER)).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    // Excluir contato é do administrador (RBAC `contacts.delete`), com ou sem "editar".
    await expect(comoA(() => remove(doB), SO_VER)).rejects.toBeInstanceOf(ForbiddenError);
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: doB } });
    expect(c.cidade).toBeNull();
    expect(await basePrisma.contactTag.count({ where: { contactId: doB } })).toBe(0);
  });

  it("'Ver e editar de todos': edita, marca tag e anota no contato do colega", async () => {
    await comoA(() => update(doB, { cidade: "Sinop" }), VER_E_EDITAR);
    await comoA(() => setContactTag(doB, tagId), VER_E_EDITAR);
    await comoA(() => addNote(doB, "nota do A"), VER_E_EDITAR);
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: doB } })).cidade).toBe("Sinop");
    expect(await basePrisma.contactTag.count({ where: { contactId: doB, tagId } })).toBe(1);
  });

  it("compartilhado com o time: quem vê, edita (mesmo sem nenhuma tela liberada)", async () => {
    await comoA(() => update(comum, { cidade: "Sorriso" }), { verTudoEm: [], editarTudoEm: [] });
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: comum } })).cidade).toBe("Sorriso");
  });
});

describe("editar por tela — Funis", () => {
  it("'Ver de todos': o negócio do colega aparece no kanban, mas não move, não muda valor, não exclui", async () => {
    const board = await comoA(() => getFunnelBoard(funilId), SO_VER);
    expect(board.stages.flatMap((s) => s.deals.map((d) => d.id))).toContain(dealB);
    await expect(comoA(() => moveDeal(dealB, etapa2), SO_VER)).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    await expect(comoA(() => updateDealValor(dealB, 999), SO_VER)).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    await expect(comoA(() => deleteDeal(dealB), SO_VER)).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    expect(await basePrisma.deal.findUniqueOrThrow({ where: { id: dealB } })).toMatchObject({ stageId: etapa1 });
  });

  it("'Ver e editar de todos': move o negócio do colega", async () => {
    await comoA(() => moveDeal(dealB, etapa2), VER_E_EDITAR);
    expect((await basePrisma.deal.findUniqueOrThrow({ where: { id: dealB } })).stageId).toBe(etapa2);
  });
});

describe("editar por tela — Conversas (nenhum envio real)", () => {
  it("'Ver de todos': lê a conversa do número do colega; enviar é recusado ANTES do provedor; abrir não zera o contador dele", async () => {
    const nomes = (await comoA(() => listConversations(contaB), SO_VER)).items.map((c) => c.displayName);
    expect(nomes).toEqual(["Cliente do B"]);
    await expect(comoA(() => sendMessage(convB, "oi"), SO_VER)).rejects.toBeInstanceOf(EdicaoNaoPermitida);
    expect(await basePrisma.message.count({ where: { conversationId: convB } })).toBe(0);
    await expect(comoA(() => markRead(convB), SO_VER)).resolves.toBeUndefined();
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: convB } })).unreadCount).toBe(1);
  });

  it("'Ver e editar de todos': a conversa do colega passa na guarda de escrita e abrir zera o contador", async () => {
    await expect(comoA(() => assertOwned("conversation", convB), VER_E_EDITAR)).resolves.toBeUndefined();
    await comoA(() => markRead(convB), VER_E_EDITAR);
    expect((await basePrisma.conversation.findUniqueOrThrow({ where: { id: convB } })).unreadCount).toBe(0);
  });

  it("sem 'ver' nem 'editar': a conversa do colega nem aparece (não encontrado, não 'sem permissão')", async () => {
    await expect(comoA(() => assertOwned("conversation", convB), { verTudoEm: [], editarTudoEm: [] })).rejects.toBeInstanceOf(OwnedNotFound);
  });
});

describe("editar por tela — regras puras", () => {
  it("editar fica sempre dentro de ver; token/job antigo sem a lista edita onde vê (como era)", () => {
    expect(normalizarEditarTudoEm(["contatos", "funis", "x"], ["contatos"])).toEqual(["contatos"]);
    expect(editarTudoEmDoLegado(undefined, ["contatos", "conversas"])).toEqual(["contatos", "conversas"]);
    expect(editarTudoEmDoLegado([], ["contatos"])).toEqual([]);
    expect(editarTudoEmDoLegado(["conversas"], ["contatos"])).toEqual([]);
  });
});
