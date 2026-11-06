import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { env } from "@crmagro/config";
import { basePrisma, runWithTeam, runAsSystem, runVendoComo, encryptCredentials, decryptCredentials, estaCifrado } from "@crmagro/db";

/**
 * Google Agenda + Meet (fase 1, decisões do dono de 28/09) — com o Google
 * SIMULADO. Nenhum teste chama a API de verdade: criar evento com convidado
 * manda convite real. O módulo `./cliente` (único que fala com o Google) é
 * trocado por uma agenda em memória; a fila e o envio do .ics também são
 * simulados. `vi.mock` isolado neste arquivo (nada de spyOn no basePrisma).
 */
const g = vi.hoisted(() => ({
  trocarCodigo: vi.fn(),
  renovarAccessToken: vi.fn(),
  revogarToken: vi.fn(),
  inserirEvento: vi.fn(),
  atualizarEvento: vi.fn(),
  cancelarEvento: vi.fn(),
  obterEvento: vi.fn(),
  listarEventos: vi.fn(),
  assistirAgenda: vi.fn(),
  pararCanal: vi.fn(),
}));
vi.mock("./cliente", async (importOriginal) => ({ ...(await importOriginal<typeof import("./cliente")>()), ...g }));
const fila = vi.hoisted(() => ({ enfileirarSyncGoogle: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("./fila", async (importOriginal) => ({ ...(await importOriginal<typeof import("./fila")>()), ...fila }));
const email = vi.hoisted(() => ({ sendCalendarInvite: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("../../email/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../email/service")>()), ...email }));
const wp = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })) }));
vi.mock("web-push", () => ({ default: wp, ...wp }));

const { GoogleApiErro, GoogleAutorizacaoInvalida, ESCOPO_AGENDA } = await import("./cliente");
type EventoGoogle = import("./cliente").EventoGoogle;
const {
  iniciarConexaoGoogle,
  concluirConexaoGoogle,
  desconectarGoogle,
  minhaConexaoGoogle,
  processarRevogacoesPendentes,
  EstadoOAuthInvalido,
  PermissaoDaAgendaNegada,
  AgendaGoogleDeOutraPessoa,
  AgendaGoogleNaoLiberada,
  agendaGoogleLiberadaParaMim,
  assinarEstado,
  lerLiberados,
} = await import("./conexao");
const { pedirSincronizacaoGoogle } = await import("./pedido");
const { sincronizarConexaoGoogle, receberAvisoDoGoogle, tokenDoCanal, CAMPOS_DA_LISTA } = await import("./sincronizacao");
const { enviarPendentesAoGoogle, idDoEventoGoogle, linkDaReuniao, provedorDaReuniao } = await import("./envio");
const { manutencaoAgendaGoogle, processarJobAgendaGoogle } = await import("./trabalho");
const {
  createAppointment,
  updateAppointment,
  ConfirmarAntesDeTransferir,
  setAppointmentStatus,
  deleteAppointment,
  listAppointments,
  desvincularDoGoogle,
  confirmarDoGoogle,
  ConviteSoPeloResponsavel,
  AlteracaoSoPeloResponsavel,
  LimiteDeConvidados,
} = await import("../service");
const { rotaDoDia } = await import("../../geo/rota");
const { listarOcupados } = await import("../ocupado");
const { desativarIntegrante, excluirIntegrante } = await import("../../auth/equipe");
const { ForbiddenError } = await import("../../auth/authz");
const { EdicaoNaoPermitida, OwnedNotFound } = await import("../../tenancy/assert-owned");
const { redisEstado } = await import("../../shared/redis-cache");

const TEAM = "00000000-0000-0000-0000-00000009a9e1";
const OUTRO = "00000000-0000-0000-0000-00000009a9e2";
const sufixo = Math.random().toString(36).slice(2, 8);
const CLIENT_ID = "cliente-teste.apps.googleusercontent.com";

type Pessoa = { id: string; teamId: string; role: string; nome: string; email: string };
const pessoa = (nome: string, teamId: string, role: string): Pessoa => ({ id: randomUUID(), teamId, role, nome, email: `${nome}-${sufixo}@teste.crmagro` });
const U = {
  dono: pessoa("dono", TEAM, "owner"),
  chefe: pessoa("chefe", TEAM, "admin"),
  ana: pessoa("ana", TEAM, "member"),
  bia: pessoa("bia", TEAM, "member"),
  caio: pessoa("caio", TEAM, "member"),
  outro: pessoa("outro", OUTRO, "owner"),
};
const como = <T>(p: Pessoa, fn: () => Promise<T>, extra: { modulos?: string[] } = {}) =>
  runWithTeam(p.teamId, fn, { userId: p.id, role: p.role, ...extra });

const envOriginal = {
  GOOGLE_INTEGRACOES_CLIENT_ID: env.GOOGLE_INTEGRACOES_CLIENT_ID,
  GOOGLE_INTEGRACOES_CLIENT_SECRET: env.GOOGLE_INTEGRACOES_CLIENT_SECRET,
  GOOGLE_INTEGRACOES_REDIRECT_URI: env.GOOGLE_INTEGRACOES_REDIRECT_URI,
  GOOGLE_AGENDA_PUSH: env.GOOGLE_AGENDA_PUSH,
  GOOGLE_AGENDA_LIBERADOS: env.GOOGLE_AGENDA_LIBERADOS,
  AUTH_URL: env.AUTH_URL,
};

// ---------------------------------------------------------------------------
// Google simulado: uma agenda em memória por access token ("at-<pessoa>").
// ---------------------------------------------------------------------------
const agendas = new Map<string, Map<string, EventoGoogle>>();
let seq = 0;
const agendaDe = (tok: string) => {
  let m = agendas.get(tok);
  if (!m) agendas.set(tok, (m = new Map()));
  return m;
};
const MEET = "https://meet.google.com/abc-defg-hij";

function instalarGoogleFalso() {
  agendas.clear();
  for (const f of Object.values(g)) f.mockReset();
  g.renovarAccessToken.mockImplementation(async ({ refreshToken }: { refreshToken: string }) => ({
    accessToken: `at-${refreshToken.slice(3)}`,
    expiraEm: new Date(Date.now() + 3600_000),
    escopos: [ESCOPO_AGENDA],
  }));
  g.revogarToken.mockImplementation(async () => {});
  g.inserirEvento.mockImplementation(async (tok: string, _cal: string, ev: EventoGoogle) => {
    const m = agendaDe(tok);
    if (m.has(ev.id)) throw new GoogleApiErro(409, "duplicate");
    const salvo: EventoGoogle = {
      ...ev,
      status: "confirmed",
      etag: `"e${++seq}"`,
      updated: new Date().toISOString(),
      iCalUID: `${ev.id}@google.com`,
      organizer: { email: "organizador@gmail.com", self: true },
      ...(ev.conferenceData?.createRequest
        ? { hangoutLink: MEET, conferenceData: { ...ev.conferenceData, entryPoints: [{ entryPointType: "video", uri: MEET }] } }
        : {}),
    };
    m.set(ev.id, salvo);
    return salvo;
  });
  g.atualizarEvento.mockImplementation(async (tok: string, _cal: string, id: string, patch: EventoGoogle) => {
    const m = agendaDe(tok);
    const atual = m.get(id);
    if (!atual) throw new GoogleApiErro(404, "notFound");
    const novo = { ...atual, ...patch, id, etag: `"e${++seq}"`, updated: new Date().toISOString() };
    m.set(id, novo);
    return novo;
  });
  g.cancelarEvento.mockImplementation(async (tok: string, _cal: string, id: string) => {
    const m = agendaDe(tok);
    const atual = m.get(id);
    if (atual) m.set(id, { ...atual, status: "cancelled", etag: `"e${++seq}"`, updated: new Date().toISOString() });
  });
  g.obterEvento.mockImplementation(async (tok: string, _cal: string, id: string) => {
    const e = agendaDe(tok).get(id);
    if (!e) throw new GoogleApiErro(404, "notFound");
    return e;
  });
  // O Google falso devolve o evento INTEIRO na lista (como se ignorasse o `fields=`):
  // a privacidade não pode depender só do Google.
  g.listarEventos.mockImplementation(async (tok: string) => ({
    items: [...agendaDe(tok).values()],
    nextSyncToken: `sync-${++seq}`,
    timeZone: "America/Sao_Paulo",
  }));
  g.assistirAgenda.mockImplementation(async (_tok: string, _cal: string, canal: { id: string }) => ({
    resourceId: `res-${canal.id}`,
    expiraEm: new Date(Date.now() + 7 * 24 * 3600_000),
  }));
  g.pararCanal.mockImplementation(async () => {});
}

/** Conecta a agenda da pessoa direto no banco (tokens cifrados como o fluxo real). */
async function conectar(p: Pessoa, extra: { expirado?: boolean } = {}) {
  return basePrisma.oAuthConnection.create({
    data: {
      teamId: p.teamId,
      userId: p.id,
      provider: "google",
      externalAccountId: `sub-${p.nome}-${sufixo}`,
      email: `${p.nome}-${sufixo}@gmail.com`,
      scopes: ["openid", "email", ESCOPO_AGENDA],
      credentials: encryptCredentials({ refreshToken: `rt-${p.nome}`, accessToken: `at-${p.nome}` }) as object,
      accessTokenExpiraEm: extra.expirado ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3600_000),
      calendarios: { create: { teamId: p.teamId, calendarId: "primary" } },
    },
    select: { id: true, createdAt: true },
  });
}

async function contato(teamId: string, nome: string, dono: Pessoa | null, emailDoContato: string, compartilhado = false) {
  return basePrisma.contact.create({
    data: {
      teamId,
      nome,
      ownerId: dono?.id ?? null,
      compartilhado,
      identifiers: { create: { teamId, canal: "email", valor: emailDoContato, isPrimary: true } },
    },
  });
}

async function limpar() {
  for (const teamId of [TEAM, OUTRO]) {
    await basePrisma.oAuthRevogacaoPendente.deleteMany({ where: { teamId } });
    await basePrisma.calendarBusyBlock.deleteMany({ where: { teamId } });
    await basePrisma.appointmentLink.deleteMany({ where: { teamId } });
    await basePrisma.calendarSync.deleteMany({ where: { teamId } });
    await basePrisma.oAuthConnection.deleteMany({ where: { teamId } });
    await basePrisma.appointmentAttendee.deleteMany({ where: { teamId } });
    await basePrisma.appointment.deleteMany({ where: { teamId } });
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
  }
}

