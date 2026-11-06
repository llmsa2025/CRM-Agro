import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { env } from "@crmagro/config";
import { basePrisma, runWithTeam, runAsSystem, encryptCredentials, decryptCredentials, estaCifrado } from "@crmagro/db";

/**
 * Envio pelo Gmail (E7a): conexão incremental (`gmail.send` em cima da Agenda), a caixa
 * `gmail_api`, o envio pelo core e o ciclo de vida da conexão. O Google é SIMULADO: o
 * módulo `cliente` (único que fala com ele) é trocado, e o `fetch` só existe para o
 * endpoint de envio do Gmail. Nada sai para a rede. `vi.mock` isolado neste arquivo (nada
 * de spyOn no basePrisma). Os mocks do redis-bus e do `aguardando` evitam escrita no Redis
 * de TESTE (que hoje é o da Evolution de produção).
 */
const g = vi.hoisted(() => ({
  trocarCodigo: vi.fn(),
  renovarAccessToken: vi.fn(),
  revogarToken: vi.fn(),
  pararCanal: vi.fn(),
}));
vi.mock("../agenda/google/cliente", async (importOriginal) => ({ ...(await importOriginal<typeof import("../agenda/google/cliente")>()), ...g }));
const fila = vi.hoisted(() => ({ enfileirarSyncGoogle: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("../agenda/google/fila", async (importOriginal) => ({ ...(await importOriginal<typeof import("../agenda/google/fila")>()), ...fila }));
const wp = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })) }));
vi.mock("web-push", () => ({ default: wp, ...wp }));
vi.mock("../events/redis-bus", () => ({ publishRealtime: vi.fn() }));
vi.mock("../flows/aguardando", () => ({ acordarQuemEsperaResposta: vi.fn(async () => 0) }));

const { ESCOPO_AGENDA, ESCOPO_GMAIL_ENVIO, GoogleAutorizacaoInvalida } = await import("../agenda/google/cliente");
const {
  iniciarConexaoGoogle,
  concluirConexaoGoogle,
  desconectarGoogle,
  envioPeloGmailParaMim,
  AgendaGoogleNecessaria,
  AgendaGoogleNaoLiberada,
  PermissaoDoGmailNegada,
  GmailEmOutraConta,
  EnvioPeloGmailDesligado,
} = await import("../agenda/google/conexao");
const { CaixaJaConectadaComSenha } = await import("../agenda/google/gmail-envio");
const {
  sendEmail,
  sendTransactionalEmail,
  listEmailAccounts,
  getEmailAccountConfig,
  connectEmailAccount,
  desligarEnvioPeloGmail,
  CaixaJaConectadaPeloGmail,
} = await import("./service");
const { pollAllEmailInboxes } = await import("./leitura-imap");
const { desativarIntegrante, excluirIntegrante } = await import("../auth/equipe");
const { ForbiddenError } = await import("../auth/authz");
const { OwnedNotFound } = await import("../tenancy/assert-owned");
const { isChannelSendFailed, isGmailSemAutorizacao, transporteSmtpPara } = await import("@crmagro/channels");

const TEAM_A = "00000000-0000-0000-0000-0000000e7a01";
const TEAM_B = "00000000-0000-0000-0000-0000000e7a02";
const sufixo = Math.random().toString(36).slice(2, 8);
const CLIENT_ID = "cliente-teste.apps.googleusercontent.com";
const URL_ENVIO = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";

type Pessoa = { id: string; teamId: string; role: string; nome: string; email: string };
const pessoa = (nome: string, teamId: string, role: string): Pessoa => ({ id: randomUUID(), teamId, role, nome, email: `${nome}-${sufixo}@teste.crmagro` });
const U = {
  dono: pessoa("dono", TEAM_A, "owner"),
  adm: pessoa("adm", TEAM_A, "admin"),
  ana: pessoa("ana", TEAM_A, "member"),
  bia: pessoa("bia", TEAM_A, "member"),
  caio: pessoa("caio", TEAM_A, "member"),
  davi: pessoa("davi", TEAM_A, "member"),
  carla: pessoa("carla", TEAM_B, "member"),
};
const como = <T>(p: Pessoa, fn: () => Promise<T>) => runWithTeam(p.teamId, fn, { userId: p.id, role: p.role });
/** Conta Google da pessoa (o `sub` e o e-mail que o Google devolve). */
const sub = (p: Pessoa) => `sub-${p.nome}-${sufixo}`;
const gmail = (p: Pessoa) => `${p.nome}-${sufixo}@gmail.com`;

const envOriginal = {
  GOOGLE_INTEGRACOES_CLIENT_ID: env.GOOGLE_INTEGRACOES_CLIENT_ID,
  GOOGLE_INTEGRACOES_CLIENT_SECRET: env.GOOGLE_INTEGRACOES_CLIENT_SECRET,
  GOOGLE_INTEGRACOES_REDIRECT_URI: env.GOOGLE_INTEGRACOES_REDIRECT_URI,
  GOOGLE_AGENDA_PUSH: env.GOOGLE_AGENDA_PUSH,
  GOOGLE_AGENDA_LIBERADOS: env.GOOGLE_AGENDA_LIBERADOS,
  GOOGLE_GMAIL_ENVIO: env.GOOGLE_GMAIL_ENVIO,
  AUTH_URL: env.AUTH_URL,
};

