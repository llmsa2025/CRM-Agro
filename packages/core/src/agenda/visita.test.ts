import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { env } from "@crmagro/config";
import { basePrisma, runWithTeam } from "@crmagro/db";

/**
 * Agenda (produto §E): visita com local e coordenada do contato, lembrete por
 * Web Push ao responsável (job agenda-lembrete) sem repetir, e a rota do dia
 * de UMA pessoa. Teste "dois times" no lembrete e na rota. O `web-push` é
 * MOCKADO: nenhum aviso sai de verdade.
 *
 * O job cruza times e a base de TESTE é compartilhada: os compromissos do job
 * ficam em 2032 e o `agora` do job é injetado, então só os nossos entram na janela.
 */
const wp = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async (..._args: unknown[]) => ({ statusCode: 201, body: "", headers: {} })),
}));
vi.mock("web-push", () => ({ default: wp, ...wp }));

const { createAppointment, updateAppointment, listDueAppointments } = await import("./service");
const { enviarLembretesDaAgenda } = await import("./lembrete");
const { rotaDoDia } = await import("../geo/rota");
const { reiniciarPushParaTeste } = await import("../push/service");
const { OwnedNotFound } = await import("../tenancy/assert-owned");
const { createManualCall, finishManualCall } = await import("../calls/service");
const { remove: removerContato } = await import("../contacts/service");

const TEAM = "00000000-0000-0000-0000-0000000006a3";
const OUTRO = "00000000-0000-0000-0000-0000000006a4";
const sufixo = Math.random().toString(36).slice(2, 8);

const U = {
  ana: { id: `ag-${sufixo}-ana`, teamId: TEAM, role: "member" },
  bia: { id: `ag-${sufixo}-bia`, teamId: TEAM, role: "member" },
  chefe: { id: `ag-${sufixo}-chefe`, teamId: TEAM, role: "admin" },
  outro: { id: `ag-${sufixo}-outro`, teamId: OUTRO, role: "owner" },
};
type Pessoa = (typeof U)[keyof typeof U];
const como = <T>(p: Pessoa, fn: () => Promise<T>) => runWithTeam(p.teamId, fn, { userId: p.id, role: p.role });
const ep = (p: Pessoa) => `https://fcm.googleapis.com/fcm/send/${sufixo}-${p.id}`;

const VAPID = { VAPID_PUBLIC_KEY: "BChave", VAPID_PRIVATE_KEY: "privada", VAPID_SUBJECT: "mailto:ops@exemplo.com.br" };
const envOriginal = { VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY, VAPID_SUBJECT: env.VAPID_SUBJECT };

async function limpar() {
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.appointment.deleteMany({ where: { teamId } });
    await basePrisma.activity.deleteMany({ where: { teamId } });
    await basePrisma.call.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Agenda A (test)" } });
  await basePrisma.team.upsert({ where: { id: OUTRO }, update: {}, create: { id: OUTRO, name: "Team Agenda B (test)" } });
  // Time B em Mato Grosso (UTC−4): a hora do lembrete sai no fuso do time.
  await basePrisma.teamConfig.upsert({
    where: { teamId: OUTRO },
    update: { timezone: "America/Cuiaba" },
    create: { teamId: OUTRO, timezone: "America/Cuiaba" },
  });
  for (const p of Object.values(U)) {
    await basePrisma.user.create({ data: { ...p, name: p.id, email: `${p.id}@teste.crmagro` } });
    await basePrisma.pushSubscription.create({ data: { teamId: p.teamId, userId: p.id, endpoint: ep(p), p256dh: "k", auth: "a" } });
  }
});
beforeEach(async () => {
  Object.assign(env, VAPID);
  reiniciarPushParaTeste();
  wp.sendNotification.mockClear();
  await limpar();
});
afterAll(async () => {
  Object.assign(env, envOriginal);
  reiniciarPushParaTeste();
  await limpar();
  await basePrisma.teamConfig.deleteMany({ where: { teamId: OUTRO } });
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.pushSubscription.deleteMany({ where: { teamId } });
    await basePrisma.user.deleteMany({ where: { teamId, id: { in: Object.values(U).map((p) => p.id) } } });
  }
});