beforeAll(async () => {
  Object.assign(env, {
    GOOGLE_INTEGRACOES_CLIENT_ID: CLIENT_ID,
    GOOGLE_INTEGRACOES_CLIENT_SECRET: "segredo-teste",
    GOOGLE_INTEGRACOES_REDIRECT_URI: undefined,
    GOOGLE_AGENDA_PUSH: "off",
    // A2: a lista de liberados começa aberta ("todos") para os testes antigos
    // seguirem valendo; o describe da liberação a fecha caso a caso.
    GOOGLE_AGENDA_LIBERADOS: "todos",
    AUTH_URL: "https://app.teste.crmagro",
  });
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Agenda Google A (test)" } });
  await basePrisma.team.upsert({ where: { id: OUTRO }, update: {}, create: { id: OUTRO, name: "Team Agenda Google B (test)" } });
  await limpar();
  for (const p of Object.values(U)) {
    await basePrisma.user.create({ data: { id: p.id, teamId: p.teamId, role: p.role, name: p.nome, email: p.email } });
  }
});
beforeEach(async () => {
  await limpar();
  instalarGoogleFalso();
  fila.enfileirarSyncGoogle.mockClear();
  email.sendCalendarInvite.mockClear();
  env.GOOGLE_AGENDA_PUSH = "off";
});
afterAll(async () => {
  Object.assign(env, envOriginal);
  await limpar();
  await basePrisma.user.deleteMany({ where: { id: { in: Object.values(U).map((p) => p.id) } } });
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

function idToken(payload: Record<string, unknown>) {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(payload)}.assinatura`;
}

describe("OAuth (conectar a PRÓPRIA agenda)", () => {
  it("monta a autorização com escopo mínimo, offline, incremental, PKCE S256 e state assinado", async () => {
    const r = await como(U.ana, () => iniciarConexaoGoogle());
    const url = new URL(r.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe("https://app.teste.crmagro/api/integracoes/google/callback");
    expect(q.get("scope")!.split(" ")).toEqual(["openid", "email", "https://www.googleapis.com/auth/calendar.events"]);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("login_hint")).toBe(U.ana.email);
    expect(q.get("state")).toContain(".");
    expect(r.nonce).toBeTruthy();
    expect(r.verificador).toBeTruthy();
  });

  it("state inválido é recusado ANTES de falar com o Google (adulterado, de outra pessoa, outro navegador, vencido)", async () => {
    const r = await como(U.ana, () => iniciarConexaoGoogle());
    const state = new URL(r.url).searchParams.get("state")!;
    const [payload, sig] = state.split(".");
    const dados = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const adulterado = `${Buffer.from(JSON.stringify({ ...dados, u: U.bia.id })).toString("base64url")}.${sig}`;
    const base = { code: "codigo", nonce: r.nonce, verificador: r.verificador };
    await expect(como(U.ana, () => concluirConexaoGoogle({ ...base, state: adulterado }))).rejects.toBeInstanceOf(EstadoOAuthInvalido);
    await expect(como(U.bia, () => concluirConexaoGoogle({ ...base, state }))).rejects.toBeInstanceOf(EstadoOAuthInvalido);
    await expect(como(U.ana, () => concluirConexaoGoogle({ ...base, state, nonce: "outro-navegador" }))).rejects.toBeInstanceOf(EstadoOAuthInvalido);
    await expect(como(U.ana, () => concluirConexaoGoogle({ ...base, state, nonce: null }))).rejects.toBeInstanceOf(EstadoOAuthInvalido);
    await expect(como(U.ana, () => concluirConexaoGoogle({ ...base, state: "lixo" }))).rejects.toBeInstanceOf(EstadoOAuthInvalido);
    const { verificarEstado } = await import("./conexao");
    expect(() => verificarEstado(state, { userId: U.ana.id, teamId: TEAM, nonce: r.nonce }, Date.now() + 11 * 60_000)).toThrow(EstadoOAuthInvalido);
    expect(g.trocarCodigo).not.toHaveBeenCalled();
    expect(await basePrisma.oAuthConnection.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("volta válida grava a conexão com os tokens CIFRADOS e os escopos concedidos; pede a 1ª sincronização", async () => {
    const r = await como(U.ana, () => iniciarConexaoGoogle());
    const state = new URL(r.url).searchParams.get("state")!;
    g.trocarCodigo.mockResolvedValueOnce({
      accessToken: "at-oauth-ana-segredo",
      refreshToken: "rt-oauth-ana-segredo",
      expiraEm: new Date(Date.now() + 3600_000),
      escopos: ["openid", "https://www.googleapis.com/auth/userinfo.email", ESCOPO_AGENDA],
      idToken: idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: `sub-oauth-${sufixo}`, email: "Ana.Pessoal@Gmail.com", exp: Math.floor(Date.now() / 1000) + 3600 }),
    });
    const fim = await como(U.ana, () => concluirConexaoGoogle({ code: "codigo-ok", state, nonce: r.nonce, verificador: r.verificador }));
    // E7a: a volta também diz o que foi conectado (`recurso`); a Agenda é o padrão.
    expect(fim).toEqual({ volta: "integracoes", email: "ana.pessoal@gmail.com", recurso: "agenda" });
    expect(g.trocarCodigo).toHaveBeenCalledWith(expect.objectContaining({ code: "codigo-ok", codeVerifier: r.verificador, clientId: CLIENT_ID }));

    const raw = await basePrisma.oAuthConnection.findFirstOrThrow({ where: { userId: U.ana.id }, include: { calendarios: true } });
    const texto = JSON.stringify(raw.credentials);
    expect(texto).not.toContain("rt-oauth-ana-segredo");
    expect(texto).not.toContain("at-oauth-ana-segredo");
    expect(estaCifrado(raw.credentials)).toBe(true);
    expect(decryptCredentials(raw.credentials)).toEqual({ refreshToken: "rt-oauth-ana-segredo", accessToken: "at-oauth-ana-segredo" });
    expect(raw).toMatchObject({ provider: "google", externalAccountId: `sub-oauth-${sufixo}`, email: "ana.pessoal@gmail.com", status: "connected" });
    expect(raw.scopes).toContain(ESCOPO_AGENDA);
    expect(raw.calendarios).toHaveLength(1);
    expect(fila.enfileirarSyncGoogle).toHaveBeenCalledWith(raw.id);

    // A tela mostra só a PRÓPRIA conexão, sem token.
    const minha = await como(U.ana, () => minhaConexaoGoogle());
    expect(minha).toMatchObject({ email: "ana.pessoal@gmail.com", status: "connected" });
    expect(JSON.stringify(minha)).not.toContain("segredo");
    expect(await como(U.bia, () => minhaConexaoGoogle())).toBeNull();
    expect(await como(U.dono, () => minhaConexaoGoogle())).toBeNull();

    // A mesma conta Google em outra pessoa: recusa (não transfere).
    const r2 = await como(U.bia, () => iniciarConexaoGoogle());
    g.trocarCodigo.mockResolvedValueOnce({
      accessToken: "x",
      refreshToken: "y",
      expiraEm: new Date(Date.now() + 3600_000),
      escopos: [ESCOPO_AGENDA],
      idToken: idToken({ iss: "accounts.google.com", aud: CLIENT_ID, sub: `sub-oauth-${sufixo}`, email: "ana.pessoal@gmail.com" }),
    });
    await expect(
      como(U.bia, () => concluirConexaoGoogle({ code: "c", state: new URL(r2.url).searchParams.get("state")!, nonce: r2.nonce, verificador: r2.verificador })),
    ).rejects.toBeInstanceOf(AgendaGoogleDeOutraPessoa);
  });

  it("a pessoa desmarcou a agenda na tela do Google: nada é gravado", async () => {
    const r = await como(U.ana, () => iniciarConexaoGoogle());
    g.trocarCodigo.mockResolvedValueOnce({
      accessToken: "a",
      refreshToken: "b",
      expiraEm: new Date(Date.now() + 3600_000),
      escopos: ["openid", "email"],
      idToken: idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "s", email: "a@b.com" }),
    });
    await expect(
      como(U.ana, () => concluirConexaoGoogle({ code: "c", state: new URL(r.url).searchParams.get("state")!, nonce: r.nonce, verificador: r.verificador })),
    ).rejects.toBeInstanceOf(PermissaoDaAgendaNegada);
    expect(await basePrisma.oAuthConnection.count({ where: { userId: U.ana.id } })).toBe(0);
  });

  it("só leitura não conecta; membro sem a tela Agenda nem Integrações também não", async () => {
    const viewer = { ...U.bia, role: "viewer" };
    await expect(como(viewer, () => iniciarConexaoGoogle())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(U.bia, () => iniciarConexaoGoogle(), { modulos: ["painel", "contatos"] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(como(U.bia, () => iniciarConexaoGoogle(), { modulos: ["painel", "agenda"] })).resolves.toBeTruthy();
    await expect(runWithTeam(TEAM, () => iniciarConexaoGoogle(), { userId: "system", role: "system" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("desconectar revoga no Google, para o canal e APAGA a conexão; os compromissos ficam", async () => {
    const c = await conectar(U.ana);
    await basePrisma.calendarSync.updateMany({ where: { connectionId: c.id }, data: { canalId: `canal-${sufixo}`, canalResourceId: "res-x", canalExpiraEm: new Date(Date.now() + 3600_000) } });
    const a = await como(U.ana, () => createAppointment({ titulo: "Reunião", inicio: "2032-06-10T13:00:00.000Z" }));
    await basePrisma.calendarBusyBlock.create({
      data: { teamId: TEAM, userId: U.ana.id, connectionId: c.id, externalEventId: "pessoal", inicio: new Date("2032-06-10T15:00:00Z"), fim: new Date("2032-06-10T16:00:00Z") },
    });
    expect(await como(U.ana, () => desconectarGoogle())).toEqual({ desconectada: true });
    expect(g.pararCanal).toHaveBeenCalledWith("at-ana", { id: `canal-${sufixo}`, resourceId: "res-x" });
    expect(g.revogarToken).toHaveBeenCalledWith("rt-ana");
    expect(await basePrisma.oAuthConnection.count({ where: { userId: U.ana.id } })).toBe(0);
    expect(await basePrisma.calendarBusyBlock.count({ where: { userId: U.ana.id } })).toBe(0);
    expect(await basePrisma.appointmentLink.count({ where: { appointmentId: a.id } })).toBe(0);
    expect(await basePrisma.appointment.count({ where: { id: a.id } })).toBe(1);
    expect(await basePrisma.oAuthRevogacaoPendente.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("Google não confirmou a revogação: a conexão sai igual e o token (cifrado) fica na fila até revogar", async () => {
    await conectar(U.ana);
    g.revogarToken.mockRejectedValue(new GoogleApiErro(503, "backendError"));
    await como(U.ana, () => desconectarGoogle());
    expect(g.revogarToken).toHaveBeenCalledTimes(3);
    expect(await basePrisma.oAuthConnection.count({ where: { userId: U.ana.id } })).toBe(0);
    const pend = await basePrisma.oAuthRevogacaoPendente.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(JSON.stringify(pend.credentials)).not.toContain("rt-ana");
    expect(decryptCredentials(pend.credentials)).toEqual({ token: "rt-ana" });
    // O Google voltou: a rodada do worker revoga e apaga a linha.
    g.revogarToken.mockReset();
    g.revogarToken.mockResolvedValue(undefined);
    expect(await processarRevogacoesPendentes(new Date(Date.now() + 10 * 60_000))).toEqual({ revogadas: 1, desistencias: 0 });
    expect(g.revogarToken).toHaveBeenCalledWith("rt-ana");
    expect(await basePrisma.oAuthRevogacaoPendente.count({ where: { teamId: TEAM } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CRM Agro → Google
// ---------------------------------------------------------------------------

describe("CRM Agro → Google", () => {
  it("reunião online com vários convidados: evento na agenda do responsável, sendUpdates=all, Meet e marca do CRM Agro; sem .ics", async () => {
    const c = await conectar(U.ana);
    const ct = await contato(TEAM, "Produtor", U.ana, "produtor@fazenda.com.br");
    const a = await como(U.ana, () =>
      createAppointment({
        titulo: "Apresentação da proposta",
        tipo: "reuniao_online",
        inicio: "2032-06-10T13:00:00.000Z",
        fim: "2032-06-10T14:00:00.000Z",
        contactId: ct.id,
        convidados: [{ email: "produtor@fazenda.com.br" }, { userId: U.bia.id }, { email: "Fornecedor@Externo.com.br", nome: "Fornecedor" }],
      }),
    );
    expect(g.inserirEvento).toHaveBeenCalledTimes(1);
    const [tok, cal, corpo, opts] = g.inserirEvento.mock.calls[0]!;
    expect(tok).toBe("at-ana");
    expect(cal).toBe("primary");
    expect(opts).toEqual({ sendUpdates: "all", conferenceDataVersion: 1 });
    // Id do evento = compromisso + conexão (único por agenda; base32hex).
    expect(corpo.id).toBe(idDoEventoGoogle(a.id, c.id));
    expect(corpo.id).toMatch(/^[0-9a-v]{40}$/);
    expect(corpo.summary).toBe("Apresentação da proposta");
    expect(corpo.start).toEqual({ dateTime: "2032-06-10T13:00:00.000Z", timeZone: "America/Sao_Paulo" });
    expect(corpo.attendees.map((x: { email: string }) => x.email).sort()).toEqual(["fornecedor@externo.com.br", U.bia.email, "produtor@fazenda.com.br"].sort());
    expect(corpo.extendedProperties).toEqual({ private: { crmagroId: a.id } });
    expect(corpo.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: "hangoutsMeet" });

    expect(a.reuniaoLink).toBe(MEET);
    expect(a.google).toBe("sincronizado");
    expect(a.convidados.find((c) => c.email === "produtor@fazenda.com.br")?.contactId).toBe(ct.id);
    expect(a.convidados.find((c) => c.email === U.bia.email)?.userId).toBe(U.bia.id);
    expect(email.sendCalendarInvite).not.toHaveBeenCalled();

    // A colega convidada VÊ a reunião na agenda dela, mas não altera.
    const daBia = await como(U.bia, () => listAppointments({ from: "2032-06-01T00:00:00Z", to: "2032-07-01T00:00:00Z" }));
    expect(daBia.map((x) => x.id)).toContain(a.id);
    // ...sem descobrir por ele o contato da Ana (que ela não vê em Contatos).
    const vistoPelaBia = daBia.find((x) => x.id === a.id)!;
    expect(vistoPelaBia.contactId).toBeNull();
    expect(vistoPelaBia.contactNome).toBeNull();
    expect(vistoPelaBia.convidados.every((x) => x.contactId === null)).toBe(true);
    await expect(como(U.bia, () => updateAppointment(a.id, { titulo: "invadido" }))).rejects.toBeInstanceOf(EdicaoNaoPermitida);

    // Só lembrete mudou: nada a mandar ao Google. Título mudou: um PATCH.
    await como(U.ana, () => updateAppointment(a.id, { lembreteMin: 10 }));
    expect(g.atualizarEvento).not.toHaveBeenCalled();
    const b = await como(U.ana, () => updateAppointment(a.id, { titulo: "Proposta final" }));
    expect(g.atualizarEvento).toHaveBeenCalledTimes(1);
    expect(g.atualizarEvento.mock.calls[0]![3]).toMatchObject({ summary: "Proposta final" });
    expect(g.atualizarEvento.mock.calls[0]![4]).toEqual({ sendUpdates: "all", conferenceDataVersion: 1 });
    // Já tem o Meet: não pede outro.
    expect(g.atualizarEvento.mock.calls[0]![3].conferenceData).toBeUndefined();
    expect(b.google).toBe("sincronizado");
  });

  it("sem agenda conectada: convite .ics por e-mail a cada convidado (nada no Google)", async () => {
    const a = await como(U.bia, () =>
      createAppointment({ titulo: "Visita", tipo: "visita", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "a@cliente.com.br" }, { email: "b@cliente.com.br" }] }),
    );
    expect(g.inserirEvento).not.toHaveBeenCalled();
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(2);
    const envio = email.sendCalendarInvite.mock.calls[0]![0] as { ics: string; text: string };
    expect(envio.ics).toContain("METHOD:REQUEST");
    expect(envio.ics).toContain("ATTENDEE;RSVP=TRUE:mailto:a@cliente.com.br");
    expect(envio.ics).toContain("ATTENDEE;RSVP=TRUE:mailto:b@cliente.com.br");
    expect(envio.text).toContain("10/06/2032, 10:00"); // hora no fuso do time, não UTC
    expect(a.google).toBeNull();
    // Cancelar avisa os convidados (METHOD:CANCEL).
    email.sendCalendarInvite.mockClear();
    await como(U.bia, () => setAppointmentStatus(a.id, "cancelado"));
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(2);
    expect((email.sendCalendarInvite.mock.calls[0]![0] as { ics: string }).ics).toContain("METHOD:CANCEL");
  });

  it("cancelar no CRM Agro cancela no Google (sendUpdates=all) e o compromisso fica no histórico; excluir com Google vira cancelar", async () => {
    const c = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Reunião", tipo: "reuniao", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "x@y.com.br" }] }));
    await como(U.ana, () => setAppointmentStatus(a.id, "cancelado"));
    expect(g.cancelarEvento).toHaveBeenCalledWith("at-ana", "primary", idDoEventoGoogle(a.id, c.id), { sendUpdates: "all" });
    expect(await basePrisma.appointment.findUnique({ where: { id: a.id }, select: { status: true } })).toEqual({ status: "cancelado" });

    const b = await como(U.ana, () => createAppointment({ titulo: "Outra", inicio: "2032-06-11T13:00:00.000Z" }));
    await como(U.ana, () => deleteAppointment(b.id));
    expect(g.cancelarEvento).toHaveBeenCalledTimes(2);
    expect(await basePrisma.appointment.findUnique({ where: { id: b.id }, select: { status: true } })).toEqual({ status: "cancelado" });
    expect(email.sendCalendarInvite).not.toHaveBeenCalled();
  });

  it("troca de responsável: sai da agenda do antigo (convidados avisados) e vai para a do novo; o convite novo só sai pelo Google do novo se ELE trocou", async () => {
    const cAna = await conectar(U.ana);
    const cCaio = await conectar(U.caio);
    const a = await como(U.ana, () => createAppointment({ titulo: "Visita", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    const idAna = idDoEventoGoogle(a.id, cAna.id);
    const idCaio = idDoEventoGoogle(a.id, cCaio.id);
    // O master troca para o Caio: a Ana (que convidou) cancela; na agenda do Caio
    // o evento entra SEM convidados e o convite novo sai pelo .ics do time.
    await como(U.dono, () => updateAppointment(a.id, { responsavelId: U.caio.id }));
    expect(g.cancelarEvento).toHaveBeenCalledWith("at-ana", "primary", idAna, { sendUpdates: "all" });
    expect(g.inserirEvento).toHaveBeenLastCalledWith("at-caio", "primary", expect.objectContaining({ id: idCaio }), { sendUpdates: "none", conferenceDataVersion: 1 });
    expect(g.inserirEvento.mock.lastCall![2].attendees).toBeUndefined();
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    // Para quem não conectou: sai da do Caio (que não levava convidados) e a atualização vai pelo .ics.
    await como(U.dono, () => updateAppointment(a.id, { responsavelId: U.bia.id }));
    expect(g.cancelarEvento).toHaveBeenLastCalledWith("at-caio", "primary", idCaio, { sendUpdates: "none" });
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(2);
    expect(await basePrisma.appointmentLink.count({ where: { appointmentId: a.id } })).toBe(0);
  });

  it("Google fora do ar: o salvar não cai, o vínculo fica pendente e o worker reenvia sem duplicar", async () => {
    const c = await conectar(U.ana);
    g.inserirEvento.mockRejectedValueOnce(new GoogleApiErro(503, "backendError"));
    const a = await como(U.ana, () => createAppointment({ titulo: "Ligar", tipo: "ligacao", inicio: "2032-06-10T13:00:00.000Z" }));
    expect(a.google).toBe("pendente");
    await enviarPendentesAoGoogle(new Date(Date.now() + 5 * 60_000));
    const link = await basePrisma.appointmentLink.findFirstOrThrow({ where: { appointmentId: a.id } });
    expect(link).toMatchObject({ pendenteDesde: null, tentativas: 0, externalEventId: idDoEventoGoogle(a.id, c.id) });
    expect(agendaDe("at-ana").size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Google → CRM Agro
// ---------------------------------------------------------------------------

describe("Google → CRM Agro", () => {
  const evento = (id: string, extra: Partial<EventoGoogle> = {}): EventoGoogle => ({
    id,
    status: "confirmed",
    etag: `"g-${id}-${++seq}"`,
    updated: new Date().toISOString(),
    start: { dateTime: "2032-06-11T12:00:00Z" },
    end: { dateTime: "2032-06-11T13:00:00Z" },
    ...extra,
  });

  it("evento pessoal vira 'Ocupado' (início, fim, id e título só para a dona): nada de descrição, local nem convidados", async () => {
    const c = await conectar(U.ana);
    agendaDe("at-ana").set(
      "pessoal1",
      evento("pessoal1", {
        summary: "Consulta médica",
        description: "Exame de rotina",
        location: "Clínica Central",
        attendees: [{ email: "medico@clinica.com.br" }, { email: "ana@gmail.com", self: true }],
      }),
    );
    const r = await sincronizarConexaoGoogle(c.id);
    expect(r).toMatchObject({ ok: true, completa: true, ocupados: 1, compromissos: 0 });
    // Pediu ao Google só os campos necessários (título para a dona; sem descrição/local).
    const params = g.listarEventos.mock.calls[0]![2];
    expect(params.fields).toBe(CAMPOS_DA_LISTA);
    expect(CAMPOS_DA_LISTA).toMatch(/summary/);
    expect(CAMPOS_DA_LISTA).not.toMatch(/description|location/);
    expect(params.timeMin).toBeTruthy();
    expect(g.obterEvento).not.toHaveBeenCalled();

    const blocos = await basePrisma.calendarBusyBlock.findMany({ where: { connectionId: c.id } });
    expect(blocos).toHaveLength(1);
    expect(Object.keys(blocos[0]!).sort()).toEqual(["connectionId", "createdAt", "externalEventId", "fim", "id", "inicio", "naoImportar", "teamId", "titulo", "updatedAt", "userId"]);
    expect(blocos[0]).toMatchObject({ externalEventId: "pessoal1", titulo: "Consulta médica", inicio: new Date("2032-06-11T12:00:00Z"), fim: new Date("2032-06-11T13:00:00Z") });
    const tudo = JSON.stringify(blocos) + JSON.stringify(await basePrisma.appointment.findMany({ where: { teamId: TEAM } }));
    for (const segredo of ["Exame", "Clínica", "medico@"]) expect(tudo).not.toContain(segredo);
    // O próprio dono vê o título.
    const meus = await como(U.ana, () => listarOcupados({ from: "2032-06-01T00:00:00Z", to: "2032-07-01T00:00:00Z" }));
    expect(meus).toEqual({
      itens: [{ id: blocos[0]!.id, inicio: "2032-06-11T12:00:00.000Z", fim: "2032-06-11T13:00:00.000Z", pessoaId: U.ana.id, pessoaNome: "ana", meu: true, titulo: "Consulta médica", quantidade: 1 }],
      cortado: false,
    });

    // Evento "Disponível" e aniversário não ocupam; apagado lá some.
    agendaDe("at-ana").set("livre", evento("livre", { transparency: "transparent" }));
    agendaDe("at-ana").set("niver", evento("niver", { eventType: "birthday" }));
    agendaDe("at-ana").set("recusei", evento("recusei", { attendees: [{ email: "ana@gmail.com", self: true, responseStatus: "declined" }] }));
    agendaDe("at-ana").set("pessoal1", evento("pessoal1", { status: "cancelled" }));
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.calendarBusyBlock.count({ where: { connectionId: c.id } })).toBe(0);
  });

  it("evento com convidado que é contato da pessoa vira compromisso completo ligado ao contato", async () => {
    const c = await conectar(U.ana);
    const ct = await contato(TEAM, "Produtor Silva", U.ana, "produtor@fazenda.com.br");
    agendaDe("at-ana").set(
      "comcontato",
      evento("comcontato", {
        summary: "Visita técnica na fazenda",
        description: "Levar amostras",
        location: "Fazenda Boa Vista",
        organizer: { email: "ana@gmail.com", self: true },
        attendees: [{ email: "Produtor@Fazenda.com.br", responseStatus: "accepted", displayName: "Silva" }, { email: "ana@gmail.com", self: true }],
      }),
    );
    const r = await sincronizarConexaoGoogle(c.id);
    expect(r).toMatchObject({ ok: true, compromissos: 1, ocupados: 0 });
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM }, include: { convidados: true, vinculos: true } });
    expect(a).toMatchObject({
      titulo: "Visita técnica na fazenda",
      descricao: "Levar amostras",
      local: "Fazenda Boa Vista",
      contactId: ct.id,
      responsavelId: U.ana.id,
      origem: "google",
      tipo: "reuniao",
      inicio: new Date("2032-06-11T12:00:00Z"),
    });
    expect(a.convidados.map((x) => [x.email, x.contactId, x.resposta])).toEqual([["produtor@fazenda.com.br", ct.id, "accepted"]]);
    expect(a.vinculos).toHaveLength(1);
    expect(a.vinculos[0]).toMatchObject({ externalEventId: "comcontato", origem: "google" });
    expect(await basePrisma.calendarBusyBlock.count({ where: { connectionId: c.id } })).toBe(0);
    // Segunda rodada sem mudança (mesmo etag): não duplica.
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(1);
  });

  it("contato de um COLEGA (que a pessoa não vê) não revela nada: vira só 'Ocupado'", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Cliente da Bia", U.bia, "cliente.bia@empresa.com.br");
    agendaDe("at-ana").set("dabia", evento("dabia", { summary: "Almoço", attendees: [{ email: "cliente.bia@empresa.com.br" }] }));
    const r = await sincronizarConexaoGoogle(c.id);
    expect(r).toMatchObject({ ok: true, compromissos: 0, ocupados: 1 });
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("conflito: vence a alteração mais recente nos campos comuns; contato, tipo, lembrete e responsável nunca saem pelo Google", async () => {
    const c = await conectar(U.ana);
    const ct = await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    const a = await como(U.ana, () =>
      createAppointment({ titulo: "Original", tipo: "visita", inicio: "2032-06-10T13:00:00.000Z", contactId: ct.id, lembreteMin: 60 }),
    );
    const idG = idDoEventoGoogle(a.id, c.id);
    await sincronizarConexaoGoogle(c.id); // eco do próprio envio: ignorado
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { titulo: true } })).toEqual({ titulo: "Original" });

    // (a) Google mais novo: título e horário vêm de lá; o resto é do CRM Agro.
    const ev = agendaDe("at-ana").get(idG)!;
    agendaDe("at-ana").set(idG, {
      ...ev,
      summary: "Remarcado no Google",
      start: { dateTime: "2032-06-10T15:00:00Z" },
      end: { dateTime: "2032-06-10T16:00:00Z" },
      etag: '"mudou-no-google"',
      updated: new Date(Date.now() + 60_000).toISOString(),
    });
    await sincronizarConexaoGoogle(c.id);
    const depois = await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(depois).toMatchObject({
      titulo: "Remarcado no Google",
      inicio: new Date("2032-06-10T15:00:00Z"),
      contactId: ct.id,
      tipo: "visita",
      lembreteMin: 60,
      responsavelId: U.ana.id,
    });

    // (b) CRM Agro mais novo: a mudança antiga do Google não sobrescreve.
    await como(U.ana, () => updateAppointment(a.id, { titulo: "Editado no CRM Agro" }));
    const ev2 = agendaDe("at-ana").get(idG)!;
    agendaDe("at-ana").set(idG, { ...ev2, summary: "Velho do Google", etag: '"antigo"', updated: new Date(Date.now() - 3600_000).toISOString() });
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { titulo: true } })).toEqual({ titulo: "Editado no CRM Agro" });
    expect((await basePrisma.appointmentLink.findFirstOrThrow({ where: { appointmentId: a.id } })).pendenteDesde).not.toBeNull();
  });

  it("crmagroId forjado na própria agenda NÃO mexe no compromisso de um colega; o vínculo perdido do PRÓPRIO é refeito", async () => {
    const c = await conectar(U.ana);
    const daBia = await como(U.bia, () => createAppointment({ titulo: "Reunião da Bia", inicio: "2032-06-10T13:00:00.000Z" }));
    // O id "certo" para a agenda da Ana, organizado por ela: ainda assim não é da Ana.
    const idForjado = idDoEventoGoogle(daBia.id, c.id);
    const organizadora = { email: "ana@gmail.com", self: true };
    agendaDe("at-ana").set(
      idForjado,
      evento(idForjado, {
        summary: "Sequestrado",
        status: "cancelled",
        organizer: organizadora,
        extendedProperties: { private: { crmagroId: daBia.id } },
        updated: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    await sincronizarConexaoGoogle(c.id);
    agendaDe("at-ana").set(
      idForjado,
      evento(idForjado, { summary: "Sequestrado", organizer: organizadora, extendedProperties: { private: { crmagroId: daBia.id } }, updated: new Date(Date.now() + 60_000).toISOString() }),
    );
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: daBia.id }, select: { titulo: true, status: true } })).toEqual({
      titulo: "Reunião da Bia",
      status: "pendente",
    });
    expect(await basePrisma.appointmentLink.count({ where: { appointmentId: daBia.id } })).toBe(0);

    // O compromisso É da Ana e o vínculo se perdeu: religa pelo crmagroId.
    const daAna = await como(U.ana, () => createAppointment({ titulo: "Da Ana", inicio: "2032-06-12T13:00:00.000Z" }));
    await basePrisma.appointmentLink.deleteMany({ where: { appointmentId: daAna.id } });
    const idAna = idDoEventoGoogle(daAna.id, c.id);
    const ev = agendaDe("at-ana").get(idAna)!;
    agendaDe("at-ana").set(idAna, { ...ev, summary: "Da Ana (Google)", etag: '"novo"', updated: new Date(Date.now() + 60_000).toISOString() });
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.appointmentLink.count({ where: { appointmentId: daAna.id, connectionId: c.id } })).toBe(1);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: daAna.id }, select: { titulo: true } })).toEqual({ titulo: "Da Ana (Google)" });
  });

  it("veio do Google e mudou de responsável: o CRM Agro para de escrever na agenda de origem (só leitura), sem duplicar nem convidar de novo", async () => {
    const c = await conectar(U.ana);
    await conectar(U.caio);
    await contato(TEAM, "Produtor", U.ana, "p2@fazenda.com.br");
    agendaDe("at-ana").set(
      "daana",
      evento("daana", {
        summary: "Reunião com o produtor",
        organizer: { email: "ana@gmail.com", self: true },
        attendees: [{ email: "p2@fazenda.com.br" }, { email: "ana@gmail.com", self: true }],
      }),
    );
    await sincronizarConexaoGoogle(c.id);
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM, origem: "google" } });
    // Só a Ana o vê até confirmar que é de trabalho (revisão 3).
    await como(U.ana, () => confirmarDoGoogle(a.id));

    await como(U.dono, () => updateAppointment(a.id, { responsavelId: U.caio.id, titulo: "Agora do Caio" }));
    // Nada na agenda da Ana (é da conta dela) nem na do Caio; nenhum convite.
    expect(g.cancelarEvento).not.toHaveBeenCalled();
    expect(g.atualizarEvento).not.toHaveBeenCalled();
    expect(g.inserirEvento).not.toHaveBeenCalled();
    expect(email.sendCalendarInvite).not.toHaveBeenCalled();
    expect(await basePrisma.appointmentLink.findFirstOrThrow({ where: { appointmentId: a.id } })).toMatchObject({ connectionId: c.id, origem: "convite", pendenteDesde: null });
    await enviarPendentesAoGoogle(new Date(Date.now() + 5 * 60_000));
    expect(g.inserirEvento).not.toHaveBeenCalled();
    expect(g.atualizarEvento).not.toHaveBeenCalled();

    // A agenda da Ana remarcou: chega no MESMO compromisso (nada duplicado).
    const ev = agendaDe("at-ana").get("daana")!;
    agendaDe("at-ana").set("daana", {
      ...ev,
      start: { dateTime: "2032-06-11T14:00:00Z" },
      end: { dateTime: "2032-06-11T15:00:00Z" },
      etag: '"remarcou"',
      updated: new Date(Date.now() + 60_000).toISOString(),
    });
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { inicio: true, responsavelId: true } })).toEqual({
      inicio: new Date("2032-06-11T14:00:00Z"),
      responsavelId: U.caio.id,
    });
  });

  it("apagado/cancelado no Google → cancelado no CRM Agro, e o compromisso fica no histórico", async () => {
    const c = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Reunião", inicio: "2032-06-10T13:00:00.000Z" }));
    const idG = idDoEventoGoogle(a.id, c.id);
    agendaDe("at-ana").set(idG, { id: idG, status: "cancelled", etag: '"cancelado-la"' });
    const r = await sincronizarConexaoGoogle(c.id);
    expect(r).toMatchObject({ ok: true, cancelados: 1 });
    expect(await basePrisma.appointment.findUnique({ where: { id: a.id }, select: { status: true } })).toEqual({ status: "cancelado" });
    // Não reenvia o cancelamento (veio de lá).
    expect(g.cancelarEvento).not.toHaveBeenCalled();
  });

  it("410 (cursor vencido) → sincronização completa: os 'Ocupado' são refeitos", async () => {
    const c = await conectar(U.ana);
    agendaDe("at-ana").set("velho", evento("velho"));
    await sincronizarConexaoGoogle(c.id);
    const sync1 = await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } });
    expect(sync1.syncToken).toMatch(/^sync-/);
    agendaDe("at-ana").delete("velho");
    agendaDe("at-ana").set("novo", evento("novo", { start: { dateTime: "2032-06-12T12:00:00Z" }, end: { dateTime: "2032-06-12T13:00:00Z" } }));
    g.listarEventos.mockClear();
    g.listarEventos.mockImplementationOnce(async () => {
      throw new GoogleApiErro(410, "fullSyncRequired");
    });
    const r = await sincronizarConexaoGoogle(c.id);
    expect(r).toMatchObject({ ok: true, completa: true });
    expect(g.listarEventos.mock.calls[0]![2].syncToken).toBe(sync1.syncToken);
    expect(g.listarEventos.mock.calls[1]![2].syncToken).toBeUndefined();
    expect(g.listarEventos.mock.calls[1]![2].timeMin).toBeTruthy();
    const blocos = await basePrisma.calendarBusyBlock.findMany({ where: { connectionId: c.id }, select: { externalEventId: true } });
    expect(blocos).toEqual([{ externalEventId: "novo" }]);
  });

  it("cota/instabilidade: espera crescente (sem laço); trava impede duas sincronizações da mesma agenda", async () => {
    const c = await conectar(U.ana);
    g.listarEventos.mockRejectedValueOnce(new GoogleApiErro(429, "rateLimitExceeded"));
    const agora = new Date();
    expect(await sincronizarConexaoGoogle(c.id, { agora })).toEqual({ ok: false, pulou: "erro" });
    const s = await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } });
    expect(s.falhas).toBe(1);
    expect(s.proximaSincronizacaoEm!.getTime()).toBeGreaterThan(agora.getTime() + 60_000);

    await redisEstado().set(`agenda:google:sync:${c.id}`, "outra-rodada", "EX", 30);
    try {
      expect(await sincronizarConexaoGoogle(c.id)).toEqual({ ok: false, pulou: "travada" });
    } finally {
      await redisEstado().del(`agenda:google:sync:${c.id}`);
    }
  });

  it("invalid_grant: conexão vai para 'reconectar' e para de sincronizar", async () => {
    const c = await conectar(U.ana, { expirado: true });
    g.renovarAccessToken.mockRejectedValueOnce(new GoogleAutorizacaoInvalida("invalid_grant"));
    expect(await sincronizarConexaoGoogle(c.id)).toEqual({ ok: false, pulou: "reautorizar" });
    expect(await basePrisma.oAuthConnection.findUniqueOrThrow({ where: { id: c.id }, select: { status: true } })).toEqual({ status: "reauth_required" });
    expect(await sincronizarConexaoGoogle(c.id)).toEqual({ ok: false, pulou: "inativa" });
  });

  it("push: abre o canal (events.watch) e o aviso só vale com o token certo do canal", async () => {
    env.GOOGLE_AGENDA_PUSH = "on";
    const c = await conectar(U.ana);
    await sincronizarConexaoGoogle(c.id);
    expect(g.assistirAgenda).toHaveBeenCalledTimes(1);
    const canal = g.assistirAgenda.mock.calls[0]![2] as { id: string; token: string; address: string };
    expect(canal.address).toBe("https://app.teste.crmagro/api/integracoes/google/notificacao");
    expect(canal.token).toBe(tokenDoCanal(canal.id));
    const s = await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } });
    expect(s.canalId).toBe(canal.id);

    fila.enfileirarSyncGoogle.mockClear();
    expect(await receberAvisoDoGoogle({ canalId: canal.id, token: "token-errado", resourceId: s.canalResourceId, estado: "exists" })).toBe("ignorado");
    expect(await receberAvisoDoGoogle({ canalId: "canal-desconhecido", token: tokenDoCanal("canal-desconhecido"), estado: "exists" })).toBe("ignorado");
    expect(await receberAvisoDoGoogle({ canalId: canal.id, token: canal.token, resourceId: s.canalResourceId, estado: "sync" })).toBe("handshake");
    expect(fila.enfileirarSyncGoogle).not.toHaveBeenCalled();
    expect(await receberAvisoDoGoogle({ canalId: canal.id, token: canal.token, resourceId: s.canalResourceId, estado: "exists" })).toBe("sincronizar");
    expect(fila.enfileirarSyncGoogle).toHaveBeenCalledWith(c.id);
  });
});

// ---------------------------------------------------------------------------
// Isolamento e ciclo de vida da pessoa
// ---------------------------------------------------------------------------

describe("isolamento (duas pessoas, dois times) e desativar/excluir", () => {
  it("o 'Ocupado' de uma pessoa não aparece para a colega; o gestor vê só o horário; outro time não vê nada", async () => {
    const c = await conectar(U.ana);
    agendaDe("at-ana").set("p1", { id: "p1", status: "confirmed", etag: '"x"', summary: "Particular", start: { dateTime: "2032-06-11T12:00:00Z" }, end: { dateTime: "2032-06-11T13:00:00Z" } });
    await sincronizarConexaoGoogle(c.id);
    const faixa = { from: "2032-06-01T00:00:00Z", to: "2032-07-01T00:00:00Z" };
    expect(await como(U.bia, () => listarOcupados(faixa))).toEqual({ itens: [], cortado: false });
    const doGestor = await como(U.chefe, () => listarOcupados(faixa));
    expect(doGestor.itens).toHaveLength(1);
    expect(doGestor.itens[0]).toMatchObject({ pessoaId: U.ana.id, meu: false, quantidade: 1 });
    expect(JSON.stringify(doGestor)).not.toContain("Particular");
    expect(await como(U.outro, () => listarOcupados(faixa))).toEqual({ itens: [], cortado: false });
    expect(await como(U.outro, () => listAppointments(faixa))).toEqual([]);
    // A conexão é só da dona: nem o master vê a de outra pessoa.
    expect(await como(U.dono, () => minhaConexaoGoogle())).toBeNull();
    expect(await como(U.outro, () => minhaConexaoGoogle())).toBeNull();
  });

  it("desativar integrante revoga a conexão no Google e apaga (não transfere); compromissos ficam", async () => {
    const c = await conectar(U.ana);
    agendaDe("at-ana").set("p2", { id: "p2", status: "confirmed", etag: '"y"', start: { dateTime: "2032-06-11T12:00:00Z" }, end: { dateTime: "2032-06-11T13:00:00Z" } });
    await sincronizarConexaoGoogle(c.id);
    await basePrisma.calendarSync.updateMany({ where: { connectionId: c.id }, data: { canalId: `canal-d-${sufixo}`, canalResourceId: "res-d", canalExpiraEm: new Date(Date.now() + 3600_000) } });
    const a = await como(U.ana, () => createAppointment({ titulo: "Da Ana", inicio: "2032-06-10T13:00:00.000Z" }));
    try {
      await como(U.dono, () => desativarIntegrante(U.ana.id));
      expect(g.pararCanal).toHaveBeenCalledWith("at-ana", { id: `canal-d-${sufixo}`, resourceId: "res-d" });
      expect(g.revogarToken).toHaveBeenCalledWith("rt-ana");
      expect(await basePrisma.oAuthConnection.count({ where: { userId: U.ana.id } })).toBe(0);
      expect(await basePrisma.calendarBusyBlock.count({ where: { userId: U.ana.id } })).toBe(0);
      expect(await basePrisma.appointment.count({ where: { id: a.id } })).toBe(1);
    } finally {
      await basePrisma.user.update({ where: { id: U.ana.id }, data: { desativadoEm: null } });
    }
  });

  it("excluir integrante revoga a conexão antes de apagar; os compromissos vão para quem recebe", async () => {
    await conectar(U.caio);
    const a = await como(U.caio, () => createAppointment({ titulo: "Do Caio", inicio: "2032-06-10T13:00:00.000Z" }));
    const r = await como(U.dono, () => excluirIntegrante(U.caio.id, U.bia.id));
    expect(r.transferidos.compromissos).toBe(1);
    expect(g.revogarToken).toHaveBeenCalledWith("rt-caio");
    expect(await basePrisma.oAuthConnection.count({ where: { teamId: TEAM } })).toBe(0);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { responsavelId: true } })).toEqual({ responsavelId: U.bia.id });
    // Recria o Caio para o afterAll (e para rodar de novo).
    await basePrisma.user.create({ data: { id: U.caio.id, teamId: TEAM, role: "member", name: "caio", email: U.caio.email } });
  });
});

// ---------------------------------------------------------------------------
// Segunda revisão do #169 (achados dos revisores independentes)
// ---------------------------------------------------------------------------

describe("revisão 2 do #169", () => {
  const DIA_MS = 24 * 3600_000;
  const faixa = { from: "2032-06-01T00:00:00Z", to: "2032-07-01T00:00:00Z" };
  /** Data dentro da janela de 180 dias do worker (o reenvio só olha o futuro próximo). */
  const daquiA = (dias: number) => new Date(Date.now() + dias * DIA_MS).toISOString();
  const ev = (id: string, extra: Partial<EventoGoogle> = {}): EventoGoogle => ({
    id,
    status: "confirmed",
    etag: `"r-${id}-${++seq}"`,
    updated: new Date().toISOString(),
    start: { dateTime: "2032-06-11T12:00:00Z" },
    end: { dateTime: "2032-06-11T13:00:00Z" },
    ...extra,
  });
  const eu = (email = "ana@gmail.com", resposta?: string) => ({ email, self: true, ...(resposta ? { responseStatus: resposta } : {}) });
  const semConviteDoGoogle = () =>
    g.inserirEvento.mock.calls.every((c) => c[3].sendUpdates !== "all") && g.atualizarEvento.mock.calls.every((c) => c[4].sendUpdates !== "all");

  it("membro que cria para um colega conectado NÃO convida pela conta Google dele: evento sem convidados e .ics da caixa do time", async () => {
    const cCaio = await conectar(U.caio);
    await como(U.ana, () =>
      createAppointment({
        titulo: "Proposta",
        descricao: "Acesse http://golpe.exemplo",
        inicio: "2032-06-10T13:00:00.000Z",
        responsavelId: U.caio.id,
        convidados: [{ email: "vitima@externo.com" }],
      }),
    );
    expect(g.inserirEvento).toHaveBeenCalledTimes(1);
    const [tok, , corpo, opts] = g.inserirEvento.mock.calls[0]!;
    expect(tok).toBe("at-caio");
    expect(opts).toEqual({ sendUpdates: "none", conferenceDataVersion: 1 });
    expect(corpo.attendees).toBeUndefined();
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    // O worker também não manda depois: o canal do convite ficou sendo o e-mail.
    await enviarPendentesAoGoogle(new Date(Date.now() + 5 * 60_000));
    expect(semConviteDoGoogle()).toBe(true);

    // Quando o próprio Caio convida, sai pelo Google dele.
    const b = await como(U.caio, () => createAppointment({ titulo: "Do Caio", inicio: "2032-06-11T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    expect(g.inserirEvento).toHaveBeenLastCalledWith(
      "at-caio",
      "primary",
      expect.objectContaining({ id: idDoEventoGoogle(b.id, cCaio.id), attendees: [{ email: "cliente@x.com.br" }] }),
      { sendUpdates: "all", conferenceDataVersion: 1 },
    );
    // O gestor (edita tudo) não inclui ninguém no evento que o Caio mandou pelo Google dele.
    await expect(
      como(U.chefe, () => updateAppointment(b.id, { convidados: [{ email: "cliente@x.com.br" }, { email: "outro@externo.com" }] })),
    ).rejects.toBeInstanceOf(ConviteSoPeloResponsavel);
  });

  it("reconectar depois de 'Reconectar' não manda um segundo convite a quem já recebeu o .ics", async () => {
    const c = await conectar(U.ana);
    await basePrisma.oAuthConnection.update({ where: { id: c.id }, data: { status: "reauth_required" } });
    const a = await como(U.ana, () => createAppointment({ titulo: "Visita", inicio: daquiA(3), convidados: [{ email: "cliente@x.com.br" }] }));
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    expect(g.inserirEvento).not.toHaveBeenCalled();
    // Reconectou (a MESMA linha e o mesmo createdAt, como no upsert do OAuth).
    await basePrisma.oAuthConnection.update({ where: { id: c.id }, data: { status: "connected" } });
    await sincronizarConexaoGoogle(c.id);
    await enviarPendentesAoGoogle(new Date(Date.now() + 5 * 60_000));
    expect(g.inserirEvento).toHaveBeenCalledTimes(1);
    const [, , corpo, opts] = g.inserirEvento.mock.calls[0]!;
    expect(corpo.id).toBe(idDoEventoGoogle(a.id, c.id));
    expect(corpo.attendees).toBeUndefined();
    expect(opts.sendUpdates).toBe("none");
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
  });

  it("mudança do CRM Agro parada (Reconectar) não é atropelada por resposta de convidado no Google: fica pendente e vai para lá", async () => {
    const c = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Original", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    const b = await como(U.ana, () => createAppointment({ titulo: "Outra", inicio: "2032-06-12T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    const idA = idDoEventoGoogle(a.id, c.id);
    const idB = idDoEventoGoogle(b.id, c.id);
    await sincronizarConexaoGoogle(c.id); // eco
    await basePrisma.oAuthConnection.update({ where: { id: c.id }, data: { status: "reauth_required" } });
    await como(U.ana, () => updateAppointment(a.id, { titulo: "Remarcada no CRM Agro", inicio: "2032-06-10T15:00:00.000Z" }));
    await como(U.ana, () => setAppointmentStatus(b.id, "cancelado"));
    expect(g.atualizarEvento).not.toHaveBeenCalled();
    expect(g.cancelarEvento).not.toHaveBeenCalled();
    // O cliente aceita os convites ANTIGOS (o `updated` do Google fica mais novo que as edições).
    for (const id of [idA, idB]) {
      const atual = agendaDe("at-ana").get(id)!;
      agendaDe("at-ana").set(id, {
        ...atual,
        attendees: [{ email: "cliente@x.com.br", responseStatus: "accepted" }],
        etag: `"rsvp-${id}"`,
        updated: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    await basePrisma.oAuthConnection.update({ where: { id: c.id }, data: { status: "connected" } });
    await sincronizarConexaoGoogle(c.id);
    const depoisA = await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, include: { convidados: true, vinculos: true } });
    expect(depoisA).toMatchObject({ titulo: "Remarcada no CRM Agro", inicio: new Date("2032-06-10T15:00:00.000Z") });
    expect(depoisA.convidados[0]!.resposta).toBe("accepted");
    expect(depoisA.vinculos[0]!.pendenteDesde).not.toBeNull();
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("cancelado");

    await enviarPendentesAoGoogle(new Date(Date.now() + 5 * 60_000));
    expect(g.atualizarEvento).toHaveBeenCalledWith("at-ana", "primary", idA, expect.objectContaining({ summary: "Remarcada no CRM Agro" }), {
      sendUpdates: "all",
      conferenceDataVersion: 1,
    });
    expect(g.cancelarEvento).toHaveBeenCalledWith("at-ana", "primary", idB, { sendUpdates: "all" });
  });

  it("troca para quem era convidado: o evento nasce com id próprio na agenda nova, sem PATCH na cópia de convidado, e o cancelamento dela não cancela o compromisso", async () => {
    const cAna = await conectar(U.ana);
    const cCaio = await conectar(U.caio);
    const a = await como(U.ana, () =>
      createAppointment({ titulo: "Com o closer", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }, { userId: U.caio.id }] }),
    );
    const idAna = idDoEventoGoogle(a.id, cAna.id);
    // A agenda do Caio tem a CÓPIA DE CONVIDADO: mesmo id, sem a propriedade privada, organizada pela Ana.
    const original = agendaDe("at-ana").get(idAna)!;
    agendaDe("at-caio").set(idAna, {
      ...original,
      extendedProperties: undefined,
      organizer: { email: U.ana.email, self: false },
      attendees: [{ email: "cliente@x.com.br" }, { email: U.caio.email, self: true, responseStatus: "accepted" }],
    });
    await como(U.ana, () => updateAppointment(a.id, { responsavelId: U.caio.id }));
    expect(g.cancelarEvento).toHaveBeenCalledWith("at-ana", "primary", idAna, { sendUpdates: "all" });
    expect(g.inserirEvento).toHaveBeenLastCalledWith("at-caio", "primary", expect.objectContaining({ id: idDoEventoGoogle(a.id, cCaio.id) }), expect.anything());
    expect(g.atualizarEvento).not.toHaveBeenCalled();
    // O Google cancela a cópia de convidado do Caio: a sincronização dele não cancela o compromisso.
    agendaDe("at-caio").set(idAna, { ...agendaDe("at-caio").get(idAna)!, status: "cancelled", etag: '"copia-cancelada"' });
    await sincronizarConexaoGoogle(cCaio.id);
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("pendente");
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await basePrisma.appointmentLink.findMany({ where: { appointmentId: a.id }, select: { connectionId: true } })).toEqual([{ connectionId: cCaio.id }]);
  });

  it("dois colegas convidados para o mesmo evento, sincronizando juntos, não duplicam o compromisso", async () => {
    const cAna = await conectar(U.ana);
    const cChefe = await conectar(U.chefe);
    await contato(TEAM, "Cliente da Ana", U.ana, "x@cliente.com.br");
    await contato(TEAM, "Cliente do Chefe", U.chefe, "y@cliente.com.br");
    const base = ev("evdotime", { summary: "Reunião com clientes", organizer: { email: U.bia.email, self: false } });
    const convidados = (quem: string) =>
      [U.ana.email, U.chefe.email, "x@cliente.com.br", "y@cliente.com.br"].map((e) => (e === quem ? { email: e, self: true, responseStatus: "accepted" } : { email: e }));
    agendaDe("at-ana").set(base.id, { ...base, attendees: convidados(U.ana.email) });
    agendaDe("at-chefe").set(base.id, { ...base, attendees: convidados(U.chefe.email) });
    await Promise.all([sincronizarConexaoGoogle(cAna.id), sincronizarConexaoGoogle(cChefe.id)]);
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await basePrisma.appointmentLink.count({ where: { teamId: TEAM, externalEventId: base.id } })).toBe(1);
  });

  it("evento que nasceu no CRM Agro não volta como compromisso novo pela agenda de um colega (vínculo perdido ou convite .ics)", async () => {
    const cAna = await conectar(U.ana);
    const cCaio = await conectar(U.caio);
    await contato(TEAM, "Cliente do Caio", U.caio, "cliente@x.com.br");
    const a = await como(U.ana, () =>
      createAppointment({ titulo: "Da Ana", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }, { userId: U.caio.id }] }),
    );
    const idAna = idDoEventoGoogle(a.id, cAna.id);
    // A Ana desconecta: os vínculos saem; o evento continua na conta dela e na cópia do Caio.
    await como(U.ana, () => desconectarGoogle());
    const copia: EventoGoogle = {
      ...agendaDe("at-ana").get(idAna)!,
      extendedProperties: undefined,
      organizer: { email: U.ana.email, self: false },
      attendees: [{ email: "cliente@x.com.br" }, { email: U.caio.email, self: true, responseStatus: "accepted" }],
      etag: '"mudou"',
    };
    agendaDe("at-caio").set(idAna, copia);
    // E o convite .ics que o Google do Caio pôs na agenda (id do Google, UID do CRM Agro).
    agendaDe("at-caio").set("idgoogle123", { ...copia, id: "idgoogle123", iCalUID: `${a.id}@crmagro` });
    await sincronizarConexaoGoogle(cCaio.id);
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await basePrisma.calendarBusyBlock.count({ where: { connectionId: cCaio.id } })).toBe(0);
  });

  it("dia inteiro: fuso do time diferente do da agenda — a data não anda ao editar no CRM Agro", async () => {
    const antes = await basePrisma.teamConfig.findUnique({ where: { teamId: TEAM }, select: { timezone: true } });
    await basePrisma.teamConfig.upsert({ where: { teamId: TEAM }, update: { timezone: "America/Cuiaba" }, create: { teamId: TEAM, timezone: "America/Cuiaba" } });
    try {
      const c = await conectar(U.ana);
      await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
      agendaDe("at-ana").set(
        "diainteiro",
        ev("diainteiro", { summary: "Dia de campo", start: { date: "2032-10-05" }, end: { date: "2032-10-06" }, organizer: { email: "a@g.com", self: true }, attendees: [{ email: "p@fazenda.com.br" }] }),
      );
      await sincronizarConexaoGoogle(c.id); // a lista vem com timeZone America/Sao_Paulo
      const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM } });
      expect(a.diaInteiro).toBe(true);
      await como(U.ana, () => updateAppointment(a.id, { descricao: "Levar amostras" }));
      const patch = g.atualizarEvento.mock.lastCall![3];
      expect(patch.start).toEqual({ date: "2032-10-05" });
      expect(patch.end).toEqual({ date: "2032-10-06" });
    } finally {
      if (antes) await basePrisma.teamConfig.update({ where: { teamId: TEAM }, data: { timezone: antes.timezone } });
      else await basePrisma.teamConfig.deleteMany({ where: { teamId: TEAM } });
    }
  });

  it("push desligado: o canal antigo é parado e limpo; watch falhando espera — a manutenção não vira polling de 1 minuto", async () => {
    const c = await conectar(U.ana);
    await sincronizarConexaoGoogle(c.id);
    await basePrisma.calendarSync.updateMany({
      where: { connectionId: c.id },
      data: { canalId: `canal-v-${sufixo}`, canalResourceId: "res-v", canalExpiraEm: new Date(Date.now() - 60_000) },
    });
    await sincronizarConexaoGoogle(c.id);
    expect(g.pararCanal).toHaveBeenCalledWith("at-ana", { id: `canal-v-${sufixo}`, resourceId: "res-v" });
    expect(await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } })).toMatchObject({ canalId: null, canalExpiraEm: null });
    fila.enfileirarSyncGoogle.mockClear();
    await manutencaoAgendaGoogle(new Date(), Date.now() + 20_000);
    expect(fila.enfileirarSyncGoogle).not.toHaveBeenCalledWith(c.id);

    // Push ligado e o `watch` recusado: espera própria, e o canal vencendo não puxa sincronização por minuto.
    env.GOOGLE_AGENDA_PUSH = "on";
    g.assistirAgenda.mockRejectedValue(new GoogleApiErro(400, "pushNotSupportedForRequestedResource"));
    await sincronizarConexaoGoogle(c.id);
    const s = await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } });
    expect(s.canalTentarEm!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    await basePrisma.calendarSync.update({ where: { id: s.id }, data: { canalId: `canal-w-${sufixo}`, canalExpiraEm: new Date(Date.now() + 3600_000) } });
    fila.enfileirarSyncGoogle.mockClear();
    await manutencaoAgendaGoogle(new Date(), Date.now() + 20_000);
    expect(fila.enfileirarSyncGoogle).not.toHaveBeenCalledWith(c.id);
  });

  it("série apagada tira os 'Ocupado' das instâncias; janela da completa vencendo → completa de novo", async () => {
    const c = await conectar(U.ana);
    agendaDe("at-ana").set("serie_20320611T120000Z", ev("serie_20320611T120000Z", { recurringEventId: "serie" }));
    agendaDe("at-ana").set(
      "serie_20320618T120000Z",
      ev("serie_20320618T120000Z", { recurringEventId: "serie", start: { dateTime: "2032-06-18T12:00:00Z" }, end: { dateTime: "2032-06-18T13:00:00Z" } }),
    );
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.calendarBusyBlock.count({ where: { connectionId: c.id } })).toBe(2);
    // O Google avisa só o evento-mãe apagado.
    agendaDe("at-ana").clear();
    agendaDe("at-ana").set("serie", { id: "serie", status: "cancelled", etag: '"serie-x"' });
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.calendarBusyBlock.count({ where: { connectionId: c.id } })).toBe(0);

    await basePrisma.calendarSync.updateMany({ where: { connectionId: c.id }, data: { janelaAte: new Date(Date.now() + 10 * DIA_MS) } });
    g.listarEventos.mockClear();
    expect(await sincronizarConexaoGoogle(c.id)).toMatchObject({ ok: true, completa: true });
    expect(g.listarEventos.mock.calls[0]![2].syncToken).toBeUndefined();
    expect(g.listarEventos.mock.calls[0]![2].timeMin).toBeTruthy();
    const s = await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } });
    expect(s.janelaAte!.getTime()).toBeGreaterThan(Date.now() + 170 * DIA_MS);
  });

  it("sincronização e salvar ao mesmo tempo: a lista velha do Google não apaga o convidado recém-incluído", async () => {
    const c = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Reunião", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "x@cliente.com.br" }] }));
    const idG = idDoEventoGoogle(a.id, c.id);
    agendaDe("at-ana").set(idG, { ...agendaDe("at-ana").get(idG)!, summary: "Mudou no Google", etag: '"g2"', updated: new Date(Date.now() + 60_000).toISOString() });
    // Entre o GET da sincronização e a escrita dela, a Ana inclui um convidado no CRM Agro.
    const obterOriginal = g.obterEvento.getMockImplementation()!;
    let primeira = true;
    g.obterEvento.mockImplementation(async (tok: string, cal: string, id: string) => {
      const r = await obterOriginal(tok, cal, id);
      if (primeira) {
        primeira = false;
        await como(U.ana, () => updateAppointment(a.id, { convidados: [{ email: "x@cliente.com.br" }, { email: "novo@cliente.com.br" }] }));
      }
      return r;
    });
    await sincronizarConexaoGoogle(c.id);
    const emails = (await basePrisma.appointmentAttendee.findMany({ where: { appointmentId: a.id }, select: { email: true } })).map((x) => x.email).sort();
    expect(emails).toEqual(["novo@cliente.com.br", "x@cliente.com.br"]);
  });

  it("PATCH num evento do Google mantém a sala, o organizador e os atributos de quem continua", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    agendaDe("at-ana").set(
      "comsala",
      ev("comsala", {
        summary: "Com sala",
        organizer: { email: "ana@gmail.com", self: true },
        attendees: [
          { email: "ana@gmail.com", self: true, organizer: true, responseStatus: "accepted" },
          { email: "sala-1@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
          { email: "p@fazenda.com.br", responseStatus: "accepted" },
          { email: "opcional@x.com.br", optional: true, responseStatus: "tentative" },
        ],
      }),
    );
    await sincronizarConexaoGoogle(c.id);
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM } });
    // Só a nota: o PATCH não mexe nos convidados.
    await como(U.ana, () => updateAppointment(a.id, { descricao: "nota" }));
    expect(g.atualizarEvento.mock.lastCall![3].attendees).toBeUndefined();
    // Entra um convidado: sala, organizador e o opcional ficam como estavam.
    await como(U.ana, () => updateAppointment(a.id, { convidados: [{ email: "p@fazenda.com.br" }, { email: "opcional@x.com.br" }, { email: "novo@x.com.br" }] }));
    const enviados = g.atualizarEvento.mock.lastCall![3].attendees;
    expect(enviados).toHaveLength(5);
    expect(enviados).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: "sala-1@resource.calendar.google.com", resource: true }),
        expect.objectContaining({ email: "ana@gmail.com", self: true }),
        expect.objectContaining({ email: "opcional@x.com.br", optional: true, responseStatus: "tentative" }),
        { email: "novo@x.com.br" },
      ]),
    );
  });

  it("cancelado no CRM Agro num evento de outra pessoa (convite) não é reaberto pela próxima mudança no Google", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    agendaDe("at-ana").set(
      "deles",
      ev("deles", { summary: "Do produtor", organizer: { email: "p@fazenda.com.br", self: false }, attendees: [{ email: "p@fazenda.com.br", organizer: true }, eu("ana@gmail.com", "accepted")] }),
    );
    await sincronizarConexaoGoogle(c.id);
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM }, include: { vinculos: true } });
    expect(a.vinculos[0]!.origem).toBe("convite");
    await como(U.ana, () => setAppointmentStatus(a.id, "cancelado"));
    expect(g.cancelarEvento).not.toHaveBeenCalled();
    agendaDe("at-ana").set("deles", { ...agendaDe("at-ana").get("deles")!, description: "pauta nova", etag: '"d2"', updated: new Date(Date.now() + 60_000).toISOString() });
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { status: true, descricao: true } })).toEqual({
      status: "cancelado",
      descricao: "pauta nova",
    });
  });

  it("evento que falha sempre não trava o cursor: erro visível, espera crescente e, depois de algumas rodadas, é pulado", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    agendaDe("at-ana").set("quebrado", ev("quebrado", { organizer: { email: "a@g.com", self: true }, attendees: [{ email: "p@fazenda.com.br" }] }));
    const obterOriginal = g.obterEvento.getMockImplementation()!;
    g.obterEvento.mockImplementation(async (tok: string, cal: string, id: string) => {
      if (id === "quebrado") throw new GoogleApiErro(404, "notFound");
      return obterOriginal(tok, cal, id);
    });
    for (let i = 1; i <= 4; i++) {
      await sincronizarConexaoGoogle(c.id);
      const s = await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } });
      expect(s.syncToken).toBeNull();
      expect(s.falhas).toBe(i);
      expect(s.ultimoErro).toContain("não aplicado");
      expect(s.proximaSincronizacaoEm!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    }
    await sincronizarConexaoGoogle(c.id);
    const s = await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } });
    expect(s.syncToken).toMatch(/^sync-/);
    expect(s).toMatchObject({ falhas: 0, ultimoErro: null });
  });

  it("aviso do Google que chega durante a sincronização ganha outra rodada no fim", async () => {
    env.GOOGLE_AGENDA_PUSH = "on";
    const c = await conectar(U.ana);
    await sincronizarConexaoGoogle(c.id); // abre o canal
    const s = await basePrisma.calendarSync.findFirstOrThrow({ where: { connectionId: c.id } });
    const listarOriginal = g.listarEventos.getMockImplementation()!;
    g.listarEventos.mockImplementationOnce(async (...args: unknown[]) => {
      expect(await receberAvisoDoGoogle({ canalId: s.canalId, token: tokenDoCanal(s.canalId!), resourceId: s.canalResourceId, estado: "exists" })).toBe("sincronizar");
      return (listarOriginal as (...a: unknown[]) => unknown)(...args);
    });
    fila.enfileirarSyncGoogle.mockClear();
    await sincronizarConexaoGoogle(c.id);
    expect(fila.enfileirarSyncGoogle).toHaveBeenCalledWith(c.id, { atrasoMs: 10_000 });
  });

  it("integração desligada no .env: o convite sai pelo .ics (nada fica 'pendente' para sempre) e os 'Ocupado' saem da grade", async () => {
    const c = await conectar(U.ana);
    await basePrisma.calendarBusyBlock.create({
      data: { teamId: TEAM, userId: U.ana.id, connectionId: c.id, externalEventId: "p-off", inicio: new Date("2032-06-11T12:00:00Z"), fim: new Date("2032-06-11T13:00:00Z") },
    });
    const antes = { id: env.GOOGLE_INTEGRACOES_CLIENT_ID, segredo: env.GOOGLE_INTEGRACOES_CLIENT_SECRET };
    Object.assign(env, { GOOGLE_INTEGRACOES_CLIENT_ID: undefined, GOOGLE_INTEGRACOES_CLIENT_SECRET: undefined });
    try {
      const a = await como(U.ana, () => createAppointment({ titulo: "Visita", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
      expect(g.inserirEvento).not.toHaveBeenCalled();
      expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
      expect(a.google).toBeNull();
      expect(await basePrisma.appointmentLink.count({ where: { appointmentId: a.id } })).toBe(0);
      expect(await como(U.ana, () => listarOcupados(faixa))).toEqual({ itens: [], cortado: false });
    } finally {
      Object.assign(env, { GOOGLE_INTEGRACOES_CLIENT_ID: antes.id, GOOGLE_INTEGRACOES_CLIENT_SECRET: antes.segredo });
    }
  });

  it("token recusado na hora de criar: o convite sai pelo .ics na hora (não espera reconectar)", async () => {
    const c = await conectar(U.ana, { expirado: true });
    g.renovarAccessToken.mockRejectedValueOnce(new GoogleAutorizacaoInvalida("invalid_grant"));
    const a = await como(U.ana, () => createAppointment({ titulo: "Visita", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    expect(a.google).toBeNull();
    expect(await basePrisma.appointmentLink.count({ where: { appointmentId: a.id } })).toBe(0);
    expect(await basePrisma.oAuthConnection.findUniqueOrThrow({ where: { id: c.id }, select: { status: true } })).toEqual({ status: "reauth_required" });
  });

  it("quem virou 'só leitura' desconecta a própria agenda (sem tela nem papel) e a sincronização fica parada", async () => {
    const c = await conectar(U.bia);
    await basePrisma.user.update({ where: { id: U.bia.id }, data: { role: "viewer" } });
    try {
      expect(await sincronizarConexaoGoogle(c.id)).toEqual({ ok: false, pulou: "parada" });
      const viewer = { ...U.bia, role: "viewer" };
      expect(await como(viewer, () => desconectarGoogle(), { modulos: ["painel"] })).toEqual({ desconectada: true });
      expect(g.revogarToken).toHaveBeenCalledWith("rt-bia");
      expect(await basePrisma.oAuthConnection.count({ where: { userId: U.bia.id } })).toBe(0);
      await expect(runWithTeam(TEAM, () => desconectarGoogle(), { userId: "system", role: "system" })).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await basePrisma.user.update({ where: { id: U.bia.id }, data: { role: "member" } });
    }
  });

  it("revogação durável: o token já está na fila (cifrado) quando o Google é chamado, e sai de lá quando ele confirma", async () => {
    await conectar(U.ana);
    let naFila = -1;
    g.revogarToken.mockImplementationOnce(async () => {
      naFila = await basePrisma.oAuthRevogacaoPendente.count({ where: { teamId: TEAM } });
    });
    await como(U.ana, () => desconectarGoogle());
    expect(naFila).toBe(1);
    expect(await basePrisma.oAuthRevogacaoPendente.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("gatilho da importação: contato compartilhado e convite de terceiro viram só 'Ocupado'; link da reunião só https; 'Tirar do CRM Agro' não volta", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Clínica", U.chefe, "clinica@saude.com.br", true);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    // (a) contato COMPARTILHADO de outra pessoa (a Ana o vê, mas não é dela)
    agendaDe("at-ana").set("consulta", ev("consulta", { organizer: { email: "a@g.com", self: true }, attendees: [{ email: "clinica@saude.com.br" }] }));
    // (b) terceiro convida e cita o contato da Ana; ela nem respondeu
    agendaDe("at-ana").set("golpe1", ev("golpe1", { organizer: { email: "atacante@x.com", self: false }, attendees: [eu(), { email: "p@fazenda.com.br" }] }));
    // (c) ela aceitou, mas quem organizou não é o contato nem colega
    agendaDe("at-ana").set("golpe2", ev("golpe2", { organizer: { email: "atacante@x.com", self: false }, attendees: [eu("ana@gmail.com", "accepted"), { email: "p@fazenda.com.br" }] }));
    expect(await sincronizarConexaoGoogle(c.id)).toMatchObject({ ok: true, compromissos: 0, ocupados: 3 });
    expect(g.obterEvento).not.toHaveBeenCalled();

    // (d) organizado por ela com o contato DELA: entra — o link que não é https fica de fora.
    agendaDe("at-ana").set("reuniao", ev("reuniao", { summary: "Com o produtor", hangoutLink: "javascript:alert(1)", organizer: { email: "a@g.com", self: true }, attendees: [{ email: "p@fazenda.com.br" }] }));
    await sincronizarConexaoGoogle(c.id);
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(a.reuniaoLink).toBeNull();
    expect(linkDaReuniao({ hangoutLink: "https://zoom.us/j/1" })).toBe("https://zoom.us/j/1");
    expect(provedorDaReuniao("https://zoom.us/j/1")).toBe("outro");
    expect(provedorDaReuniao(MEET)).toBe("meet");

    await como(U.ana, () => desvincularDoGoogle(a.id));
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(0);
    expect(g.cancelarEvento).not.toHaveBeenCalled();
    expect(await basePrisma.calendarBusyBlock.findFirstOrThrow({ where: { connectionId: c.id, externalEventId: "reuniao" } })).toMatchObject({ naoImportar: true });
    agendaDe("at-ana").set("reuniao", { ...agendaDe("at-ana").get("reuniao")!, summary: "Mudou", etag: '"r2"', updated: new Date(Date.now() + 60_000).toISOString() });
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("evento importado com 60 convidados continua salvando; o CRM Agro não inclui além de 50", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    const muitos = Array.from({ length: 59 }, (_, i) => ({ email: `pessoa${i}@evento.com.br` }));
    agendaDe("at-ana").set("grande", ev("grande", { organizer: { email: "a@g.com", self: true }, attendees: [{ email: "p@fazenda.com.br" }, ...muitos] }));
    await sincronizarConexaoGoogle(c.id);
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM }, include: { convidados: true } });
    expect(a.convidados).toHaveLength(60);
    const lista = a.convidados.map((x) => ({ email: x.email }));
    await expect(como(U.ana, () => updateAppointment(a.id, { convidados: lista, lembreteMin: 10 }))).resolves.toBeTruthy();
    await expect(como(U.ana, () => updateAppointment(a.id, { convidados: [...lista, { email: "mais@um.com.br" }] }))).rejects.toBeInstanceOf(LimiteDeConvidados);
  });

  it("o gestor vê os 'Ocupado' dos colegas por pessoa e dia (sem corte no meio do mês); a pessoa vê os dela um a um", async () => {
    const c = await conectar(U.ana);
    const bloco = (id: string, ini: string, fim: string) =>
      basePrisma.calendarBusyBlock.create({ data: { teamId: TEAM, userId: U.ana.id, connectionId: c.id, externalEventId: id, inicio: new Date(ini), fim: new Date(fim) } });
    await bloco("b1", "2032-06-11T12:00:00Z", "2032-06-11T13:00:00Z");
    await bloco("b2", "2032-06-11T15:00:00Z", "2032-06-11T16:00:00Z");
    await bloco("b3", "2032-06-11T18:00:00Z", "2032-06-11T19:00:00Z");
    await bloco("b4", "2032-06-12T12:00:00Z", "2032-06-12T13:00:00Z");
    const doGestor = await como(U.chefe, () => listarOcupados(faixa));
    expect(doGestor.cortado).toBe(false);
    expect(doGestor.itens).toHaveLength(2);
    expect(doGestor.itens[0]).toMatchObject({ pessoaId: U.ana.id, quantidade: 3, inicio: "2032-06-11T12:00:00.000Z", fim: "2032-06-11T19:00:00.000Z", meu: false });
    expect((await como(U.ana, () => listarOcupados(faixa))).itens).toHaveLength(4);
  });

  it("manutenção com trava: uma rodada em andamento faz a outra pular (nada em dobro)", async () => {
    const c = await conectar(U.ana);
    await redisEstado().set("agenda:google:manutencao", "outra-rodada", "EX", 30);
    try {
      fila.enfileirarSyncGoogle.mockClear();
      await processarJobAgendaGoogle({ tipo: "manutencao" });
      expect(fila.enfileirarSyncGoogle).not.toHaveBeenCalledWith(c.id);
    } finally {
      await redisEstado().del("agenda:google:manutencao");
    }
    await processarJobAgendaGoogle({ tipo: "manutencao" });
    expect(fila.enfileirarSyncGoogle).toHaveBeenCalledWith(c.id);
  });
});

// ---------------------------------------------------------------------------
// Terceira revisão do #169 (as correções da 2ª revisão, revisadas)
// ---------------------------------------------------------------------------

describe("revisão 3 do #169", () => {
  const DIA_MS = 24 * 3600_000;
  const faixa = { from: "2032-06-01T00:00:00Z", to: "2032-07-01T00:00:00Z" };
  const daquiA = (dias: number) => new Date(Date.now() + dias * DIA_MS).toISOString();
  const depois = (ms = 60_000) => new Date(Date.now() + ms).toISOString();
  const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ev = (id: string, extra: Partial<EventoGoogle> = {}): EventoGoogle => ({
    id,
    status: "confirmed",
    etag: `"r3-${id}-${++seq}"`,
    updated: new Date().toISOString(),
    start: { dateTime: "2032-06-11T12:00:00Z" },
    end: { dateTime: "2032-06-11T13:00:00Z" },
    ...extra,
  });
  /** Membro com "Ver e editar de todos" na Agenda (liberado pelo administrador na tela de Equipe). */
  const gestora = <T>(fn: () => Promise<T>) =>
    runWithTeam(TEAM, fn, { userId: U.bia.id, role: U.bia.role, verTudoEm: ["agenda"], editarTudoEm: ["agenda"] });
  const chefe = <T>(fn: () => Promise<T>) => como(U.chefe, fn);
  const convidadosDe = async (id: string) =>
    (await basePrisma.appointmentAttendee.findMany({ where: { appointmentId: id }, select: { email: true } })).map((x) => x.email).sort();
  const linkDe = (id: string) => basePrisma.appointmentLink.findFirst({ where: { appointmentId: id } });
  const icsDa = (i: number) => String((email.sendCalendarInvite.mock.calls.at(i)![0] as { ics: string }).ics);
  const uidDa = (i: number) => /UID:([^\r\n]+)/.exec(icsDa(i))?.[1];
  const agora5 = () => new Date(Date.now() + 5 * 60_000);

  it("quem edita tudo (membro liberado ou administrador) só REMARCA ou CANCELA o que a responsável convidou pelo Google dela", async () => {
    const c = await conectar(U.ana);
    const a = await como(U.ana, () =>
      createAppointment({ titulo: "Proposta", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }, { email: "socio@x.com.br" }] }),
    );
    expect(g.inserirEvento.mock.calls[0]![3]).toEqual({ sendUpdates: "all", conferenceDataVersion: 1 });
    g.atualizarEvento.mockClear();
    await esperar(5);
    for (const quem of [gestora, chefe]) {
      // Texto livre de outra pessoa saindo pela conta Google da Ana (phishing em nome dela): não.
      await expect(quem(() => updateAppointment(a.id, { titulo: "URGENTE: boleto vencido" }))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
      await expect(quem(() => updateAppointment(a.id, { descricao: "Pague em http://golpe.exemplo/boleto" }))).rejects.toBeInstanceOf(
        AlteracaoSoPeloResponsavel,
      );
      await expect(quem(() => updateAppointment(a.id, { local: "http://golpe.exemplo" }))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
      // Virar reunião online criaria o Meet na conta dela e avisaria os clientes.
      await expect(quem(() => updateAppointment(a.id, { tipo: "reuniao_online" }))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
      // Tirar convidado = cancelamento saindo da conta dela.
      await expect(quem(() => updateAppointment(a.id, { convidados: [{ email: "cliente@x.com.br" }] }))).rejects.toBeInstanceOf(ConviteSoPeloResponsavel);
    }
    expect(g.atualizarEvento).not.toHaveBeenCalled();
    expect(email.sendCalendarInvite).not.toHaveBeenCalled();
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { titulo: true, descricao: true, local: true, tipo: true } })).toEqual({
      titulo: "Proposta",
      descricao: null,
      local: null,
      tipo: "tarefa",
    });
    expect(await convidadosDe(a.id)).toEqual(["cliente@x.com.br", "socio@x.com.br"]);
    // A tela sabe travar esses campos para quem não é a responsável.
    expect((await gestora(() => listAppointments(faixa)))[0]).toMatchObject({ id: a.id, conviteNoGoogle: true });

    // Remarcar pode (os convidados precisam do horário novo) — o mesmo texto de antes, pela conta dela.
    await gestora(() => updateAppointment(a.id, { titulo: "Proposta", inicio: "2032-06-10T15:00:00.000Z", lembreteMin: 60 }));
    expect(g.atualizarEvento).toHaveBeenCalledTimes(1);
    const [tok, , , corpo, opts] = g.atualizarEvento.mock.calls[0]!;
    expect(tok).toBe("at-ana");
    expect(opts).toEqual({ sendUpdates: "all", conferenceDataVersion: 1 });
    expect(corpo).toMatchObject({ summary: "Proposta", start: { dateTime: "2032-06-10T15:00:00.000Z" } });
    expect(corpo.attendees).toBeUndefined();
    // Cancelar pode; REABRIR (convidar de novo pela conta dela) é só dela.
    await gestora(() => setAppointmentStatus(a.id, "cancelado"));
    expect(g.cancelarEvento).toHaveBeenLastCalledWith("at-ana", "primary", idDoEventoGoogle(a.id, c.id), { sendUpdates: "all" });
    await expect(gestora(() => setAppointmentStatus(a.id, "pendente"))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
    await expect(chefe(() => setAppointmentStatus(a.id, "concluido"))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("cancelado");
    await como(U.ana, () => setAppointmentStatus(a.id, "pendente"));
    // A própria responsável muda o que quiser (é a conta dela).
    g.atualizarEvento.mockClear();
    await como(U.ana, () => updateAppointment(a.id, { titulo: "Proposta revista", convidados: [{ email: "cliente@x.com.br" }] }));
    expect(g.atualizarEvento.mock.lastCall![3]).toMatchObject({ summary: "Proposta revista", attendees: [{ email: "cliente@x.com.br" }] });
    expect(g.atualizarEvento.mock.lastCall![4]).toEqual({ sendUpdates: "all", conferenceDataVersion: 1 });
    // Trocar o responsável continua podendo (o evento dela é cancelado e o convite é decidido de novo).
    await gestora(() => updateAppointment(a.id, { responsavelId: U.caio.id, titulo: "Agora do Caio" }));
    expect(g.cancelarEvento).toHaveBeenLastCalledWith("at-ana", "primary", idDoEventoGoogle(a.id, c.id), { sendUpdates: "all" });
  });

  it("desconectar e reconectar não abre brecha: com a agenda fora, quem não é a responsável não mexe nos convidados; o evento religado não convida ninguém", async () => {
    const c1 = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Proposta", inicio: daquiA(3), convidados: [{ email: "cliente@x.com.br" }] }));
    const e1 = idDoEventoGoogle(a.id, c1.id);
    await como(U.ana, () => desconectarGoogle());
    await esperar(5);
    // Sem vínculo, a regra olha o CANAL do convite (o Google dela), não o vínculo.
    await expect(
      gestora(() => updateAppointment(a.id, { convidados: [{ email: "cliente@x.com.br" }, { email: "phishing@atacante.com" }] })),
    ).rejects.toBeInstanceOf(ConviteSoPeloResponsavel);
    await expect(chefe(() => updateAppointment(a.id, { titulo: "Pague o boleto" }))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
    expect(email.sendCalendarInvite).not.toHaveBeenCalled();
    // Ela reconecta a MESMA conta (conexão nova): o evento é religado, sem PATCH e sem convite.
    const c2 = await conectar(U.ana);
    g.atualizarEvento.mockClear();
    g.inserirEvento.mockClear();
    await sincronizarConexaoGoogle(c2.id);
    await enviarPendentesAoGoogle(agora5());
    expect(g.inserirEvento).not.toHaveBeenCalled();
    expect(g.atualizarEvento).not.toHaveBeenCalled();
    expect(await linkDe(a.id)).toMatchObject({ connectionId: c2.id, externalEventId: e1, pendenteDesde: null });
    // O canal do convite seguiu com o evento que convidou (mesmo iCalUID).
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { convitesPorConexaoId: true, convitesICalUID: true } })).toEqual({
      convitesPorConexaoId: c2.id,
      convitesICalUID: `${e1}@google.com`,
    });
    expect(await convidadosDe(a.id)).toEqual(["cliente@x.com.br"]);
  });

  it("nem trocando o responsável no meio: quem o gestor incluiu enquanto a agenda da Ana estava fora nunca é convidado pelo Google dela", async () => {
    const c1 = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Proposta", inicio: daquiA(3), convidados: [{ email: "cliente@x.com.br" }] }));
    const e1 = idDoEventoGoogle(a.id, c1.id);
    await como(U.ana, () => desconectarGoogle());
    await esperar(5);
    // Trocar o responsável pode (e aí incluir também): o convite sai pelo .ics do time, com o UID do evento da Ana.
    await gestora(() => updateAppointment(a.id, { responsavelId: U.caio.id, convidados: [{ email: "cliente@x.com.br" }, { email: "phishing@atacante.com" }] }));
    expect(email.sendCalendarInvite.mock.calls.map((x) => (x[0] as { to: string }).to).sort()).toEqual(["cliente@x.com.br", "phishing@atacante.com"]);
    expect(uidDa(0)).toBe(`${e1}@google.com`);
    await gestora(() => updateAppointment(a.id, { responsavelId: U.ana.id }));
    // A Ana reconecta: o evento dela é religado, mas o canal do convite já é o .ics — o Google dela não convida ninguém.
    const c2 = await conectar(U.ana);
    g.atualizarEvento.mockClear();
    await sincronizarConexaoGoogle(c2.id);
    await enviarPendentesAoGoogle(agora5());
    expect(await linkDe(a.id)).toMatchObject({ connectionId: c2.id, externalEventId: e1 });
    expect(g.atualizarEvento.mock.calls.every((x) => x[4].sendUpdates === "none" && x[3].attendees === undefined)).toBe(true);
    expect((agendaDe("at-ana").get(e1)!.attendees ?? []).map((x) => x.email)).toEqual(["cliente@x.com.br"]);
  });

  it("religar não passa o canal do convite para um evento que NÃO convidou (iCalUID diferente)", async () => {
    const c1 = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Proposta", inicio: daquiA(3), convidados: [{ email: "cliente@x.com.br" }] }));
    const e1 = idDoEventoGoogle(a.id, c1.id);
    await como(U.ana, () => desconectarGoogle());
    // Na agenda dela, o evento com o id do CRM Agro agora tem outro UID (foi recriado lá).
    agendaDe("at-ana").set(e1, { ...agendaDe("at-ana").get(e1)!, iCalUID: "outro-uid@google.com", etag: '"recriado"' });
    const c2 = await conectar(U.ana);
    await sincronizarConexaoGoogle(c2.id);
    expect(await linkDe(a.id)).toMatchObject({ connectionId: c2.id });
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).convitesPorConexaoId).toBe(c1.id);
    // A Ana inclui alguém: o evento religado não leva ninguém (sendUpdates=none); o convite vai pelo .ics.
    g.atualizarEvento.mockClear();
    await como(U.ana, () => updateAppointment(a.id, { convidados: [{ email: "cliente@x.com.br" }, { email: "novo@x.com.br" }] }));
    expect(g.atualizarEvento.mock.lastCall![4]).toEqual({ sendUpdates: "none", conferenceDataVersion: 1 });
    expect(g.atualizarEvento.mock.lastCall![3].attendees).toBeUndefined();
    // A atualização vai pelo .ics, com o UID do evento que convidou (o de antes).
    expect(email.sendCalendarInvite.mock.calls.map((x) => (x[0] as { to: string }).to).sort()).toEqual(["cliente@x.com.br", "novo@x.com.br"]);
    expect(uidDa(0)).toBe(`${e1}@google.com`);
  });

  it("o que vem da Agenda Google fica só com a dona até ela confirmar: o administrador que dá a ela o contato da clínica não lê a consulta", async () => {
    const c = await conectar(U.ana);
    // O administrador cria o contato com o e-mail da clínica e o põe como da Ana (criar + transferir).
    await contato(TEAM, "Clínica", U.ana, "recepcao@clinica-psi.com.br");
    agendaDe("at-ana").set(
      "consulta1",
      ev("consulta1", {
        summary: "Sessão de terapia",
        description: "Retorno — ansiedade",
        organizer: { email: "recepcao@clinica-psi.com.br" },
        attendees: [{ email: "recepcao@clinica-psi.com.br", organizer: true }, { email: "ana@gmail.com", self: true, responseStatus: "accepted" }],
      }),
    );
    expect(await sincronizarConexaoGoogle(c.id)).toMatchObject({ ok: true, compromissos: 1 });
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM, origem: "google" } });
    expect(a.privadoAteConfirmar).toBe(true);
    // Ninguém além dela: master, administrador, quem vê a Agenda de todos, nem o "ver como" a Ana.
    expect(await como(U.dono, () => listAppointments(faixa))).toEqual([]);
    expect(await chefe(() => listAppointments(faixa))).toEqual([]);
    expect(await gestora(() => listAppointments(faixa))).toEqual([]);
    expect(await como(U.dono, () => runVendoComo(U.ana.id, () => listAppointments(faixa)))).toEqual([]);
    await expect(chefe(() => updateAppointment(a.id, { titulo: "x" }))).rejects.toBeInstanceOf(OwnedNotFound);
    await expect(chefe(() => confirmarDoGoogle(a.id))).rejects.toBeInstanceOf(OwnedNotFound);
    // A rota do dia da Ana pedida pelo administrador também não mostra.
    const rotaDoChefe = await chefe(() => rotaDoDia({ data: "2032-06-11", responsavelId: U.ana.id }));
    expect([...rotaDoChefe.paradas.map((p) => p.appointmentId), ...rotaDoChefe.semLocal.map((p) => p.appointmentId)]).not.toContain(a.id);
    const rotaDela = await como(U.ana, () => rotaDoDia({ data: "2032-06-11" }));
    expect(rotaDela.semLocal.map((p) => p.appointmentId)).toContain(a.id);
    // Ela vê, marcado como só dela.
    expect((await como(U.ana, () => listAppointments(faixa))).map((x) => [x.titulo, x.privado])).toEqual([["Sessão de terapia", true]]);
    // "Manter no CRM Agro": é de trabalho — o time passa a ver.
    expect(await como(U.ana, () => confirmarDoGoogle(a.id))).toMatchObject({ privado: false });
    expect((await chefe(() => listAppointments(faixa))).map((x) => x.titulo)).toEqual(["Sessão de terapia"]);
  });

  it("excluir a pessoa: o que veio do Google dela e não foi confirmado sai com ela (não vai para quem recebe)", async () => {
    const c = await conectar(U.caio);
    await contato(TEAM, "Médico", U.caio, "medico@clinica.com.br");
    agendaDe("at-caio").set(
      "consultaCaio",
      ev("consultaCaio", { summary: "Consulta", organizer: { email: "caio@gmail.com", self: true }, attendees: [{ email: "medico@clinica.com.br" }] }),
    );
    await sincronizarConexaoGoogle(c.id);
    const privado = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM, origem: "google" } });
    const doCaio = await como(U.caio, () => createAppointment({ titulo: "Visita", inicio: "2032-06-10T13:00:00.000Z" }));
    const r = await como(U.dono, () => excluirIntegrante(U.caio.id, U.bia.id));
    expect(r.transferidos.compromissos).toBe(1);
    expect(await basePrisma.appointment.findUnique({ where: { id: privado.id } })).toBeNull();
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: doCaio.id }, select: { responsavelId: true } })).toEqual({ responsavelId: U.bia.id });
    await basePrisma.user.create({ data: { id: U.caio.id, teamId: TEAM, role: "member", name: "caio", email: U.caio.email } });
  });

  it("convidou pelo Google e desconectou: o .ics seguinte usa o UID do evento do Google (o cliente atualiza e cancela a MESMA entrada)", async () => {
    const c1 = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Proposta", inicio: daquiA(3), convidados: [{ email: "cliente@x.com.br" }] }));
    expect(email.sendCalendarInvite).not.toHaveBeenCalled();
    const uidGoogle = agendaDe("at-ana").get(idDoEventoGoogle(a.id, c1.id))!.iCalUID!;
    await como(U.ana, () => desconectarGoogle());
    await como(U.ana, () => updateAppointment(a.id, { inicio: daquiA(4) }));
    expect(email.sendCalendarInvite.mock.calls.map((x) => (x[0] as { to: string }).to)).toEqual(["cliente@x.com.br"]);
    expect(uidDa(0)).toBe(uidGoogle);
    await como(U.ana, () => setAppointmentStatus(a.id, "cancelado"));
    expect(icsDa(1)).toContain("METHOD:CANCEL");
    expect(uidDa(1)).toBe(uidGoogle);
    // Sem Google no caminho desde o começo: o UID de sempre.
    const b = await como(U.ana, () => createAppointment({ titulo: "Sem Google", inicio: daquiA(5), convidados: [{ email: "outro@x.com.br" }] }));
    expect(uidDa(2)).toBe(`${b.id}@crmagro`);
  });

  it("evento que foi SEM convidados (convite pelo .ics): mudança no Google não apaga os convidados do CRM Agro, e o .ics leva o horário novo e o cancelamento", async () => {
    const cCaio = await conectar(U.caio);
    const a = await como(U.ana, () =>
      createAppointment({ titulo: "Proposta", inicio: "2032-06-10T13:00:00.000Z", responsavelId: U.caio.id, convidados: [{ email: "cliente@x.com.br" }] }),
    );
    const idG = idDoEventoGoogle(a.id, cCaio.id);
    expect(agendaDe("at-caio").get(idG)!.attendees).toBeUndefined();
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    await sincronizarConexaoGoogle(cCaio.id);
    email.sendCalendarInvite.mockClear();
    // O Caio remarca no Google dele.
    const atual = agendaDe("at-caio").get(idG)!;
    agendaDe("at-caio").set(idG, { ...atual, start: { dateTime: "2032-06-10T17:00:00Z" }, end: { dateTime: "2032-06-10T18:00:00Z" }, etag: '"moveu"', updated: depois() });
    await sincronizarConexaoGoogle(cCaio.id);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { inicio: true } })).toEqual({ inicio: new Date("2032-06-10T17:00:00Z") });
    expect(await convidadosDe(a.id)).toEqual(["cliente@x.com.br"]);
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    expect((email.sendCalendarInvite.mock.calls[0]![0] as { to: string }).to).toBe("cliente@x.com.br");
    expect(icsDa(0)).toContain("METHOD:REQUEST");
    expect(icsDa(0)).toContain("DTSTART:20320610T170000Z");
    expect(uidDa(0)).toBe(`${a.id}@crmagro`);
    // Apagado no Google: o cliente recebe o cancelamento pelo mesmo caminho.
    agendaDe("at-caio").set(idG, { ...agendaDe("at-caio").get(idG)!, status: "cancelled", etag: '"apagou"', updated: depois(120_000) });
    await sincronizarConexaoGoogle(cCaio.id);
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("cancelado");
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(2);
    expect(icsDa(1)).toContain("METHOD:CANCEL");
    expect(await convidadosDe(a.id)).toEqual(["cliente@x.com.br"]);
  });

  it("cancelamento do CRM Agro que ainda não chegou ao Google (5xx ou 'Reconectar') vale mesmo com uma mudança mais nova lá", async () => {
    const c = await conectar(U.ana);
    // (a) Google fora do ar na hora de cancelar; a Ana mexe na descrição pelo Google depois.
    const a = await como(U.ana, () => createAppointment({ titulo: "Reunião", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    const idA = idDoEventoGoogle(a.id, c.id);
    await sincronizarConexaoGoogle(c.id);
    g.cancelarEvento.mockRejectedValueOnce(new GoogleApiErro(503, "backendError"));
    await como(U.ana, () => setAppointmentStatus(a.id, "cancelado"));
    agendaDe("at-ana").set(idA, { ...agendaDe("at-ana").get(idA)!, description: "pauta nova (editada no Google)", etag: '"edit"', updated: depois() });
    await sincronizarConexaoGoogle(c.id);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { status: true, descricao: true } })).toEqual({
      status: "cancelado",
      descricao: "pauta nova (editada no Google)",
    });
    expect((await linkDe(a.id))!.pendenteDesde).not.toBeNull();
    await enviarPendentesAoGoogle(agora5());
    expect(g.cancelarEvento).toHaveBeenLastCalledWith("at-ana", "primary", idA, { sendUpdates: "all" });
    expect(agendaDe("at-ana").get(idA)!.status).toBe("cancelled");

    // (b) Conta em "Reconectar" e o gestor cancela; ao reconectar, a sincronização roda antes do worker.
    const b = await como(U.ana, () => createAppointment({ titulo: "Outra", inicio: "2032-06-12T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    const idB = idDoEventoGoogle(b.id, c.id);
    await sincronizarConexaoGoogle(c.id);
    await basePrisma.oAuthConnection.update({ where: { id: c.id }, data: { status: "reauth_required" } });
    await chefe(() => setAppointmentStatus(b.id, "cancelado"));
    agendaDe("at-ana").set(idB, { ...agendaDe("at-ana").get(idB)!, description: "levar proposta", etag: '"desc"', updated: depois() });
    await basePrisma.oAuthConnection.update({ where: { id: c.id }, data: { status: "connected" } });
    await sincronizarConexaoGoogle(c.id);
    await enviarPendentesAoGoogle(agora5());
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("cancelado");
    expect(agendaDe("at-ana").get(idB)!.status).toBe("cancelled");
  });

  it("desconectar, editar no CRM Agro e reconectar: a edição vai para o Google e uma resposta de convidado depois não a desfaz", async () => {
    const c1 = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Visita", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    const idG = idDoEventoGoogle(a.id, c1.id);
    await sincronizarConexaoGoogle(c1.id);
    await como(U.ana, () => desconectarGoogle());
    await como(U.ana, () => updateAppointment(a.id, { titulo: "Visita remarcada", inicio: "2032-06-10T15:00:00.000Z" }));
    // O cliente aceita no Google depois (o `updated` de lá fica mais novo).
    agendaDe("at-ana").set(idG, {
      ...agendaDe("at-ana").get(idG)!,
      attendees: [{ email: "cliente@x.com.br", responseStatus: "accepted" }],
      etag: '"rsvp"',
      updated: depois(),
    });
    const c2 = await conectar(U.ana);
    g.atualizarEvento.mockClear();
    await sincronizarConexaoGoogle(c2.id);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { titulo: true, inicio: true } })).toEqual({
      titulo: "Visita remarcada",
      inicio: new Date("2032-06-10T15:00:00.000Z"),
    });
    expect(await basePrisma.appointmentAttendee.findFirstOrThrow({ where: { appointmentId: a.id }, select: { resposta: true } })).toEqual({ resposta: "accepted" });
    await enviarPendentesAoGoogle(agora5());
    expect(agendaDe("at-ana").get(idG)).toMatchObject({ summary: "Visita remarcada", start: { dateTime: "2032-06-10T15:00:00.000Z" } });
    expect(g.atualizarEvento.mock.lastCall![4]).toEqual({ sendUpdates: "all", conferenceDataVersion: 1 });
    expect((await linkDe(a.id))!.pendenteDesde).toBeNull();
  });

  it("troca de responsável: o cancelamento do evento na agenda antiga é DURÁVEL (Google fora do ar ou conta em 'Reconectar')", async () => {
    const cAna = await conectar(U.ana);
    const cCaio = await conectar(U.caio);
    const a = await como(U.ana, () => createAppointment({ titulo: "Com cliente", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
    const idAna = idDoEventoGoogle(a.id, cAna.id);
    await sincronizarConexaoGoogle(cAna.id);
    g.cancelarEvento.mockRejectedValueOnce(new GoogleApiErro(503, "backendError"));
    await como(U.ana, () => updateAppointment(a.id, { responsavelId: U.caio.id }));
    // O vínculo antigo fica aposentado, na fila — e não é o estado do compromisso.
    expect(await basePrisma.appointmentLink.findFirstOrThrow({ where: { appointmentId: a.id, connectionId: cAna.id } })).toMatchObject({
      cancelarAvisando: true,
      tentativas: 1,
    });
    expect((await como(U.caio, () => listAppointments(faixa)))[0]).toMatchObject({ id: a.id, google: "sincronizado" });
    // Mudança no evento antigo (agenda da Ana) não chega ao compromisso, que agora é do Caio.
    agendaDe("at-ana").set(idAna, { ...agendaDe("at-ana").get(idAna)!, summary: "Mexido na agenda antiga", etag: '"x"', updated: depois() });
    await sincronizarConexaoGoogle(cAna.id);
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).titulo).toBe("Com cliente");
    g.cancelarEvento.mockClear();
    g.atualizarEvento.mockClear();
    await enviarPendentesAoGoogle(agora5());
    expect(g.cancelarEvento).toHaveBeenCalledTimes(1);
    expect(g.cancelarEvento).toHaveBeenCalledWith("at-ana", "primary", idAna, { sendUpdates: "all" });
    // O evento do Caio (em dia) não é reenviado junto.
    expect(g.atualizarEvento).not.toHaveBeenCalled();
    expect(agendaDe("at-ana").get(idAna)!.status).toBe("cancelled");
    expect(await basePrisma.appointmentLink.count({ where: { appointmentId: a.id, connectionId: cAna.id } })).toBe(0);

    // Conta do antigo em "Reconectar": nem tenta; espera ela voltar e então cancela.
    const b = await como(U.caio, () => createAppointment({ titulo: "Do Caio", inicio: "2032-06-12T13:00:00.000Z", convidados: [{ email: "c2@x.com.br" }] }));
    const idCaio = idDoEventoGoogle(b.id, cCaio.id);
    await basePrisma.oAuthConnection.update({ where: { id: cCaio.id }, data: { status: "reauth_required" } });
    g.cancelarEvento.mockClear();
    email.sendCalendarInvite.mockClear();
    await como(U.caio, () => updateAppointment(b.id, { responsavelId: U.bia.id }));
    expect(g.cancelarEvento).not.toHaveBeenCalled();
    // A Bia não tem agenda conectada: o convite novo sai pelo .ics.
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    await enviarPendentesAoGoogle(agora5());
    expect(g.cancelarEvento).not.toHaveBeenCalled();
    await basePrisma.oAuthConnection.update({ where: { id: cCaio.id }, data: { status: "connected" } });
    await enviarPendentesAoGoogle(agora5());
    expect(g.cancelarEvento).toHaveBeenCalledWith("at-caio", "primary", idCaio, { sendUpdates: "all" });
    expect(agendaDe("at-caio").get(idCaio)!.status).toBe("cancelled");
    expect(await basePrisma.appointmentLink.count({ where: { appointmentId: b.id } })).toBe(0);
  });

  it("série apagada no Google não reescreve o histórico: o concluído e o que já passou ficam como estão", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    const instancia = (dias: number) => {
      const ini = new Date(Date.now() + dias * DIA_MS);
      const id = `serie_${ini.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
      agendaDe("at-ana").set(
        id,
        ev(id, {
          recurringEventId: "serie",
          summary: "Visita semanal",
          organizer: { email: "a@g.com", self: true },
          attendees: [{ email: "p@fazenda.com.br" }],
          start: { dateTime: ini.toISOString() },
          end: { dateTime: new Date(ini.getTime() + 3600_000).toISOString() },
        }),
      );
      return id;
    };
    const ids = [instancia(-3), instancia(-2), instancia(3)];
    await sincronizarConexaoGoogle(c.id);
    const [concluida, passada, futura] = await Promise.all(
      ids.map(async (id) => (await basePrisma.appointmentLink.findFirstOrThrow({ where: { externalEventId: id }, select: { appointmentId: true } })).appointmentId),
    );
    await como(U.ana, () => setAppointmentStatus(concluida!, "concluido"));
    agendaDe("at-ana").clear();
    agendaDe("at-ana").set("serie", { id: "serie", status: "cancelled", etag: '"serie-apagada"' });
    await sincronizarConexaoGoogle(c.id);
    const status = async (id: string) => (await basePrisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    expect(await status(concluida!)).toBe("concluido");
    expect(await status(passada!)).toBe("pendente");
    expect(await status(futura!)).toBe("cancelado");
  });
});