// ---------------------------------------------------------------------------
// Apoio
// ---------------------------------------------------------------------------

function instalarGoogleFalso() {
  for (const f of Object.values(g)) f.mockReset();
  // Renovação: o token novo é reconhecível no `Bearer` do envio.
  g.renovarAccessToken.mockImplementation(async ({ refreshToken }: { refreshToken: string }) => ({
    accessToken: `at-renovado-${refreshToken.slice(3)}`,
    expiraEm: new Date(Date.now() + 3600_000),
    escopos: [ESCOPO_AGENDA, ESCOPO_GMAIL_ENVIO],
  }));
  g.revogarToken.mockImplementation(async () => {});
  g.pararCanal.mockImplementation(async () => {});
}

function idToken(payload: Record<string, unknown>) {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(payload)}.assinatura`;
}

/** A conexão da Agenda da pessoa, direto no banco (tokens cifrados como o fluxo real). */
async function conectarAgenda(p: Pessoa, extra: { comEnvio?: boolean; expirado?: boolean; status?: "connected" | "reauth_required" } = {}) {
  return basePrisma.oAuthConnection.create({
    data: {
      teamId: p.teamId,
      userId: p.id,
      provider: "google",
      externalAccountId: sub(p),
      email: gmail(p),
      scopes: ["openid", "email", ESCOPO_AGENDA, ...(extra.comEnvio ? [ESCOPO_GMAIL_ENVIO] : [])],
      credentials: encryptCredentials({ refreshToken: `rt-${p.nome}`, accessToken: `at-${p.nome}` }) as object,
      accessTokenExpiraEm: extra.expirado ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3600_000),
      status: extra.status ?? "connected",
      calendarios: { create: { teamId: p.teamId, calendarId: "primary" } },
    },
    select: { id: true },
  });
}

/** A caixa `gmail_api` da pessoa, direto no banco (para os testes que não passam pelo OAuth). */
async function criarCaixaGmail(p: Pessoa, conexaoId: string, status: "connected" | "disconnected" | "error" = "connected") {
  return basePrisma.channelAccount.create({
    data: {
      teamId: p.teamId,
      canal: "email",
      provider: "gmail_api",
      externalId: `gmail:${sub(p)}`,
      ownerId: p.id,
      label: gmail(p),
      status,
      credentials: encryptCredentials({ oauthConnectionId: conexaoId, user: gmail(p), from: gmail(p) }) as object,
    },
    select: { id: true },
  });
}

/** Caixa com senha (SMTP) do mesmo endereço do Gmail da pessoa. */
async function criarCaixaSmtp(p: Pessoa, endereco = gmail(p), provider = "smtp") {
  return basePrisma.channelAccount.create({
    data: {
      teamId: p.teamId,
      canal: "email",
      provider,
      ownerId: p.id,
      label: "Caixa com senha",
      status: "connected",
      credentials: encryptCredentials({ host: "smtp.teste.invalid", port: 587, secure: false, user: endereco, pass: "senha-de-app", from: endereco }) as object,
    },
    select: { id: true },
  });
}

async function contato(p: Pessoa, nome: string, email: string) {
  return basePrisma.contact.create({
    data: { teamId: p.teamId, nome, ownerId: p.id, identifiers: { create: { teamId: p.teamId, canal: "email", valor: email, isPrimary: true } } },
  });
}

type VoltaOpts = { recurso: "agenda" | "gmail"; escopos?: string[]; sub?: string; email?: string; volta?: "agenda" | "integracoes" | "canais" };

/** Ida e volta do OAuth: iniciar, tirar o `state`, simular o Google e concluir. */
async function oauth(p: Pessoa, o: VoltaOpts) {
  const ida = await como(p, () => iniciarConexaoGoogle({ recurso: o.recurso, ...(o.volta ? { volta: o.volta } : {}) }));
  const state = new URL(ida.url).searchParams.get("state")!;
  g.trocarCodigo.mockResolvedValueOnce({
    accessToken: `at-oauth-${p.nome}`,
    refreshToken: `rt-${p.nome}`,
    expiraEm: new Date(Date.now() + 3600_000),
    escopos: o.escopos ?? ["openid", "email", ESCOPO_AGENDA, ...(o.recurso === "gmail" ? [ESCOPO_GMAIL_ENVIO] : [])],
    idToken: idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: o.sub ?? sub(p), email: o.email ?? gmail(p), exp: Math.floor(Date.now() / 1000) + 3600 }),
  });
  return como(p, () => concluirConexaoGoogle({ code: "codigo-ok", state, nonce: ida.nonce, verificador: ida.verificador }));
}

/** Só o `state` (para os testes que mexem no ambiente entre a ida e a volta). */
async function idaComState(p: Pessoa, recurso: "agenda" | "gmail") {
  const ida = await como(p, () => iniciarConexaoGoogle({ recurso }));
  return { ida, state: new URL(ida.url).searchParams.get("state")! };
}

const caixasGmail = (teamId: string) => basePrisma.channelAccount.findMany({ where: { teamId, provider: "gmail_api" } });

/** `fetch` simulado só para o endpoint de envio: registra o pedido e devolve 200. */
function fingirEnvioDoGmail(resposta: () => Response = () => new Response(JSON.stringify({ id: "18c1", threadId: "18c1" }), { status: 200 })) {
  const chamadas: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      chamadas.push({ url: String(url), init });
      return resposta();
    }),
  );
  return chamadas;
}
const mimeDe = (c: { init: RequestInit }) => Buffer.from(c.init.body as Uint8Array).toString("utf8");
const cabecalho = (mime: string, nome: string) => new RegExp(`^${nome}:[ \\t]*(.*)`, "im").exec(mime)?.[1]?.trim() ?? null;
const bearer = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).authorization;

async function limpar() {
  for (const teamId of [TEAM_A, TEAM_B]) {
    await basePrisma.oAuthRevogacaoPendente.deleteMany({ where: { teamId } });
    await basePrisma.message.deleteMany({ where: { teamId } });
    await basePrisma.activity.deleteMany({ where: { teamId } });
    await basePrisma.conversation.deleteMany({ where: { teamId } });
    await basePrisma.calendarSync.deleteMany({ where: { teamId } });
    await basePrisma.oAuthConnection.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
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
    GOOGLE_AGENDA_LIBERADOS: "todos",
    GOOGLE_GMAIL_ENVIO: "on",
    AUTH_URL: "https://app.teste.crmagro",
  });
  await basePrisma.team.upsert({ where: { id: TEAM_A }, update: {}, create: { id: TEAM_A, name: "Team Gmail Envio A (test)" } });
  await basePrisma.team.upsert({ where: { id: TEAM_B }, update: {}, create: { id: TEAM_B, name: "Team Gmail Envio B (test)" } });
  await limpar();
  for (const p of Object.values(U)) {
    await basePrisma.user.create({ data: { id: p.id, teamId: p.teamId, role: p.role, name: p.nome, email: p.email } });
  }
});
beforeEach(async () => {
  await limpar();
  instalarGoogleFalso();
  fila.enfileirarSyncGoogle.mockClear();
  env.GOOGLE_GMAIL_ENVIO = "on";
  env.GOOGLE_AGENDA_LIBERADOS = "todos";
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  Object.assign(env, envOriginal);
  await limpar();
  await basePrisma.user.deleteMany({ where: { id: { in: Object.values(U).map((p) => p.id) } } });
});

// ---------------------------------------------------------------------------
// Começar a conexão
// ---------------------------------------------------------------------------

describe("iniciar a conexão do envio pelo Gmail", () => {
  it("1. sem a Agenda conectada não começa; com a Agenda, pede só o gmail.send, sem select_account e com o e-mail da conta Google", async () => {
    await expect(como(U.ana, () => iniciarConexaoGoogle({ recurso: "gmail", volta: "canais" }))).rejects.toBeInstanceOf(AgendaGoogleNecessaria);
    // Agenda que precisa reconectar também não vale: o envio é um passo em cima de uma Agenda que funciona.
    const c = await conectarAgenda(U.ana, { status: "reauth_required" });
    await expect(como(U.ana, () => iniciarConexaoGoogle({ recurso: "gmail", volta: "canais" }))).rejects.toBeInstanceOf(AgendaGoogleNecessaria);
    await basePrisma.oAuthConnection.delete({ where: { id: c.id } });

    await conectarAgenda(U.ana);
    const r = await como(U.ana, () => iniciarConexaoGoogle({ recurso: "gmail", volta: "canais" }));
    const q = new URL(r.url).searchParams;
    expect(q.get("scope")!.split(" ")).toEqual(["openid", "email", ESCOPO_GMAIL_ENVIO]);
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    // A conta é a da conexão (a do Google), não o e-mail de login do CRM Agro.
    expect(q.get("login_hint")).toBe(gmail(U.ana));
    const dados = JSON.parse(Buffer.from(q.get("state")!.split(".")[0]!, "base64url").toString());
    expect(dados).toMatchObject({ r: "gmail", v: "canais", u: U.ana.id, t: TEAM_A });

    // A Agenda (sem `recurso`) segue como sempre: escolhe a conta, sem `r` no state.
    const agenda = await como(U.ana, () => iniciarConexaoGoogle());
    const qa = new URL(agenda.url).searchParams;
    expect(qa.get("prompt")).toBe("consent select_account");
    expect(qa.get("scope")!.split(" ")).toEqual(["openid", "email", ESCOPO_AGENDA]);
    expect(qa.get("login_hint")).toBe(U.ana.email);
    const dadosAgenda = JSON.parse(Buffer.from(qa.get("state")!.split(".")[0]!, "base64url").toString());
    expect(dadosAgenda.r).toBeUndefined();
  });

  it("2. sem a chave GOOGLE_GMAIL_ENVIO nada começa nem termina; a lista de liberados também vale", async () => {
    await conectarAgenda(U.ana);
    const { ida, state } = await idaComState(U.ana, "gmail");

    env.GOOGLE_GMAIL_ENVIO = undefined;
    await expect(como(U.ana, () => iniciarConexaoGoogle({ recurso: "gmail" }))).rejects.toBeInstanceOf(EnvioPeloGmailDesligado);
    await expect(como(U.ana, () => concluirConexaoGoogle({ code: "c", state, nonce: ida.nonce, verificador: ida.verificador }))).rejects.toBeInstanceOf(EnvioPeloGmailDesligado);
    expect(g.trocarCodigo).not.toHaveBeenCalled();
    env.GOOGLE_GMAIL_ENVIO = "off";
    await expect(como(U.ana, () => iniciarConexaoGoogle({ recurso: "gmail" }))).rejects.toBeInstanceOf(EnvioPeloGmailDesligado);

    env.GOOGLE_GMAIL_ENVIO = "on";
    env.GOOGLE_AGENDA_LIBERADOS = "";
    await expect(como(U.ana, () => iniciarConexaoGoogle({ recurso: "gmail" }))).rejects.toBeInstanceOf(AgendaGoogleNaoLiberada);
    // Só leitura não conecta.
    env.GOOGLE_AGENDA_LIBERADOS = "todos";
    await expect(como({ ...U.ana, role: "viewer" }, () => iniciarConexaoGoogle({ recurso: "gmail" }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Voltar do Google
// ---------------------------------------------------------------------------

describe("voltar do Google com r=gmail", () => {
  it("3. grava o gmail.send na conexão e cria a caixa gmail_api da pessoa, sem token nas credenciais", async () => {
    await conectarAgenda(U.ana);
    const fim = await oauth(U.ana, { recurso: "gmail", volta: "canais" });
    expect(fim).toEqual({ volta: "canais", email: gmail(U.ana), recurso: "gmail" });

    const conexao = await basePrisma.oAuthConnection.findFirstOrThrow({ where: { userId: U.ana.id } });
    expect(conexao.scopes).toEqual(expect.arrayContaining([ESCOPO_AGENDA, ESCOPO_GMAIL_ENVIO]));
    const caixas = await caixasGmail(TEAM_A);
    expect(caixas).toHaveLength(1);
    const caixa = caixas[0]!;
    expect(caixa).toMatchObject({ canal: "email", provider: "gmail_api", externalId: `gmail:${sub(U.ana)}`, ownerId: U.ana.id, status: "connected", label: gmail(U.ana) });
    expect(estaCifrado(caixa.credentials)).toBe(true);
    const cred = decryptCredentials(caixa.credentials);
    expect(cred).toEqual({ oauthConnectionId: conexao.id, user: gmail(U.ana), from: gmail(U.ana) });
    // Nenhum token (nem o de acesso nem o de renovação) na caixa.
    expect(JSON.stringify(caixa)).not.toMatch(/at-ana|rt-ana|at-oauth|refreshToken|accessToken/);
    expect(JSON.stringify(cred)).not.toMatch(/at-ana|rt-ana|at-oauth|refreshToken|accessToken/);
    expect(fila.enfileirarSyncGoogle).toHaveBeenCalledWith(conexao.id);
  });

  it("4. sem o gmail.send concedido: PermissaoDoGmailNegada e nenhuma caixa", async () => {
    await conectarAgenda(U.ana);
    await expect(oauth(U.ana, { recurso: "gmail", escopos: ["openid", "email", ESCOPO_AGENDA] })).rejects.toBeInstanceOf(PermissaoDoGmailNegada);
    expect(await caixasGmail(TEAM_A)).toHaveLength(0);
    const conexao = await basePrisma.oAuthConnection.findFirstOrThrow({ where: { userId: U.ana.id } });
    expect(conexao.scopes).not.toContain(ESCOPO_GMAIL_ENVIO);
  });

  it("5. a Ana já tem caixa com senha do mesmo endereço: CaixaJaConectadaComSenha e nada muda", async () => {
    const antes = await conectarAgenda(U.ana);
    await criarCaixaSmtp(U.ana, gmail(U.ana).toUpperCase());
    await expect(oauth(U.ana, { recurso: "gmail" })).rejects.toBeInstanceOf(CaixaJaConectadaComSenha);
    expect(await caixasGmail(TEAM_A)).toHaveLength(0);
    const depois = await basePrisma.oAuthConnection.findFirstOrThrow({ where: { userId: U.ana.id } });
    expect(depois.id).toBe(antes.id);
    expect(depois.scopes).toEqual(["openid", "email", ESCOPO_AGENDA]);
    // O endereço "gmail" (SMTP com senha de app) também conta como caixa com senha.
    await basePrisma.channelAccount.deleteMany({ where: { teamId: TEAM_A } });
    await criarCaixaSmtp(U.ana, gmail(U.ana), "gmail");
    await expect(oauth(U.ana, { recurso: "gmail" })).rejects.toBeInstanceOf(CaixaJaConectadaComSenha);
  });

  it("6. voltar com OUTRA conta Google: GmailEmOutraConta e a Agenda continua a mesma", async () => {
    const antes = await conectarAgenda(U.ana);
    await expect(oauth(U.ana, { recurso: "gmail", sub: `outra-conta-${sufixo}`, email: "ana.outra@gmail.com" })).rejects.toBeInstanceOf(GmailEmOutraConta);
    const conexoes = await basePrisma.oAuthConnection.findMany({ where: { userId: U.ana.id } });
    expect(conexoes).toHaveLength(1);
    expect(conexoes[0]).toMatchObject({ id: antes.id, externalAccountId: sub(U.ana), status: "connected" });
    expect(await caixasGmail(TEAM_A)).toHaveLength(0);
    expect(g.revogarToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Enviar
// ---------------------------------------------------------------------------

describe("enviar pela caixa gmail_api", () => {
  it("7. usa o token RENOVADO da conexão, grava Message e Activity como no SMTP e devolve o Message-ID do MIME", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true, expirado: true });
    const caixa = await criarCaixaGmail(U.ana, c.id);
    const ct = await contato(U.ana, "Lead", "lead@empresa.com.br");
    const chamadas = fingirEnvioDoGmail();

    const r = await como(U.ana, () => sendEmail(ct.id, { subject: "Proposta", body: "Olá, tudo bem?", channelAccountId: caixa.id }));

    expect(g.renovarAccessToken).toHaveBeenCalledTimes(1);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe(URL_ENVIO);
    expect(bearer(chamadas[0]!)).toBe("Bearer at-renovado-ana");
    const mime = mimeDe(chamadas[0]!);
    expect(cabecalho(mime, "To")).toBe("lead@empresa.com.br");
    expect(cabecalho(mime, "Subject")).toBe("Proposta");
    // O remetente leva o nome da caixa (o e-mail, como label) e o endereço da conta Google.
    expect(cabecalho(mime, "From")).toContain(gmail(U.ana));
    expect(r.providerMessageId).toBe(cabecalho(mime, "Message-ID"));

    const msg = await basePrisma.message.findFirstOrThrow({ where: { id: r.messageId } });
    expect(msg).toMatchObject({ direcao: "out", status: "sent", providerMessageId: r.providerMessageId });
    const conv = await basePrisma.conversation.findFirstOrThrow({ where: { id: msg.conversationId } });
    expect(conv).toMatchObject({ canal: "email", channelAccountId: caixa.id, contactId: ct.id });
    const act = await basePrisma.activity.findFirstOrThrow({ where: { contactId: ct.id, tipo: "email" } });
    expect(act).toMatchObject({ direcao: "out" });
    expect(act.meta).toMatchObject({ channelAccountId: caixa.id, providerMessageId: r.providerMessageId });
    // O token renovado ficou guardado (cifrado) na conexão, não na caixa.
    const depois = await basePrisma.oAuthConnection.findFirstOrThrow({ where: { id: c.id } });
    expect(JSON.stringify(depois.credentials)).not.toContain("at-renovado");
    expect(decryptCredentials(depois.credentials)).toMatchObject({ refreshToken: "rt-ana", accessToken: "at-renovado-ana" });
  });

  it("sem escolher a caixa, a prospecção da Ana usa a gmail_api dela", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true });
    await criarCaixaGmail(U.ana, c.id);
    const ct = await contato(U.ana, "Lead", "lead@empresa.com.br");
    const chamadas = fingirEnvioDoGmail();
    await como(U.ana, () => sendEmail(ct.id, { subject: "Oi", body: "Olá" }));
    expect(chamadas).toHaveLength(1);
    expect(bearer(chamadas[0]!)).toBe("Bearer at-ana");
  });

  it("8. invalid_grant na renovação: GmailSemAutorizacao (não saiu, não repete), conexão em reauth_required e a caixa em erro", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true, expirado: true });
    const caixa = await criarCaixaGmail(U.ana, c.id);
    const ct = await contato(U.ana, "Lead", "lead@empresa.com.br");
    const chamadas = fingirEnvioDoGmail();
    g.renovarAccessToken.mockRejectedValue(new GoogleAutorizacaoInvalida("invalid_grant"));

    const e = await como(U.ana, () => sendEmail(ct.id, { subject: "Oi", body: "Olá", channelAccountId: caixa.id })).catch((x) => x);
    expect(isChannelSendFailed(e)).toBe(true);
    expect(isGmailSemAutorizacao(e)).toBe(true);
    expect(e).toMatchObject({ outcome: "not_sent", retryable: false });
    expect(chamadas).toHaveLength(0);
    expect((await basePrisma.oAuthConnection.findFirstOrThrow({ where: { id: c.id } })).status).toBe("reauth_required");
    expect((await basePrisma.channelAccount.findFirstOrThrow({ where: { id: caixa.id } })).status).toBe("error");
    // Sem mensagem "falhou" no histórico: a falha veio ANTES de existir o envio.
    expect(await basePrisma.message.count({ where: { teamId: TEAM_A } })).toBe(0);
  });

  it("conexão que sumiu: a caixa vira disconnected e o envio falha sem repetir", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true });
    const caixa = await criarCaixaGmail(U.ana, c.id);
    await basePrisma.oAuthConnection.delete({ where: { id: c.id } });
    const ct = await contato(U.ana, "Lead", "lead@empresa.com.br");
    const chamadas = fingirEnvioDoGmail();
    const e = await como(U.ana, () => sendEmail(ct.id, { subject: "Oi", body: "Olá", channelAccountId: caixa.id })).catch((x) => x);
    expect(isGmailSemAutorizacao(e)).toBe(true);
    expect(chamadas).toHaveLength(0);
    expect((await basePrisma.channelAccount.findFirstOrThrow({ where: { id: caixa.id } })).status).toBe("disconnected");
  });
});

// ---------------------------------------------------------------------------
// Reconectar a Agenda (r=agenda) e ciclo de vida
// ---------------------------------------------------------------------------

describe("reconectar a Agenda nunca cria nem recusa; só religa ou desliga a caixa que existe", () => {
  it("9a. com o gmail.send devolvido e uma caixa com senha do mesmo endereço: NÃO lança e não cria caixa", async () => {
    await conectarAgenda(U.ana);
    await criarCaixaSmtp(U.ana);
    const fim = await oauth(U.ana, { recurso: "agenda", escopos: ["openid", "email", ESCOPO_AGENDA, ESCOPO_GMAIL_ENVIO] });
    expect(fim).toMatchObject({ recurso: "agenda", email: gmail(U.ana) });
    expect(await caixasGmail(TEAM_A)).toHaveLength(0);
  });

  it("9b. a caixa que estava em erro (invalid_grant) volta a connected, com a conexão nova", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true, status: "reauth_required" });
    const caixa = await criarCaixaGmail(U.ana, c.id, "error");
    await oauth(U.ana, { recurso: "agenda", escopos: ["openid", "email", ESCOPO_AGENDA, ESCOPO_GMAIL_ENVIO] });
    const depois = await basePrisma.channelAccount.findFirstOrThrow({ where: { id: caixa.id } });
    expect(depois.status).toBe("connected");
    const conexao = await basePrisma.oAuthConnection.findFirstOrThrow({ where: { userId: U.ana.id } });
    expect(conexao.status).toBe("connected");
    expect((decryptCredentials(depois.credentials) as { oauthConnectionId: string }).oauthConnectionId).toBe(conexao.id);
  });

  it("9c. depois de desligar o envio (caixa apagada), reconectar a Agenda com gmail.send NÃO recria a caixa", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true });
    const caixa = await criarCaixaGmail(U.ana, c.id);
    await como(U.ana, () => desligarEnvioPeloGmail(caixa.id));
    expect(await caixasGmail(TEAM_A)).toHaveLength(0);
    await oauth(U.ana, { recurso: "agenda", escopos: ["openid", "email", ESCOPO_AGENDA, ESCOPO_GMAIL_ENVIO] });
    expect(await caixasGmail(TEAM_A)).toHaveLength(0);
  });

  it("9d. reconectar só com a Agenda (a pessoa desmarcou o Gmail): a caixa que existir vira disconnected", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true });
    const caixa = await criarCaixaGmail(U.ana, c.id);
    await oauth(U.ana, { recurso: "agenda", escopos: ["openid", "email", ESCOPO_AGENDA] });
    expect((await basePrisma.channelAccount.findFirstOrThrow({ where: { id: caixa.id } })).status).toBe("disconnected");
  });

  it("a volta de uma pessoa não religa a caixa órfã de outra (dono diferente)", async () => {
    // A caixa órfã: tem o `sub` da Ana mas é da Bia (ficou assim depois de uma exclusão).
    const c = await conectarAgenda(U.ana, { comEnvio: true });
    const orfa = await basePrisma.channelAccount.create({
      data: {
        teamId: TEAM_A, canal: "email", provider: "gmail_api", externalId: `gmail:${sub(U.ana)}`, ownerId: U.bia.id, label: gmail(U.ana), status: "disconnected",
        credentials: encryptCredentials({ oauthConnectionId: "conexao-antiga", user: gmail(U.ana), from: gmail(U.ana) }) as object,
      },
      select: { id: true },
    });
    await oauth(U.ana, { recurso: "agenda", escopos: ["openid", "email", ESCOPO_AGENDA, ESCOPO_GMAIL_ENVIO] });
    const depois = await basePrisma.channelAccount.findFirstOrThrow({ where: { id: orfa.id } });
    expect(depois).toMatchObject({ status: "disconnected", ownerId: U.bia.id });
    expect((decryptCredentials(depois.credentials) as { oauthConnectionId: string }).oauthConnectionId).toBe("conexao-antiga");
    // Já o envio pelo Gmail pedido pela Ana assume a caixa: foi ela quem provou ser a dona da conta Google.
    await oauth(U.ana, { recurso: "gmail" });
    const assumida = await basePrisma.channelAccount.findFirstOrThrow({ where: { id: orfa.id } });
    expect(assumida).toMatchObject({ status: "connected", ownerId: U.ana.id });
    expect((decryptCredentials(assumida.credentials) as { oauthConnectionId: string }).oauthConnectionId).not.toBe("conexao-antiga");
    expect(c.id).toBeTruthy();
  });

  it("10. desconectar a Agenda, desativar e excluir a pessoa desligam a caixa; as conversas ficam", async () => {
    // Desconectar (pela própria pessoa).
    const ana = await conectarAgenda(U.ana, { comEnvio: true });
    const caixaAna = await criarCaixaGmail(U.ana, ana.id);
    const ctAna = await contato(U.ana, "Lead da Ana", "lead.ana@empresa.com.br");
    const convAna = await basePrisma.conversation.create({ data: { teamId: TEAM_A, contactId: ctAna.id, canal: "email", channelAccountId: caixaAna.id, status: "open" } });
    expect(await como(U.ana, () => desconectarGoogle())).toEqual({ desconectada: true });
    expect((await basePrisma.channelAccount.findFirstOrThrow({ where: { id: caixaAna.id } })).status).toBe("disconnected");
    expect(await basePrisma.conversation.count({ where: { id: convAna.id } })).toBe(1);
    expect(g.revogarToken).toHaveBeenCalledWith("rt-ana");

    // Desativar (o dono desativa o Caio).
    const caio = await conectarAgenda(U.caio, { comEnvio: true });
    const caixaCaio = await criarCaixaGmail(U.caio, caio.id);
    await como(U.dono, () => desativarIntegrante(U.caio.id));
    expect((await basePrisma.channelAccount.findFirstOrThrow({ where: { id: caixaCaio.id } })).status).toBe("disconnected");
    expect(await basePrisma.oAuthConnection.count({ where: { userId: U.caio.id } })).toBe(0);

    // Excluir (o Davi sai e a Bia recebe o que era dele; a caixa muda de dono e é desligada na mesma transação).
    const davi = await conectarAgenda(U.davi, { comEnvio: true });
    const caixaDavi = await criarCaixaGmail(U.davi, davi.id);
    const ctDavi = await contato(U.davi, "Lead do Davi", "lead.davi@empresa.com.br");
    const convDavi = await basePrisma.conversation.create({ data: { teamId: TEAM_A, contactId: ctDavi.id, canal: "email", channelAccountId: caixaDavi.id, status: "open" } });
    await como(U.dono, () => excluirIntegrante(U.davi.id, U.bia.id));
    const depois = await basePrisma.channelAccount.findFirstOrThrow({ where: { id: caixaDavi.id } });
    expect(depois).toMatchObject({ status: "disconnected", ownerId: U.bia.id });
    expect(await basePrisma.conversation.count({ where: { id: convDavi.id } })).toBe(1);
    expect(g.revogarToken).toHaveBeenCalledWith("rt-davi");
  });

  it("11. o IMAP nunca lê a caixa gmail_api", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true });
    await criarCaixaGmail(U.ana, c.id);
    await criarCaixaSmtp(U.bia); // sem servidor IMAP: só conta como "sem_imap", sem tocar em Redis
    const r = await pollAllEmailInboxes({ teamIds: [TEAM_A] });
    expect(r.accounts).toBe(1);
    expect(r.porResultado).toEqual({ sem_imap: 1 });
  });
});

// ---------------------------------------------------------------------------
// Quem pode e o que cada um vê
// ---------------------------------------------------------------------------

describe("duas pessoas no mesmo time e dois times", () => {
  it("12. a Bia não usa nem desliga a caixa da Ana; o administrador e a dona desligam", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true });
    const caixa = await criarCaixaGmail(U.ana, c.id);
    const ctBia = await contato(U.bia, "Lead da Bia", "lead.bia@empresa.com.br");
    const chamadas = fingirEnvioDoGmail();

    // Enviar pela caixa da Ana, com o id explícito: recusado pelo escopo, como no SMTP.
    const e = await como(U.bia, () => sendEmail(ctBia.id, { subject: "Oi", body: "Olá", channelAccountId: caixa.id })).catch((x) => x);
    expect(isChannelSendFailed(e)).toBe(true);
    expect(e.message).toMatch(/nenhuma conta de e-mail conectada/);
    expect(chamadas).toHaveLength(0);

    await expect(como(U.bia, () => desligarEnvioPeloGmail(caixa.id))).rejects.toBeInstanceOf(OwnedNotFound);
    expect(await caixasGmail(TEAM_A)).toHaveLength(1);
    // Quem só lê não desliga nem a própria (precisa de "conexão própria").
    await expect(como({ ...U.ana, role: "viewer" }, () => desligarEnvioPeloGmail(caixa.id))).rejects.toBeInstanceOf(ForbiddenError);

    await como(U.adm, () => desligarEnvioPeloGmail(caixa.id));
    expect(await caixasGmail(TEAM_A)).toHaveLength(0);

    // A dona (membro, sem integrations.manage) desliga a dela numa caixa recriada.
    const nova = await criarCaixaGmail(U.ana, c.id);
    await como(U.ana, () => desligarEnvioPeloGmail(nova.id));
    expect(await caixasGmail(TEAM_A)).toHaveLength(0);
    // A conexão da Agenda continua e não foi revogada no Google.
    expect(await basePrisma.oAuthConnection.count({ where: { userId: U.ana.id } })).toBe(1);
    expect(g.revogarToken).not.toHaveBeenCalled();
  });

  it("13. um time não vê nem usa a caixa de outro; notificação do time nunca sai pelo Gmail pessoal de outra pessoa", async () => {
    const cAna = await conectarAgenda(U.ana, { comEnvio: true });
    const caixaAna = await criarCaixaGmail(U.ana, cAna.id);
    const cCarla = await conectarAgenda(U.carla, { comEnvio: true });
    await criarCaixaGmail(U.carla, cCarla.id);
    const ctCarla = await contato(U.carla, "Lead da Carla", "lead.carla@empresa.com.br");
    const chamadas = fingirEnvioDoGmail();

    // No time B a caixa do time A não aparece nem envia.
    const doB = await como(U.carla, () => listEmailAccounts());
    expect(doB.map((x) => x.id)).not.toContain(caixaAna.id);
    expect(doB).toHaveLength(1);
    const e = await como(U.carla, () => sendEmail(ctCarla.id, { subject: "Oi", body: "Olá", channelAccountId: caixaAna.id })).catch((x) => x);
    expect(isChannelSendFailed(e)).toBe(true);
    expect(chamadas).toHaveLength(0);
    await expect(como(U.carla, () => desligarEnvioPeloGmail(caixaAna.id))).rejects.toBeInstanceOf(OwnedNotFound);

    // Notificação do time (convite, alerta, reset): o sistema não usa o Gmail da Carla.
    expect(await runAsSystem(TEAM_B, () => sendTransactionalEmail({ to: "x@empresa.com.br", subject: "Aviso", text: "t" }))).toBe(false);
    expect(chamadas).toHaveLength(0);
    // O administrador do time A também não: só há o Gmail pessoal da Ana.
    expect(await como(U.adm, () => sendTransactionalEmail({ to: "x@empresa.com.br", subject: "Aviso", text: "t" }))).toBe(false);
    expect(chamadas).toHaveLength(0);
    // Mas a própria Carla, agindo como pessoa, envia pelo Gmail dela.
    expect(await como(U.carla, () => sendTransactionalEmail({ to: "x@empresa.com.br", subject: "Aviso", text: "t" }))).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(bearer(chamadas[0]!)).toBe("Bearer at-carla");
    // Com uma caixa SMTP do time, a notificação do sistema sai por ELA e nunca pelo Gmail (o SMTP é simulado).
    await criarCaixaSmtp(U.bia, "time@empresa.com.br");
    const transporte = transporteSmtpPara({ host: "smtp.teste.invalid", port: 587, secure: false, user: "time@empresa.com.br", pass: "senha-de-app", from: "time@empresa.com.br" });
    const sendMail = vi.spyOn(transporte, "sendMail").mockResolvedValue({ messageId: "<x@teste>" } as never);
    try {
      expect(await runAsSystem(TEAM_A, () => sendTransactionalEmail({ to: "x@empresa.com.br", subject: "Aviso", text: "t" }))).toBe(true);
    } finally {
      transporte.close();
    }
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(chamadas).toHaveLength(1); // o Gmail não foi usado de novo
  });

  it("14. a lista não traz token nem host; mexer numa caixa do Gmail com senha de app é recusado nos dois sentidos", async () => {
    const c = await conectarAgenda(U.ana, { comEnvio: true });
    const caixa = await criarCaixaGmail(U.ana, c.id);

    const lista = await como(U.ana, () => listEmailAccounts());
    expect(lista).toEqual([{ id: caixa.id, label: gmail(U.ana), status: "connected", connected: true, from: gmail(U.ana), host: null }]);
    expect(JSON.stringify(lista)).not.toMatch(/at-ana|rt-ana|oauthConnectionId|accessToken|refreshToken|pass/);
    const config = await como(U.ana, () => getEmailAccountConfig(caixa.id));
    expect(config).toMatchObject({ id: caixa.id, host: "", hasPass: false, user: gmail(U.ana) });
    expect(JSON.stringify(config)).not.toMatch(/at-ana|rt-ana|oauthConnectionId|accessToken|refreshToken/);

    // Editar pelo id (o administrador enxerga a caixa da Ana) ou conectar o mesmo endereço com senha: recusado.
    await expect(
      como(U.adm, () => connectEmailAccount({ id: caixa.id, label: "x", host: "smtp.teste.invalid", port: 587, user: gmail(U.ana), pass: "senha" })),
    ).rejects.toBeInstanceOf(CaixaJaConectadaPeloGmail);
    await expect(
      como(U.adm, () => connectEmailAccount({ label: "x", host: "smtp.teste.invalid", port: 587, user: gmail(U.ana).toUpperCase(), pass: "senha" })),
    ).rejects.toBeInstanceOf(CaixaJaConectadaPeloGmail);
    // A caixa segue igual.
    const igual = await basePrisma.channelAccount.findFirstOrThrow({ where: { id: caixa.id } });
    expect(igual).toMatchObject({ provider: "gmail_api", status: "connected" });
    expect((decryptCredentials(igual.credentials) as Record<string, unknown>).pass).toBeUndefined();
  });

  it("15. envioPeloGmailParaMim: desligado, agenda-antes, pode-conectar e conectado", async () => {
    // Chave vazia: desligado, mesmo com tudo pronto.
    await conectarAgenda(U.ana);
    env.GOOGLE_GMAIL_ENVIO = undefined;
    expect(await como(U.ana, () => envioPeloGmailParaMim())).toBe("desligado");
    env.GOOGLE_GMAIL_ENVIO = "on";
    // Fora da lista da Agenda, só leitura e sistema também dão "desligado".
    env.GOOGLE_AGENDA_LIBERADOS = "";
    expect(await como(U.ana, () => envioPeloGmailParaMim())).toBe("desligado");
    env.GOOGLE_AGENDA_LIBERADOS = "todos";
    expect(await como({ ...U.ana, role: "viewer" }, () => envioPeloGmailParaMim())).toBe("desligado");
    expect(await runAsSystem(TEAM_A, () => envioPeloGmailParaMim())).toBe("desligado");

    // Sem a Agenda: a Agenda vem antes.
    expect(await como(U.bia, () => envioPeloGmailParaMim())).toBe("agenda-antes");
    // Com a Agenda (só o escopo dela): pode conectar o envio.
    expect(await como(U.ana, () => envioPeloGmailParaMim())).toBe("pode-conectar");
    // Depois do caso 3: conectado.
    await oauth(U.ana, { recurso: "gmail" });
    expect(await como(U.ana, () => envioPeloGmailParaMim())).toBe("conectado");
    // Se a caixa for desligada, volta a poder conectar.
    const caixa = (await caixasGmail(TEAM_A))[0]!;
    await como(U.ana, () => desligarEnvioPeloGmail(caixa.id));
    expect(await como(U.ana, () => envioPeloGmailParaMim())).toBe("pode-conectar");
  });
});
