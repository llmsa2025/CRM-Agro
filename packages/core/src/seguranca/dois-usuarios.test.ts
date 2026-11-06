import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { redisCache } from "../shared/redis-cache";

/**
 * Auditoria de isolamento 09/2026 — padrão "dois usuários do mesmo time"
 * ("cada um vê o seu"). Relatório: a documentação interna.
 *
 * Falhas corrigidas nesta auditoria (o teste prova a correção):
 *  - S-01 fluxo ativado pelo `updateFlow` (status) sem `flows.activate`;
 *  - S-02 histórico do assistente de IA era do time inteiro;
 *  - S-04 Agenda sem escopo por pessoa;
 *  - S-09 importações sem escopo por quem subiu;
 *  - S-13 bloco do WhatsApp do menu mostrava o número do master.
 * E proteções que já existiam, travadas por teste.
 *
 * Fila do motor mockada: ativar um fluxo não agenda nada de verdade. Nenhuma
 * mensagem sai: as contas de canal são linhas do banco de teste, sem provedor.
 */
vi.mock("../flows/queue", () => ({
  scheduleStep: vi.fn(),
  getFlowQueue: () => ({}),
  flowJobId: (e: string, n: string, r: number) => `${e}-${n}-${r}`,
  acordarPasso: vi.fn(),
  removeStepJob: vi.fn(),
  getStepJobState: vi.fn(async () => null),
}));

const { createFlow, updateFlow } = await import("../flows/service");
const { FlowNotFound } = await import("../flows/errors");
const { ForbiddenError } = await import("../auth/authz");
const { saveAiConversation, getAiConversation, listAiConversations, deleteAiConversation } = await import("../ai/conversations");
const { createAppointment, listAppointments, listUpcomingAppointments, updateAppointment, setAppointmentStatus, deleteAppointment } =
  await import("../agenda/service");
const { listImportJobs, getImportJob, cancelImport } = await import("../importacao/jobs");
const { getPrimaryWhatsAppStatus, invalidarStatusWhatsApp } = await import("../channels-limit/service");
const { getEmailAccountConfig } = await import("../email/service");
const { definirCompartilhado } = await import("../dono/service");
const { OwnedNotFound } = await import("../tenancy/assert-owned");
const { createCall, anotarCamposDaLigacao, getCall } = await import("../calls/service");

const TEAM = "00000000-0000-0000-0000-00000005ec2a";
const sufixo = Math.random().toString(36).slice(2, 7);
let master: { id: string }, a: { id: string }, b: { id: string };
let contatoDoA = "", contatoComum = "";

const como = <T>(u: { id: string }, role: string, fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: u.id, role });
const JANELA = { from: "2032-04-01T00:00:00.000Z", to: "2032-04-02T00:00:00.000Z" };
let seq = 0;
const noUnico = () => [{ id: `seg-n-${sufixo}-${Date.now()}-${seq++}`, tipo: "wait", config: { minutos: 1 }, nextNodeId: null }] as never;

async function limpar() {
  for (const m of ["appointment", "aiConversation", "importJob", "flowNode", "flow", "activity", "call", "channelAccountUsage", "channelAccount", "contact"] as const) {
    await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: TEAM } });
  }
  await basePrisma.user.deleteMany({ where: { teamId: TEAM } });
}

beforeAll(async () => {
  await limpar();
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Seg dois usuários (test)" } });
  const mk = (n: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `seg-2u-${n}-${sufixo}@teste.crmagro`, role } });
  master = await mk("master", "owner");
  a = await mk("a", "member");
  b = await mk("b", "member");
  contatoDoA = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: `Cliente do A ${sufixo}`, ownerId: a.id } })).id;
  contatoComum = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: `Cliente do time ${sufixo}`, ownerId: master.id, compartilhado: true } })).id;
});

afterAll(limpar);