// ---------------------------------------------------------------------------
// A1 — 3ª conferência do #169: bugs sutis achados na revisão adversarial
// ---------------------------------------------------------------------------

describe("A1 — 3ª conferência do #169", () => {
  const faixa = { from: "2032-06-01T00:00:00Z", to: "2032-07-01T00:00:00Z" };
  const DIA_MS = 24 * 3600_000;
  const daquiA = (dias: number) => new Date(Date.now() + dias * DIA_MS).toISOString();
  const agora5 = () => new Date(Date.now() + 5 * 60_000);
  const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ev = (id: string, extra: Partial<EventoGoogle> = {}): EventoGoogle => ({
    id,
    status: "confirmed",
    etag: `"a1-${id}-${++seq}"`,
    updated: new Date().toISOString(),
    start: { dateTime: "2032-06-11T12:00:00Z" },
    end: { dateTime: "2032-06-11T13:00:00Z" },
    ...extra,
  });
  const gestora = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: U.bia.id, role: U.bia.role, verTudoEm: ["agenda"], editarTudoEm: ["agenda"] });

  it("colega CONVIDADO que não vê o contato não recebe o nome dele (convidado) nem a coordenada da visita; a responsável recebe tudo", async () => {
    const ct = await contato(TEAM, "Fazenda Santa Rita", U.ana, "gerente@santarita.com.br");
    await basePrisma.contact.update({ where: { id: ct.id }, data: { latitude: -12.54, longitude: -55.72 } });
    const a = await como(U.ana, () =>
      createAppointment({
        titulo: "Visita técnica",
        tipo: "visita",
        inicio: "2032-06-10T13:00:00.000Z",
        contactId: ct.id,
        convidados: [{ email: "gerente@santarita.com.br" }, { userId: U.bia.id }],
      }),
    );
    // A responsável vê o contato, o nome do convidado-contato e a coordenada.
    expect(a).toMatchObject({ contactId: ct.id, contactNome: "Fazenda Santa Rita", latitude: -12.54, longitude: -55.72 });
    expect(a.convidados.find((c) => c.email === "gerente@santarita.com.br")).toMatchObject({ nome: "Fazenda Santa Rita", contactId: ct.id });
    // A Bia (colega convidada, sem esse contato em Contatos) vê a reunião, sem descobrir o contato por ela.
    const daBia = (await como(U.bia, () => listAppointments(faixa))).find((x) => x.id === a.id)!;
    expect(daBia).toMatchObject({ contactId: null, contactNome: null, latitude: null, longitude: null });
    const cont = daBia.convidados.find((c) => c.email === "gerente@santarita.com.br")!;
    expect(cont).toMatchObject({ nome: null, contactId: null });
    expect(JSON.stringify(daBia)).not.toContain("Santa Rita");
    // A colega segue aparecendo pelo próprio nome.
    expect(daBia.convidados.find((c) => c.userId === U.bia.id)).toMatchObject({ nome: "bia" });
    // A Ana, na lista dela (com a Bia junto no mesmo intervalo), continua vendo tudo.
    const daAna = (await como(U.ana, () => listAppointments(faixa))).find((x) => x.id === a.id)!;
    expect(daAna).toMatchObject({ contactNome: "Fazenda Santa Rita", latitude: -12.54, longitude: -55.72 });
    // Quando o contato é da Bia, ela o vê normalmente (o filtro é o escopo de Contatos de quem lê).
    await basePrisma.contact.update({ where: { id: ct.id }, data: { compartilhado: true } });
    const compartilhado = (await como(U.bia, () => listAppointments(faixa))).find((x) => x.id === a.id)!;
    expect(compartilhado).toMatchObject({ contactNome: "Fazenda Santa Rita", latitude: -12.54 });
  });

  it("'Eu' na tela manda responsavelId nulo: criar assim fica com quem criou (e não 'do time', que nunca iria ao Google)", async () => {
    const c = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Pela tela", inicio: daquiA(3), responsavelId: null }));
    expect(a.responsavelId).toBe(U.ana.id);
    expect(g.inserirEvento).toHaveBeenCalledTimes(1);
    expect(g.inserirEvento.mock.calls[0]![2].id).toBe(idDoEventoGoogle(a.id, c.id));
    // A automação (sem pessoa) continua criando "do time".
    const doTime = await runAsSystem(TEAM, () => createAppointment({ titulo: "Da automação", inicio: daquiA(4), responsavelId: null }));
    expect(doTime.responsavelId).toBeNull();
  });

  it("o que veio da Agenda Google e ainda é privado não passa para outra pessoa (nem para 'do time') antes de a dona confirmar", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Clínica", U.ana, "recepcao@clinica-psi.com.br");
    agendaDe("at-ana").set(
      "consulta9",
      ev("consulta9", {
        summary: "Sessão de terapia",
        organizer: { email: "ana@gmail.com", self: true },
        attendees: [{ email: "recepcao@clinica-psi.com.br" }],
        start: { dateTime: daquiA(2) },
        end: { dateTime: new Date(Date.now() + 2 * DIA_MS + 3600_000).toISOString() },
      }),
    );
    await sincronizarConexaoGoogle(c.id);
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM, origem: "google" } });
    expect(a.privadoAteConfirmar).toBe(true);
    // Passar para a Bia (ela leria a agenda pessoal da Ana) ou para "do time" (o lembrete iria aos administradores): recusado.
    await expect(como(U.ana, () => updateAppointment(a.id, { responsavelId: U.bia.id }))).rejects.toBeInstanceOf(ConfirmarAntesDeTransferir);
    await expect(como(U.ana, () => updateAppointment(a.id, { responsavelId: null }))).rejects.toBeInstanceOf(ConfirmarAntesDeTransferir);
    expect(await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { responsavelId: true, privadoAteConfirmar: true } })).toEqual({
      responsavelId: U.ana.id,
      privadoAteConfirmar: true,
    });
    expect(await como(U.bia, () => listAppointments({ from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" }))).toEqual([]);
    // Mudar outra coisa (o responsável continua o mesmo) segue valendo.
    await expect(como(U.ana, () => updateAppointment(a.id, { lembreteMin: 10, responsavelId: U.ana.id }))).resolves.toBeTruthy();
    // Depois de "Manter no CRM Agro" (é de trabalho), pode passar para quem quiser.
    await como(U.ana, () => confirmarDoGoogle(a.id));
    await expect(como(U.ana, () => updateAppointment(a.id, { responsavelId: U.bia.id }))).resolves.toMatchObject({ responsavelId: U.bia.id, privado: false });
  });

  it("desconectar e reconectar a MESMA conta não duplica o que veio do Google: o compromisso importado é religado ao evento (mesmo iCalUID)", async () => {
    const c1 = await conectar(U.ana);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    const ini = new Date(Date.now() + 3 * DIA_MS);
    const evento = ev("reuniaoimp", {
      summary: "Com o produtor",
      iCalUID: "reuniaoimp@google.com",
      organizer: { email: "ana@gmail.com", self: true },
      attendees: [{ email: "p@fazenda.com.br" }],
      start: { dateTime: ini.toISOString() },
      end: { dateTime: new Date(ini.getTime() + 3600_000).toISOString() },
    });
    agendaDe("at-ana").set(evento.id, evento);
    await sincronizarConexaoGoogle(c1.id);
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM, origem: "google" } });
    await como(U.ana, () => confirmarDoGoogle(a.id));
    await como(U.ana, () => desconectarGoogle());
    expect(await basePrisma.appointmentLink.count({ where: { appointmentId: a.id } })).toBe(0);
    // Reconecta a mesma conta: o evento volta na lista do Google (conexão nova, sem cursor).
    const c2 = await conectar(U.ana);
    await sincronizarConexaoGoogle(c2.id);
    // Continua UM compromisso, ligado ao evento pela conexão nova, sem ficar privado de novo (a dona já o mantinha).
    const todos = await basePrisma.appointment.findMany({ where: { teamId: TEAM }, include: { vinculos: true } });
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ id: a.id, privadoAteConfirmar: false });
    expect(todos[0]!.vinculos).toHaveLength(1);
    expect(todos[0]!.vinculos[0]).toMatchObject({ connectionId: c2.id, externalEventId: evento.id, origem: "google" });
    // E volta a acompanhar o Google: a mudança de lá chega ao compromisso.
    agendaDe("at-ana").set(evento.id, { ...agendaDe("at-ana").get(evento.id)!, summary: "Com o produtor (remarcado)", etag: '"depois"', updated: new Date(Date.now() + 60_000).toISOString() });
    await sincronizarConexaoGoogle(c2.id);
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).titulo).toBe("Com o produtor (remarcado)");
  });

  it("reconectar religa CADA instância de uma série ao compromisso do mesmo horário (o iCalUID é o mesmo em todas)", async () => {
    const c1 = await conectar(U.ana);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    const instancia = (dias: number) => {
      const ini = new Date(Date.now() + dias * DIA_MS);
      const id = `semanal_${ini.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
      agendaDe("at-ana").set(
        id,
        ev(id, {
          recurringEventId: "semanal",
          iCalUID: "semanal@google.com",
          summary: "Visita semanal",
          organizer: { email: "a@g.com", self: true },
          attendees: [{ email: "p@fazenda.com.br" }],
          start: { dateTime: ini.toISOString() },
          end: { dateTime: new Date(ini.getTime() + 3600_000).toISOString() },
        }),
      );
      return { id, ini };
    };
    const [primeira, segunda] = [instancia(3), instancia(10)];
    await sincronizarConexaoGoogle(c1.id);
    await como(U.ana, () => desconectarGoogle());
    const c2 = await conectar(U.ana);
    await sincronizarConexaoGoogle(c2.id);
    const todos = await basePrisma.appointment.findMany({ where: { teamId: TEAM }, include: { vinculos: true }, orderBy: { inicio: "asc" } });
    expect(todos).toHaveLength(2);
    expect(todos.map((t) => t.inicio.toISOString())).toEqual([primeira.ini.toISOString(), segunda.ini.toISOString()]);
    expect(todos.map((t) => t.vinculos.map((v) => v.externalEventId))).toEqual([[primeira.id], [segunda.id]]);
  });

  it("a cópia de convidado de um evento do CRM Agro com OUTRO id (só o iCalUID `<id>@google.com` denuncia) não volta como compromisso na agenda de um colega", async () => {
    const cAna = await conectar(U.ana);
    const cCaio = await conectar(U.caio);
    await contato(TEAM, "Cliente do Caio", U.caio, "cliente@x.com.br");
    const a = await como(U.ana, () =>
      createAppointment({ titulo: "Da Ana", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }, { userId: U.caio.id }] }),
    );
    const idAna = idDoEventoGoogle(a.id, cAna.id);
    const original = agendaDe("at-ana").get(idAna)!;
    agendaDe("at-caio").set(
      "copiadocaio",
      ev("copiadocaio", {
        summary: "Da Ana",
        iCalUID: original.iCalUID,
        organizer: { email: U.ana.email, self: false },
        attendees: [{ email: "cliente@x.com.br" }, { email: U.caio.email, self: true, responseStatus: "accepted" }],
        start: original.start,
        end: original.end,
      }),
    );
    expect(original.iCalUID).toBe(`${idAna}@google.com`);
    await sincronizarConexaoGoogle(cCaio.id);
    expect(await basePrisma.appointment.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await basePrisma.calendarBusyBlock.count({ where: { connectionId: cCaio.id } })).toBe(0);
  });

  it("evento SEM convidados: com a agenda da Ana fora, o gestor inclui um e-mail; ao reconectar, o Google dela não convida ninguém (o .ics já foi) nem em dobro", async () => {
    const c1 = await conectar(U.ana);
    const a = await como(U.ana, () => createAppointment({ titulo: "Visita", inicio: daquiA(3) }));
    const e1 = idDoEventoGoogle(a.id, c1.id);
    expect(g.inserirEvento.mock.calls[0]![3]).toEqual({ sendUpdates: "none", conferenceDataVersion: 1 });
    await como(U.ana, () => desconectarGoogle());
    await esperar(5);
    // Sem convite anterior pelo Google dela, o gestor pode incluir: o convite sai pelo .ics do time.
    await gestora(() => updateAppointment(a.id, { convidados: [{ email: "cliente@x.com.br" }] }));
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    // Ela reconecta a MESMA conta: o evento é religado; nada de convite do Google, nada de segundo convite.
    const c2 = await conectar(U.ana);
    g.atualizarEvento.mockClear();
    g.inserirEvento.mockClear();
    await sincronizarConexaoGoogle(c2.id);
    await enviarPendentesAoGoogle(agora5());
    await como(U.ana, () => updateAppointment(a.id, { titulo: "Visita (remarcada)" }));
    expect(g.inserirEvento).not.toHaveBeenCalled();
    expect(g.atualizarEvento.mock.calls.length).toBeGreaterThan(0);
    for (const x of g.atualizarEvento.mock.calls) {
      expect(x[4].sendUpdates).toBe("none");
      expect(x[3].attendees).toBeUndefined();
    }
    expect((agendaDe("at-ana").get(e1)!.attendees ?? []).map((x) => x.email)).toEqual([]);
    // O aviso da remarcação segue pelo .ics (mesmo canal), uma vez.
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(2);
  });

  it("nenhum caminho de sistema convida pela conta Google de alguém: a automação cria/edita sem convidados no Google, e só a responsável reabre ou muda o convite", async () => {
    const c = await conectar(U.ana);
    // A automação cria PARA a Ana, com convidados: o evento entra na agenda dela sem convidados e o convite sai pelo .ics.
    const doSistema = await runAsSystem(TEAM, () =>
      createAppointment({ titulo: "Da automação", inicio: daquiA(3), responsavelId: U.ana.id, convidados: [{ email: "cliente@x.com.br" }] }),
    );
    expect(doSistema.responsavelId).toBe(U.ana.id);
    expect(g.inserirEvento).toHaveBeenCalledTimes(1);
    expect(g.inserirEvento.mock.calls[0]![3]).toEqual({ sendUpdates: "none", conferenceDataVersion: 1 });
    expect(g.inserirEvento.mock.calls[0]![2].attendees).toBeUndefined();
    expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
    await enviarPendentesAoGoogle(agora5());
    expect(g.inserirEvento.mock.calls.every((x) => x[3].sendUpdates !== "all") && g.atualizarEvento.mock.calls.every((x) => x[4].sendUpdates !== "all")).toBe(true);

    // Compromisso criado pela automação direto no banco (retorno de caixa postal, campanha): o worker o leva sem convidados.
    const direto = await basePrisma.appointment.create({
      data: { teamId: TEAM, titulo: "Retornar ligação", inicio: new Date(Date.now() + 2 * DIA_MS), responsavelId: U.ana.id, convidados: { create: [{ teamId: TEAM, email: "lead@x.com.br" }] } },
    });
    g.inserirEvento.mockClear();
    await sincronizarConexaoGoogle(c.id); // a 1ª sincronização completa libera o que ficou para trás
    await enviarPendentesAoGoogle(agora5());
    expect(g.inserirEvento).toHaveBeenCalledTimes(1);
    expect(g.inserirEvento.mock.calls[0]![2].id).toBe(idDoEventoGoogle(direto.id, c.id));
    expect(g.inserirEvento.mock.calls[0]![3].sendUpdates).toBe("none");
    expect(g.inserirEvento.mock.calls[0]![2].attendees).toBeUndefined();

    // O que a Ana convidou pelo Google dela: a automação e o master só remarcam ou cancelam.
    const dela = await como(U.ana, () => createAppointment({ titulo: "Proposta", inicio: daquiA(4), convidados: [{ email: "cliente@x.com.br" }] }));
    expect(g.inserirEvento.mock.lastCall![3].sendUpdates).toBe("all");
    g.atualizarEvento.mockClear();
    await esperar(5);
    for (const quem of [(fn: () => Promise<unknown>) => runAsSystem(TEAM, fn), (fn: () => Promise<unknown>) => como(U.dono, fn)]) {
      await expect(quem(() => updateAppointment(dela.id, { titulo: "URGENTE: pague o boleto" }))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
      await expect(quem(() => updateAppointment(dela.id, { convidados: [{ email: "cliente@x.com.br" }, { email: "outro@externo.com" }] }))).rejects.toBeInstanceOf(
        ConviteSoPeloResponsavel,
      );
      // Remarcar com conteúdo novo no MESMO pedido: recusa tudo (o horário novo também não é gravado).
      await expect(quem(() => updateAppointment(dela.id, { titulo: "Golpe", inicio: "2032-08-01T15:00:00.000Z" }))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
    }
    expect(g.atualizarEvento).not.toHaveBeenCalled();
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: dela.id } })).titulo).toBe("Proposta");
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: dela.id } })).inicio.getFullYear()).not.toBe(2032);
    // Cancelar pode; reabrir (o convite sai de novo pela conta dela) não.
    await runAsSystem(TEAM, () => setAppointmentStatus(dela.id, "cancelado"));
    await expect(runAsSystem(TEAM, () => setAppointmentStatus(dela.id, "pendente"))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
    await expect(como(U.dono, () => setAppointmentStatus(dela.id, "pendente"))).rejects.toBeInstanceOf(AlteracaoSoPeloResponsavel);
  });

  it("evento importado com descrição/título/local que a importação CORTOU: remarcar no CRM Agro não reescreve o texto inteiro no Google (só o horário vai)", async () => {
    const c = await conectar(U.ana);
    await contato(TEAM, "Produtor", U.ana, "p@fazenda.com.br");
    const ini = new Date(Date.now() + 3 * DIA_MS);
    const longa = "linha da pauta ".repeat(500); // ~7.500 caracteres
    const evento = ev("longo1", {
      summary: "T".repeat(400),
      description: longa,
      location: "L".repeat(350),
      organizer: { email: "ana@gmail.com", self: true },
      attendees: [{ email: "p@fazenda.com.br" }],
      start: { dateTime: ini.toISOString() },
      end: { dateTime: new Date(ini.getTime() + 3600_000).toISOString() },
    });
    agendaDe("at-ana").set(evento.id, evento);
    await sincronizarConexaoGoogle(c.id);
    const a = await basePrisma.appointment.findFirstOrThrow({ where: { teamId: TEAM, origem: "google" } });
    expect(a.descricao).toHaveLength(5000);
    expect(a.titulo).toHaveLength(300);
    // Remarca (só o horário) — o Google não recebe o texto cortado.
    await como(U.ana, () => updateAppointment(a.id, { inicio: new Date(ini.getTime() + 3600_000).toISOString() }));
    const patch = g.atualizarEvento.mock.lastCall![3];
    expect(patch).not.toHaveProperty("description");
    expect(patch).not.toHaveProperty("summary");
    expect(patch).not.toHaveProperty("location");
    expect(patch.start).toEqual({ dateTime: new Date(ini.getTime() + 3600_000).toISOString(), timeZone: "America/Sao_Paulo" });
    const noGoogle = agendaDe("at-ana").get(evento.id)!;
    expect(noGoogle.description).toBe(longa);
    expect(noGoogle.summary).toHaveLength(400);
    expect(noGoogle.location).toHaveLength(350);
    // Texto curto (não cortado) continua indo e voltando como sempre.
    await como(U.ana, () => updateAppointment(a.id, { descricao: "pauta curta" }));
    expect(g.atualizarEvento.mock.lastCall![3].description).toBe("pauta curta");
  });

  it("log e ultimoErro sem dado de cliente: erro de banco sai só com nome e código; o do Google mantém status e motivo", async () => {
    const { erroSeguro } = await import("./envio");
    const doBanco = Object.assign(new Error('Invalid `prisma.appointment.create()` invocation: { data: { titulo: "Consulta de ansiedade", descricao: "Retorno" } }'), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    expect(erroSeguro(doBanco)).toBe("PrismaClientKnownRequestError (P2002)");
    expect(erroSeguro(doBanco)).not.toContain("ansiedade");
    expect(erroSeguro(new GoogleApiErro(403, "rateLimitExceeded"))).toBe("GoogleApiErro: HTTP 403 (rateLimitExceeded)");
    expect(erroSeguro("texto solto com título")).toBe("erro");
  });
});

// ---------------------------------------------------------------------------
// Liberação até o Google verificar o app (A2): GOOGLE_AGENDA_LIBERADOS
// ---------------------------------------------------------------------------

describe("liberação até a verificação (A2)", () => {
  // O `env` é um objeto mutável: cada teste que fecha a lista volta para "todos".
  afterEach(() => {
    env.GOOGLE_AGENDA_LIBERADOS = "todos";
  });
  const liberar = (valor: string | undefined) => {
    env.GOOGLE_AGENDA_LIBERADOS = valor;
  };
  const semNinguem = { todos: false, emails: new Set<string>(), times: new Set<string>() };

  describe("lerLiberados (o texto do .env)", () => {
    it("ausente, vazio ou só espaços = ninguém (fail-closed)", () => {
      expect(lerLiberados(undefined)).toEqual(semNinguem);
      expect(lerLiberados(null)).toEqual(semNinguem);
      expect(lerLiberados("")).toEqual(semNinguem);
      expect(lerLiberados("   \t \n ")).toEqual(semNinguem);
      expect(lerLiberados(" , ;; , ")).toEqual(semNinguem);
    });

    it("vírgula, ponto e vírgula e espaço separam; maiúsculas e espaços sobrando são normalizados", () => {
      const l = lerLiberados(` Ana@X.com ; ${TEAM.toUpperCase()} , todos`);
      expect(l.todos).toBe(true);
      expect([...l.emails]).toEqual(["ana@x.com"]);
      expect([...l.times]).toEqual([TEAM]);

      const varios = lerLiberados(`  A@x.com,B@X.COM;c@x.com   d@x.com \n e@x.com\t${OUTRO}`);
      expect(varios.todos).toBe(false);
      expect([...varios.emails].sort()).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
      expect([...varios.times]).toEqual([OUTRO]);
    });

    it("`todos` (em qualquer caixa) libera geral; sem ele, e-mail e id de time NÃO liberam geral", () => {
      expect(lerLiberados("TODOS").todos).toBe(true);
      expect(lerLiberados("*").todos).toBe(true);
      expect(lerLiberados("ana@x.com").todos).toBe(false);
      expect(lerLiberados(TEAM).todos).toBe(false);
      // "todos" dentro de um e-mail ou id não conta como o valor especial.
      expect(lerLiberados("todos@x.com").todos).toBe(false);
    });
  });

  describe("variável ausente ou vazia: ninguém conecta", () => {
    it.each([undefined, "", "   "])("GOOGLE_AGENDA_LIBERADOS=%j: iniciar a conexão é recusado, até para o dono do time", async (valor) => {
      liberar(valor);
      for (const p of [U.ana, U.dono, U.outro]) {
        await expect(como(p, () => iniciarConexaoGoogle())).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
        expect(await como(p, () => agendaGoogleLiberadaParaMim())).toBe(false);
      }
      expect(g.trocarCodigo).not.toHaveBeenCalled();
    });

    it("a volta do Google também é recusada (state válido de antes da troca da lista) e nada é gravado nem trocado", async () => {
      const r = await como(U.ana, () => iniciarConexaoGoogle()); // com "todos"
      liberar("");
      g.trocarCodigo.mockResolvedValue({
        accessToken: "a",
        refreshToken: "b",
        expiraEm: new Date(Date.now() + 3600_000),
        escopos: [ESCOPO_AGENDA],
        idToken: idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: `sub-a2-${sufixo}`, email: "ana@gmail.com" }),
      });
      await expect(
        como(U.ana, () => concluirConexaoGoogle({ code: "c", state: new URL(r.url).searchParams.get("state")!, nonce: r.nonce, verificador: r.verificador })),
      ).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
      expect(g.trocarCodigo).not.toHaveBeenCalled();
      expect(await basePrisma.oAuthConnection.count({ where: { userId: U.ana.id } })).toBe(0);
    });

    it("o contexto de sistema (sem pessoa) nunca está liberado, nem com `todos`", async () => {
      expect(await runAsSystem(TEAM, () => agendaGoogleLiberadaParaMim())).toBe(false);
      liberar("");
      expect(await runAsSystem(TEAM, () => agendaGoogleLiberadaParaMim())).toBe(false);
      // Sem identidade nenhuma no contexto: idem.
      expect(await runWithTeam(TEAM, () => agendaGoogleLiberadaParaMim())).toBe(false);
    });
  });

  describe("duas pessoas no mesmo time: só quem está na lista", () => {
    it("liberada por e-mail: a Ana recebe a URL do Google e a colega (Bia) não; o e-mail vale em qualquer caixa", async () => {
      liberar(U.ana.email.toUpperCase());
      const r = await como(U.ana, () => iniciarConexaoGoogle());
      expect(new URL(r.url).origin).toBe("https://accounts.google.com");
      await expect(como(U.bia, () => iniciarConexaoGoogle())).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
      await expect(como(U.chefe, () => iniciarConexaoGoogle())).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
      expect(await como(U.ana, () => agendaGoogleLiberadaParaMim())).toBe(true);
      expect(await como(U.bia, () => agendaGoogleLiberadaParaMim())).toBe(false);
    });

    it("a colega recusada também não conclui a volta com um state dela, e 'Sincronizar agora' é recusado", async () => {
      // O state assinado para a Bia (como o de uma volta que já estava em andamento).
      const nonce = "nonce-a2";
      const state = assinarEstado({ u: U.bia.id, t: TEAM, n: nonce, e: Date.now() + 60_000, v: "integracoes" });
      await conectar(U.bia);
      liberar(U.ana.email);
      await expect(como(U.bia, () => concluirConexaoGoogle({ code: "c", state, nonce, verificador: "v" }))).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
      expect(g.trocarCodigo).not.toHaveBeenCalled();
      await expect(como(U.bia, () => pedirSincronizacaoGoogle())).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
      expect(fila.enfileirarSyncGoogle).not.toHaveBeenCalled();
    });
  });

  describe("dois times: só o time liberado por id", () => {
    it("com o id do time A: a Ana e a Bia conectam; quem é do time B (outro) não", async () => {
      liberar(TEAM);
      await expect(como(U.ana, () => iniciarConexaoGoogle())).resolves.toBeTruthy();
      await expect(como(U.bia, () => iniciarConexaoGoogle())).resolves.toBeTruthy();
      await expect(como(U.outro, () => iniciarConexaoGoogle())).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
      expect(await como(U.outro, () => agendaGoogleLiberadaParaMim())).toBe(false);
    });

    it("com o id do time B: o inverso; e e-mail de uma pessoa do time A não abre o time inteiro", async () => {
      liberar(`${OUTRO}, ${U.ana.email}`);
      await expect(como(U.outro, () => iniciarConexaoGoogle())).resolves.toBeTruthy();
      await expect(como(U.ana, () => iniciarConexaoGoogle())).resolves.toBeTruthy();
      await expect(como(U.bia, () => iniciarConexaoGoogle())).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
    });

    it("`todos` libera os dois times", async () => {
      liberar("todos");
      await expect(como(U.ana, () => iniciarConexaoGoogle())).resolves.toBeTruthy();
      await expect(como(U.outro, () => iniciarConexaoGoogle())).resolves.toBeTruthy();
    });
  });

  describe("worker: quem saiu da lista fica parado, sem apagar nada", () => {
    it("sincronização e manutenção pulam a conexão; nada é lido no Google nem apagado; voltando à lista, sincroniza", async () => {
      const c = await conectar(U.ana);
      liberar("");
      expect(await sincronizarConexaoGoogle(c.id)).toEqual({ ok: false, pulou: "nao_liberada" });
      expect(g.listarEventos).not.toHaveBeenCalled();
      await manutencaoAgendaGoogle(new Date(Date.now() + 60_000));
      expect(fila.enfileirarSyncGoogle).not.toHaveBeenCalledWith(c.id);
      // Nada foi apagado: a conexão e o estado da agenda continuam lá.
      expect(await basePrisma.oAuthConnection.findUniqueOrThrow({ where: { id: c.id }, select: { status: true } })).toEqual({ status: "connected" });
      expect(await basePrisma.calendarSync.count({ where: { connectionId: c.id } })).toBe(1);

      // Só a Bia liberada: a agenda da Ana continua parada (a lista é por pessoa).
      liberar(U.bia.email);
      expect(await sincronizarConexaoGoogle(c.id)).toEqual({ ok: false, pulou: "nao_liberada" });

      // A Ana volta à lista (por e-mail): a manutenção a enfileira e a rodada sincroniza.
      liberar(U.ana.email);
      await manutencaoAgendaGoogle(new Date(Date.now() + 60_000));
      expect(fila.enfileirarSyncGoogle).toHaveBeenCalledWith(c.id);
      expect(await sincronizarConexaoGoogle(c.id)).toMatchObject({ ok: true });
      expect(g.listarEventos).toHaveBeenCalled();
    });

    it("liberar o time inteiro pelo id vale para as conexões dele; o outro time segue parado", async () => {
      const ana = await conectar(U.ana);
      const outro = await conectar(U.outro);
      liberar(TEAM);
      expect(await sincronizarConexaoGoogle(outro.id)).toEqual({ ok: false, pulou: "nao_liberada" });
      expect(await sincronizarConexaoGoogle(ana.id)).toMatchObject({ ok: true });
    });

    it("quem saiu da lista ainda desconecta (revoga no Google e apaga), mas não sincroniza", async () => {
      await conectar(U.ana);
      liberar("");
      expect(await como(U.ana, () => desconectarGoogle())).toEqual({ desconectada: true });
      expect(g.revogarToken).toHaveBeenCalledWith("rt-ana");
      expect(await basePrisma.oAuthConnection.count({ where: { userId: U.ana.id } })).toBe(0);
    });
  });

  describe("CRM Agro → Google: nenhum evento é criado nem alterado com o token de quem não está liberado", () => {
    it("sem liberação o compromisso é salvo e o convite sai pelo .ics; com a Ana na lista, vai para a agenda dela", async () => {
      await conectar(U.ana);
      liberar("");
      const a = await como(U.ana, () => createAppointment({ titulo: "Visita", inicio: "2032-06-10T13:00:00.000Z", convidados: [{ email: "cliente@x.com.br" }] }));
      expect(a.google).toBeNull();
      expect(g.inserirEvento).not.toHaveBeenCalled();
      expect(email.sendCalendarInvite).toHaveBeenCalledTimes(1);
      expect(await basePrisma.appointmentLink.count({ where: { appointmentId: a.id } })).toBe(0);

      liberar(U.ana.email);
      const b = await como(U.ana, () => createAppointment({ titulo: "Visita 2", inicio: "2032-06-11T13:00:00.000Z" }));
      expect(g.inserirEvento).toHaveBeenCalledTimes(1);
      expect(b.google).toBe("sincronizado");
    });

    it("compromisso já no Google: a edição de quem saiu da lista fica pendente (sem PATCH) e o worker a leva quando ela volta", async () => {
      await conectar(U.ana);
      const a = await como(U.ana, () => createAppointment({ titulo: "Reunião", inicio: "2032-06-10T13:00:00.000Z" }));
      expect(g.inserirEvento).toHaveBeenCalledTimes(1);

      liberar("");
      await como(U.ana, () => updateAppointment(a.id, { titulo: "Reunião remarcada" }));
      expect(g.atualizarEvento).not.toHaveBeenCalled();
      expect(await basePrisma.appointmentLink.findFirstOrThrow({ where: { appointmentId: a.id }, select: { pendenteDesde: true } })).toMatchObject({
        pendenteDesde: expect.any(Date),
      });
      // O worker também não a leva enquanto ela está fora da lista.
      await enviarPendentesAoGoogle(new Date(Date.now() + 5 * 60_000));
      expect(g.atualizarEvento).not.toHaveBeenCalled();

      // Voltou para a lista: a mudança que ficou guardada vai para o Google.
      liberar("todos");
      await enviarPendentesAoGoogle(new Date(Date.now() + 5 * 60_000));
      expect(g.atualizarEvento).toHaveBeenCalledTimes(1);
      expect(g.atualizarEvento.mock.calls[0]![3]).toMatchObject({ summary: "Reunião remarcada" });
    });
  });
});