/** Pushes enviados: [endpoint, payload]. */
const pushes = () =>
  wp.sendNotification.mock.calls.map((c) => [(c[0] as { endpoint: string }).endpoint, JSON.parse(c[1] as string)] as const);

async function contato(teamId: string, nome: string, lat: number | null = -12.54, lng: number | null = -55.72) {
  // Compartilhado (F3): o teste é da agenda, não do escopo por dono.
  return basePrisma.contact.create({ data: { teamId, nome, latitude: lat, longitude: lng, cidade: "Sorriso", estado: "MT", compartilhado: true } });
}

describe("visita", () => {
  it("criada da ficha: local, coordenada do contato, lembrete padrão de 30 min e responsável = quem criou", async () => {
    const c = await contato(TEAM, "Fazenda Boa Vista");
    const inicio = new Date("2032-05-17T13:00:00.000Z");
    const v = await como(U.ana, () =>
      createAppointment({ titulo: "Visita técnica", tipo: "visita", inicio: inicio.toISOString(), contactId: c.id, local: "Estrada do Arroz, km 12" }),
    );
    expect(v).toMatchObject({
      tipo: "visita",
      local: "Estrada do Arroz, km 12",
      latitude: -12.54,
      longitude: -55.72,
      lembreteMin: 30,
      lembreteEm: "2032-05-17T12:30:00.000Z", // trigger do banco
      responsavelId: U.ana.id,
      responsavelNome: U.ana.id,
    });
    // Reunião (não visita) não grava coordenada própria; a rota usa a do contato.
    const r = await como(U.ana, () => createAppointment({ titulo: "Reunião", tipo: "reuniao", inicio: inicio.toISOString(), contactId: c.id }));
    expect(r).toMatchObject({ latitude: null, longitude: null });
    // Trocar para visita herda a coordenada; sem lembrete → lembreteEm null.
    const r2 = await como(U.ana, () => updateAppointment(r.id, { tipo: "visita", lembreteMin: null }));
    expect(r2).toMatchObject({ latitude: -12.54, longitude: -55.72, lembreteMin: null, lembreteEm: null });
  });

  it("excluir o contato (LGPD) apaga também a coordenada copiada para a visita", async () => {
    const c = await contato(TEAM, "Produtor que pediu exclusão");
    const v = await como(U.ana, () =>
      createAppointment({ titulo: "Visita", tipo: "visita", inicio: "2032-05-17T13:00:00.000Z", contactId: c.id }),
    );
    expect(v.latitude).not.toBeNull();
    await como(U.chefe, () => removerContato(c.id));
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({
      contactId: null,
      latitude: null,
      longitude: null,
    });
  });

  it("retorno da caixa postal (ligações §D) fica com quem ligou", async () => {
    const c = await contato(TEAM, "Seu Zé");
    const { callId } = await como(U.ana, () => createManualCall({ phoneNumber: "+5565999000611", contactId: c.id }));
    const r = await como(U.ana, () => finishManualCall(callId, { outcome: "voicemail" }, { agora: new Date("2032-05-19T13:00:00Z") }));
    const a = await basePrisma.appointment.findUniqueOrThrow({ where: { id: r.retorno!.appointmentId } });
    expect(a).toMatchObject({ tipo: "ligacao", responsavelId: U.ana.id, lembreteMin: 30 });
  });

  it("responsável de outro time → não encontrado (dois times); lembrete fora de 0–1440 → recusado", async () => {
    const inicio = new Date("2032-05-17T13:00:00.000Z").toISOString();
    await expect(como(U.ana, () => createAppointment({ titulo: "x", inicio, responsavelId: U.outro.id }))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(como(U.ana, () => createAppointment({ titulo: "x", inicio, lembreteMin: 5000 }))).rejects.toThrow();
    const ok = await como(U.ana, () => createAppointment({ titulo: "p/ Bia", inicio, responsavelId: U.bia.id }));
    expect(ok.responsavelId).toBe(U.bia.id);
    // Quem remarca é a responsável (a Ana já não vê o compromisso da Bia — escopo da Agenda).
    await expect(como(U.bia, () => updateAppointment(ok.id, { responsavelId: U.outro.id }))).rejects.toBeInstanceOf(OwnedNotFound);
  });
});

describe("lembrete (job agenda-lembrete)", () => {
  const AGORA = new Date("2032-05-17T12:30:00.000Z");

  async function compromisso(p: Pessoa | null, teamId: string, inicio: string, extra: { lembreteMin?: number | null; titulo?: string } = {}) {
    return basePrisma.appointment.create({
      data: {
        teamId,
        titulo: extra.titulo ?? "Visita",
        tipo: "visita",
        inicio: new Date(inicio),
        responsavelId: p?.id ?? null,
        local: "Sede",
        ...(extra.lembreteMin !== undefined ? { lembreteMin: extra.lembreteMin } : {}),
      },
    });
  }

  it("vence em inicio − lembreteMin e vai só para o RESPONSÁVEL, no time dele (dois times)", async () => {
    const a = await compromisso(U.ana, TEAM, "2032-05-17T13:00:00.000Z"); // 30 min → vence agora
    await compromisso(U.bia, TEAM, "2032-05-17T13:00:00.000Z", { lembreteMin: 10 }); // ainda não
    await compromisso(U.outro, OUTRO, "2032-05-17T12:45:00.000Z", { lembreteMin: 15 }); // time B, vence agora
    await compromisso(U.chefe, TEAM, "2032-05-17T12:40:00.000Z", { lembreteMin: null }); // sem lembrete
    await compromisso(U.chefe, TEAM, "2032-05-17T12:10:00.000Z"); // começou há 20 min: não avisa atrasado

    await enviarLembretesDaAgenda(AGORA);
    const p = pushes();
    expect(p.map(([e]) => e).sort()).toEqual([ep(U.ana), ep(U.outro)].sort());
    expect(p.find(([e]) => e === ep(U.ana))![1]).toEqual({
      titulo: "Visita em 30 min (10:00)",
      corpo: "Visita · Sede",
      url: "/agenda",
      tag: `agenda-${a.id}`,
    });
    // Time B em Cuiabá: 12:45 UTC = 08:45 locais (em São Paulo seriam 09:45).
    expect(p.find(([e]) => e === ep(U.outro))![1].titulo).toBe("Visita em 15 min (08:45)");
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).lembreteEnviadoEm).toEqual(AGORA);
  });

  it("não repete: segunda rodada, rodadas simultâneas (2 workers) e restart mandam UM aviso", async () => {
    await compromisso(U.ana, TEAM, "2032-05-17T13:00:00.000Z");
    await Promise.all([enviarLembretesDaAgenda(AGORA), enviarLembretesDaAgenda(AGORA)]);
    await enviarLembretesDaAgenda(new Date(AGORA.getTime() + 60_000)); // rodada seguinte / após restart
    expect(pushes().filter(([e]) => e === ep(U.ana))).toHaveLength(1);
  });

  it("remarcar zera a marca (trigger) e o compromisso ganha lembrete novo", async () => {
    const a = await compromisso(U.ana, TEAM, "2032-05-17T13:00:00.000Z");
    await enviarLembretesDaAgenda(AGORA);
    await como(U.ana, () => updateAppointment(a.id, { inicio: "2032-05-17T14:00:00.000Z" }));
    const remarcado = await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(remarcado).toMatchObject({ lembreteEnviadoEm: null, lembreteEm: new Date("2032-05-17T13:30:00.000Z") });
    await enviarLembretesDaAgenda(new Date("2032-05-17T13:30:00.000Z"));
    expect(pushes().filter(([e]) => e === ep(U.ana))).toHaveLength(2);
  });

  it("compromisso do time (sem responsável) avisa owner/admin do time", async () => {
    await compromisso(null, TEAM, "2032-05-17T13:00:00.000Z");
    await enviarLembretesDaAgenda(AGORA);
    expect(pushes().map(([e]) => e)).toEqual([ep(U.chefe)]);
  });
});