describe("fluxos — ativar é do administrador, inclusive pelo updateFlow (S-01, corrigido)", () => {
  it("membro manda status 'active' no updateFlow: recusado ANTES de gravar qualquer coisa", async () => {
    const f = await como(a, "member", () => createFlow({ nome: `Fluxo do A ${sufixo}`, triggerType: "manual", nodes: noUnico() }));
    await expect(como(a, "member", () => updateFlow(f.id, { status: "active", nome: "renomeado" }))).rejects.toBeInstanceOf(ForbiddenError);
    const depois = await basePrisma.flow.findUniqueOrThrow({ where: { id: f.id } });
    expect(depois).toMatchObject({ status: "draft", nome: `Fluxo do A ${sufixo}` });
    // Editar (sem mexer no status) continua sendo do membro.
    await como(a, "member", () => updateFlow(f.id, { nome: `Fluxo do A v2 ${sufixo}` }));
    expect((await basePrisma.flow.findUniqueOrThrow({ where: { id: f.id } })).nome).toBe(`Fluxo do A v2 ${sufixo}`);
    // O colega nem enxerga o fluxo (escopo por dono).
    await expect(como(b, "member", () => updateFlow(f.id, { nome: "x" }))).rejects.toBeInstanceOf(FlowNotFound);
  });

  it("master ativando pelo updateFlow passa pelas MESMAS travas do activateFlow", async () => {
    // "Mudou de etapa" sem etapa escolhida pegaria QUALQUER mudança de QUALQUER funil.
    const solto = await como(master, "owner", () => createFlow({ nome: `Sem etapa ${sufixo}`, triggerType: "stage_changed", nodes: noUnico() }));
    await expect(como(master, "owner", () => updateFlow(solto.id, { status: "active" }))).rejects.toMatchObject({ name: "InvalidGraphError" });
    expect((await basePrisma.flow.findUniqueOrThrow({ where: { id: solto.id } })).status).toBe("draft");
    const ok = await como(master, "owner", () => createFlow({ nome: `Manual ${sufixo}`, triggerType: "manual", nodes: noUnico() }));
    const ativo = await como(master, "owner", () => updateFlow(ok.id, { status: "active", nome: `Manual ativo ${sufixo}` }));
    expect(ativo).toMatchObject({ status: "active", nome: `Manual ativo ${sufixo}` });
    expect(ativo.nodes).toHaveLength(1);
  });
});

describe("assistente de IA — cada um vê as suas conversas (S-02, corrigido)", () => {
  it("B não lista, não abre, não sobrescreve e não apaga a do A; master vê as do time; antiga sem dono só master", async () => {
    const doA = await como(a, "member", () => saveAiConversation({ messages: [{ role: "user", content: `pergunta do A ${sufixo}` }] }));
    expect((await basePrisma.aiConversation.findUniqueOrThrow({ where: { id: doA.id } })).userId).toBe(a.id);
    const antiga = await basePrisma.aiConversation.create({
      data: { teamId: TEAM, titulo: "antiga", messages: [{ role: "user", content: "de antes da auditoria" }] },
    });

    expect((await como(b, "member", () => listAiConversations())).map((c) => c.id)).toEqual([]);
    expect(await como(b, "member", () => getAiConversation(doA.id))).toBeNull();
    expect(await como(b, "member", () => getAiConversation(antiga.id))).toBeNull();
    const deB = await como(b, "member", () => saveAiConversation({ id: doA.id, messages: [{ role: "user", content: "sobrescrevi" }] }));
    expect(deB.id).not.toBe(doA.id); // virou uma conversa NOVA, do B
    await como(b, "member", () => deleteAiConversation(doA.id));
    expect(JSON.stringify((await basePrisma.aiConversation.findUniqueOrThrow({ where: { id: doA.id } })).messages)).toContain(`pergunta do A ${sufixo}`);

    // O dono continua usando a dele (atualiza no lugar).
    const mesmo = await como(a, "member", () => saveAiConversation({ id: doA.id, messages: [{ role: "user", content: `pergunta do A editada ${sufixo}` }] }));
    expect(mesmo.id).toBe(doA.id);
    expect((await como(a, "member", () => listAiConversations())).map((c) => c.id)).toEqual([doA.id]);

    // Master vê as do time (regra do escopo), inclusive a antiga sem dono.
    expect((await como(master, "owner", () => listAiConversations())).map((c) => c.id)).toEqual(expect.arrayContaining([doA.id, deB.id, antiga.id]));
  });
});

describe("agenda — cada um vê os compromissos dele (S-04, corrigido)", () => {
  it("B não vê, não remarca, não conclui e não apaga o compromisso do A; vê os do time que pode ver; master vê todos", async () => {
    const inicio = "2032-04-01T13:00:00.000Z";
    const doA = await como(a, "member", () => createAppointment({ titulo: `Visita do A ${sufixo}`, tipo: "visita", inicio, contactId: contatoDoA }));
    // "Do time" (sem responsável, como os da automação): sem contato, com contato compartilhado e com contato do A.
    const timeSemContato = await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Reunião geral", inicio: new Date(inicio) } });
    const timeComum = await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Ligar p/ cliente do time", inicio: new Date(inicio), contactId: contatoComum } });
    const timeDoA = await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Retorno do cliente do A", inicio: new Date(inicio), contactId: contatoDoA } });

    const ids = async (u: { id: string }, role: string) => (await como(u, role, () => listAppointments(JANELA))).map((x) => x.id).sort();
    expect(await ids(b, "member")).toEqual([timeSemContato.id, timeComum.id].sort());
    expect(await ids(a, "member")).toEqual([doA.id, timeSemContato.id, timeComum.id, timeDoA.id].sort());
    expect(await ids(master, "owner")).toEqual([doA.id, timeSemContato.id, timeComum.id, timeDoA.id].sort());

    await expect(como(b, "member", () => updateAppointment(doA.id, { titulo: "invadido" }))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(como(b, "member", () => setAppointmentStatus(doA.id, "cancelado"))).rejects.toBeInstanceOf(OwnedNotFound);
    await como(b, "member", () => deleteAppointment(doA.id));
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: doA.id } })).toMatchObject({ titulo: `Visita do A ${sufixo}`, status: "pendente" });

    // O dono e o master continuam mexendo.
    await como(a, "member", () => updateAppointment(doA.id, { titulo: `Visita do A (remarcada) ${sufixo}` }));
    await como(master, "owner", () => setAppointmentStatus(doA.id, "concluido"));
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: doA.id } })).toMatchObject({ status: "concluido" });
  });

  it("'próximos compromissos' (Painel) segue o mesmo escopo", async () => {
    const futuro = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
    const doA = await como(a, "member", () => createAppointment({ titulo: `Próximo do A ${sufixo}`, inicio: futuro }));
    expect((await como(b, "member", () => listUpcomingAppointments(50))).map((x) => x.id)).not.toContain(doA.id);
    expect((await como(a, "member", () => listUpcomingAppointments(50))).map((x) => x.id)).toContain(doA.id);
  });
});

describe("importação — de quem subiu a planilha (S-09, corrigido)", () => {
  it("B não lista, não abre e não cancela a importação do A; master vê todas", async () => {
    const job = (dono: { id: string }, nome: string) =>
      basePrisma.importJob.create({ data: { teamId: TEAM, nomeArquivo: nome, mapeamento: ["nome"], opcoes: {}, createdById: dono.id } });
    const doA = await job(a, `clientes-do-a-${sufixo}.csv`);
    const doB = await job(b, `clientes-do-b-${sufixo}.csv`);

    expect((await como(b, "member", () => listImportJobs(50))).map((j) => j.id)).toEqual([doB.id]);
    await expect(como(b, "member", () => getImportJob(doA.id))).rejects.toMatchObject({ name: "ImportJobNotFound" });
    await expect(como(b, "member", () => cancelImport(doA.id))).rejects.toMatchObject({ name: "ImportJobNotFound" });
    expect((await basePrisma.importJob.findUniqueOrThrow({ where: { id: doA.id } })).status).toBe("queued");

    expect((await como(master, "owner", () => listImportJobs(50))).map((j) => j.id)).toEqual(expect.arrayContaining([doA.id, doB.id]));
    expect((await como(a, "member", () => cancelImport(doA.id))).status).toBe("canceled");
  });
});

describe("menu do WhatsApp — o número que a pessoa vê (S-13, corrigido)", () => {
  it("vendedor vê o número dele (não o do master); quem não tem número vê nada; master vê o principal do time", async () => {
    const doMaster = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WA do master", provider: "evolution", status: "connected", ownerId: master.id, createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const doA = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "whatsapp", label: "WA do A", provider: "evolution", status: "connected", ownerId: a.id, createdAt: new Date("2026-06-01T00:00:00Z") },
    });
    await invalidarStatusWhatsApp(TEAM);
    expect(await como(master, "owner", () => getPrimaryWhatsAppStatus())).toMatchObject({ channelAccountId: doMaster.id });
    expect(await como(a, "member", () => getPrimaryWhatsAppStatus())).toMatchObject({ channelAccountId: doA.id, label: "WA do A" });
    expect(await como(b, "member", () => getPrimaryWhatsAppStatus())).toBeNull();
    // Cache por escopo: a leitura do master não "vaza" para o vendedor na janela de 60 s.
    expect(await como(a, "member", () => getPrimaryWhatsAppStatus())).toMatchObject({ channelAccountId: doA.id });
    await basePrisma.channelAccount.deleteMany({ where: { id: { in: [doMaster.id, doA.id] } } });
    await invalidarStatusWhatsApp(TEAM);
  });
});