describe("listDueAppointments (alerta na tela)", () => {
  it("considera lembreteMin e mostra só os do usuário logado + os do time", async () => {
    const em = (min: number) => new Date(Date.now() + min * 60_000);
    const doTime = await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Do time", inicio: em(30) } });
    const daAna = await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Ana 30", inicio: em(30), responsavelId: U.ana.id } });
    await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Ana 10", inicio: em(30), lembreteMin: 10, responsavelId: U.ana.id } });
    const semLembrete = await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Ana agora", inicio: em(0), lembreteMin: null, responsavelId: U.ana.id } });
    await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Da Bia", inicio: em(30), responsavelId: U.bia.id } });
    await basePrisma.appointment.create({ data: { teamId: OUTRO, titulo: "Outro time", inicio: em(30), responsavelId: U.outro.id } });

    const due = await como(U.ana, () => listDueAppointments());
    expect(due.map((d) => d.id).sort()).toEqual([doTime.id, daAna.id, semLembrete.id].sort());
  });
});

describe("rota do dia (uma pessoa)", () => {
  const DIA = "2032-05-18";
  const origem = { lat: -12.5, lng: -55.7 };

  it("só a do usuário logado + as do time; admin vê a de outro; membro não (dois times)", async () => {
    const perto = await contato(TEAM, "Perto", -12.55, -55.71);
    const longe = await contato(TEAM, "Longe", -13.0, -56.0);
    const doB = await contato(OUTRO, "Do outro time", -12.51, -55.7);
    const visita = await como(U.ana, () =>
      createAppointment({ titulo: "Visita Ana", tipo: "visita", inicio: `${DIA}T13:00:00.000Z`, contactId: longe.id }),
    );
    const doTime = await basePrisma.appointment.create({ data: { teamId: TEAM, titulo: "Do time", inicio: new Date(`${DIA}T15:00:00.000Z`), contactId: perto.id } });
    const daBia = await como(U.bia, () => createAppointment({ titulo: "Visita Bia", tipo: "visita", inicio: `${DIA}T14:00:00.000Z`, contactId: perto.id }));
    await basePrisma.appointment.create({ data: { teamId: OUTRO, titulo: "Time B", inicio: new Date(`${DIA}T13:00:00.000Z`), contactId: doB.id } });

    const daAna = await como(U.ana, () => rotaDoDia({ data: DIA, origem }));
    expect(daAna.paradas.map((p) => p.appointmentId).sort()).toEqual([visita.id, doTime.id].sort());

    const bia = await como(U.chefe, () => rotaDoDia({ data: DIA, origem, responsavelId: U.bia.id }));
    expect(bia.paradas.map((p) => p.appointmentId).sort()).toEqual([daBia.id, doTime.id].sort());

    await expect(como(U.ana, () => rotaDoDia({ data: DIA, responsavelId: U.bia.id }))).rejects.toThrow(/negado/i);
    await expect(como(U.chefe, () => rotaDoDia({ data: DIA, responsavelId: U.outro.id }))).rejects.toBeInstanceOf(OwnedNotFound);
    const b = await como(U.outro, () => rotaDoDia({ data: DIA }));
    expect(b.paradas.map((p) => p.titulo)).toEqual(["Time B"]);
  });

  it("usa a coordenada ATUAL do contato (geocodificação melhora depois); a cópia da visita só sem ela", async () => {
    // Contato recém-captado: centro da cidade (IBGE) quando a visita é marcada.
    const c = await contato(TEAM, "Recém-captado", -12.5459, -55.7211);
    const v = await como(U.ana, () =>
      createAppointment({ titulo: "Visita", tipo: "visita", inicio: `${DIA}T13:00:00.000Z`, contactId: c.id }),
    );
    expect(v).toMatchObject({ latitude: -12.5459, longitude: -55.7211 });
    // Dias depois o Nominatim acha a fazenda, a 30 km do centro.
    await basePrisma.contact.update({ where: { id: c.id }, data: { latitude: -12.8, longitude: -55.9, geoPrecisao: "endereco" } });
    const r = await como(U.ana, () => rotaDoDia({ data: DIA, origem }));
    expect(r.paradas.find((p) => p.appointmentId === v.id)).toMatchObject({ lat: -12.8, lng: -55.9 });
    // Contato ficou sem coordenada (endereço apagado): a rota usa a cópia da visita.
    await basePrisma.contact.update({ where: { id: c.id }, data: { latitude: null, longitude: null } });
    const r2 = await como(U.ana, () => rotaDoDia({ data: DIA, origem }));
    expect(r2.paradas.find((p) => p.appointmentId === v.id)).toMatchObject({ lat: -12.5459, lng: -55.7211 });
  });
});