describe("ligação registrada no contato do colega (S-10, corrigido)", () => {
  // O POST /api/calls saiu na F1A-08: a regra segue em `createCall`, a escrita interna que o discador usa.
  it("createCall (interno) recusa o contato de outro vendedor; nada entra na linha do tempo dele", async () => {
    await expect(
      como(b, "member", () => createCall({ contactId: contatoDoA, phoneNumber: "+5565999990001", direction: "outbound", provider: "manual" })),
    ).rejects.toThrow(/ContactNotFound/);
    expect(await basePrisma.call.count({ where: { teamId: TEAM, contactId: contatoDoA } })).toBe(0);
    expect(await basePrisma.activity.count({ where: { teamId: TEAM, contactId: contatoDoA, tipo: "call" } })).toBe(0);
    // O dono do contato e o contato compartilhado continuam valendo.
    const doA = await como(a, "member", () => createCall({ contactId: contatoDoA, phoneNumber: "+5565999990001", direction: "outbound", provider: "manual" }));
    expect(doA.contact).toMatchObject({ id: contatoDoA });
    await como(b, "member", () => createCall({ contactId: contatoComum, phoneNumber: "+5565999990002", direction: "outbound", provider: "manual" }));
  });
});

describe("anotar a ligação pela API: só quem ligou (F1A-08)", () => {
  it("o vendedor B não anota a ligação do A; o A, o administrador e quem edita de todos anotam; ver de todos só lê", async () => {
    const doA = await como(a, "member", () => createCall({ contactId: contatoDoA, phoneNumber: "+5565999990011", direction: "outbound", provider: "manual" }));
    const notasDe = async () => (await basePrisma.call.findUniqueOrThrow({ where: { id: doA.id } })).notes;

    // B: a ligação do A nem aparece para ele; recusa com a mesma resposta de "não existe", e nada muda.
    await expect(como(b, "member", () => getCall(doA.id))).rejects.toThrow(/CallNotFound/);
    await expect(como(b, "member", () => anotarCamposDaLigacao(doA.id, { notes: "do B" }))).rejects.toThrow(/CallNotFound/);
    expect(await notasDe()).toBeNull();

    // "Ver de todos" em Ligações lê a ligação do colega, mas não altera.
    const veDeTodos = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: b.id, role: "member", verTudoEm: ["ligacoes"] });
    expect(await veDeTodos(() => getCall(doA.id))).toMatchObject({ id: doA.id });
    await expect(veDeTodos(() => anotarCamposDaLigacao(doA.id, { notes: "do B lendo" }))).rejects.toThrow(/CallNotFound/);
    expect(await notasDe()).toBeNull();

    // O próprio vendedor, o master e quem edita de todos anotam.
    await como(a, "member", () => anotarCamposDaLigacao(doA.id, { notes: "do A" }));
    expect(await notasDe()).toBe("do A");
    await como(master, "owner", () => anotarCamposDaLigacao(doA.id, { notes: "do master" }));
    expect(await notasDe()).toBe("do master");
    await runWithTeam(TEAM, () => anotarCamposDaLigacao(doA.id, { notes: "do B editando tudo" }), {
      userId: b.id,
      role: "member",
      verTudoEm: ["ligacoes"],
      editarTudoEm: ["ligacoes"],
    });
    expect(await notasDe()).toBe("do B editando tudo");
  });
});

describe("proteções que já existiam (travadas por teste)", () => {
  it("configuração da caixa de e-mail do colega não abre", async () => {
    const caixaA = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "email", label: "E-mail do A", provider: "smtp", status: "connected", ownerId: a.id, credentials: { host: "smtp.exemplo.invalid", user: "a@exemplo.invalid" } },
    });
    expect(await como(b, "member", () => getEmailAccountConfig(caixaA.id))).toBeNull();
    expect(await como(a, "member", () => getEmailAccountConfig(caixaA.id))).toMatchObject({ id: caixaA.id, host: "smtp.exemplo.invalid", hasPass: false });
    await basePrisma.channelAccount.delete({ where: { id: caixaA.id } });
  });

  it("só o dono (ou o admin) muda o compartilhamento; o vendedor não 'descompartilha' o contato do master", async () => {
    await expect(como(a, "member", () => definirCompartilhado("contact", contatoComum, false))).rejects.toMatchObject({ name: "SoODonoCompartilha" });
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: contatoComum } })).compartilhado).toBe(true);
  });
});

// Garante que o cache do Redis de teste esteja pronto antes dos testes de cache.
beforeAll(async () => {
  const r = redisCache();
  if (r.status !== "ready") await new Promise((ok) => r.once("ready", ok));
});
