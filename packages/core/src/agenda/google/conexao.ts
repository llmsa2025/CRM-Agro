import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { env } from "@crmagro/config";
import { basePrisma, db, decryptCredentials, encryptCredentials, getCurrentModulos, runAsSystem, type TenantPrismaClient } from "@crmagro/db";
import { ForbiddenError, getActor, requireCan } from "../../auth/authz";
import { temModulo } from "../../auth/modulos";
import { enviarPush } from "../../push/service";
import { logger } from "../../logger/index";
import {
  ESCOPO_AGENDA,
  ESCOPO_GMAIL_ENVIO,
  ESCOPOS_IDENTIDADE,
  GOOGLE_AUTH_URL,
  GoogleApiErro,
  GoogleAutorizacaoInvalida,
  pararCanal,
  renovarAccessToken,
  revogarToken,
  trocarCodigo,
} from "./cliente";
import { enfileirarSyncGoogle } from "./fila";
import {
  caixaComSenhaDoMesmoEndereco,
  CaixaJaConectadaComSenha,
  conectarContaGmailApi,
  desligarContasGmail,
  externalIdDoGmail,
  PROVEDOR_GMAIL_API,
  religarContaGmailApi,
} from "./gmail-envio";

/**
 * Conexão da Agenda Google POR PESSOA (decisões 2, 3 e 7 do dono, 28/09).
 *
 * - Cliente OAuth SEPARADO do login (GOOGLE_INTEGRACOES_CLIENT_ID/SECRET), no
 *   mesmo projeto Google. Sem as variáveis, nada aparece (fail-soft).
 * - Cada pessoa conecta a PRÓPRIA agenda (ação `conexao.propria`, nível
 *   membro), com a tela Agenda OU Integrações liberada — sem o administrador.
 * - `state` assinado (HMAC do AUTH_SECRET) amarrado à sessão (pessoa + time) e a
 *   um nonce guardado em cookie httpOnly; PKCE (S256) no mesmo cookie.
 * - Tokens cifrados com `encryptCredentials` (anel de rotação); nunca saem do
 *   servidor, nunca vão para log, job ou tela.
 * - Desconectar/desativar/excluir: para o canal de push, revoga no Google e
 *   APAGA a conexão (os vínculos e os blocos "Ocupado" saem em cascata). Os
 *   compromissos ficam (são histórico do CRM).
 *
 * A conexão de uma pessoa nunca aparece para outra — nem para o master: toda
 * leitura aqui filtra `userId = eu` (não é o escopo "ver tudo" das telas).
 */

export const PROVEDOR_GOOGLE = "google" as const;
/** O `state` vale 10 minutos (tempo de a pessoa passar pela tela do Google). */
const VALIDADE_STATE_MS = 10 * 60_000;

export class GoogleAgendaIndisponivel extends Error {
  constructor() {
    super("GoogleAgendaIndisponivel: a integração com o Google Agenda não está configurada neste servidor.");
    this.name = "GoogleAgendaIndisponivel";
  }
}
/** `state` adulterado, vencido, de outra pessoa ou sem o cookie do início. */
export class EstadoOAuthInvalido extends Error {
  constructor(motivo: string) {
    super(`EstadoOAuthInvalido: ${motivo}`);
    this.name = "EstadoOAuthInvalido";
  }
}
/** A pessoa desmarcou a permissão da agenda na tela do Google. */
export class PermissaoDaAgendaNegada extends Error {
  constructor() {
    super("PermissaoDaAgendaNegada: o Google não liberou o acesso à agenda. Conecte de novo e marque a permissão da agenda.");
    this.name = "PermissaoDaAgendaNegada";
  }
}
/** A conta Google já está conectada por OUTRA pessoa (não transfere em silêncio). */
export class AgendaGoogleDeOutraPessoa extends Error {
  constructor() {
    super("AgendaGoogleDeOutraPessoa: esta conta Google já está conectada por outra pessoa no CRM Agro.");
    this.name = "AgendaGoogleDeOutraPessoa";
  }
}
export class RespostaDoGoogleInvalida extends Error {
  constructor(motivo: string) {
    super(`RespostaDoGoogleInvalida: ${motivo}`);
    this.name = "RespostaDoGoogleInvalida";
  }
}
/**
 * A pessoa (ou o time dela) não está na lista `GOOGLE_AGENDA_LIBERADOS`: a
 * Agenda Google ainda não abriu para ela (A2, até o Google verificar o app).
 */
export class AgendaGoogleNaoLiberada extends Error {
  constructor() {
    super("AgendaGoogleNaoLiberada: a Agenda Google ainda não foi liberada para a sua conta.");
    this.name = "AgendaGoogleNaoLiberada";
  }
}
/** O envio pelo Gmail é um passo em cima da Agenda: sem a Agenda conectada, não começa. */
export class AgendaGoogleNecessaria extends Error {
  constructor() {
    super("AgendaGoogleNecessaria: conecte a Agenda Google antes de ligar o envio pelo Gmail.");
    this.name = "AgendaGoogleNecessaria";
  }
}
/** A pessoa desmarcou a permissão de enviar e-mail na tela do Google. */
export class PermissaoDoGmailNegada extends Error {
  constructor() {
    super("PermissaoDoGmailNegada: o Google não liberou o envio de e-mail. Tente de novo e marque a permissão de enviar e-mail.");
    this.name = "PermissaoDoGmailNegada";
  }
}
/** Na volta do Google, a conta escolhida não é a da Agenda: não troca a Agenda em silêncio. */
export class GmailEmOutraConta extends Error {
  constructor() {
    super("GmailEmOutraConta: escolha a mesma conta Google da sua Agenda para enviar e-mail por ela.");
    this.name = "GmailEmOutraConta";
  }
}
/** Envio pelo Gmail desligado neste servidor (`GOOGLE_GMAIL_ENVIO` diferente de `on`). */
export class EnvioPeloGmailDesligado extends Error {
  constructor() {
    super("EnvioPeloGmailDesligado: o envio pelo Gmail não está ligado neste servidor.");
    this.name = "EnvioPeloGmailDesligado";
  }
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/** A integração está configurada (as duas variáveis do cliente OAuth)? */
export function googleAgendaConfigurada(): boolean {
  return Boolean(env.GOOGLE_INTEGRACOES_CLIENT_ID && env.GOOGLE_INTEGRACOES_CLIENT_SECRET);
}

export function clienteOAuth(): { clientId: string; clientSecret: string } {
  const clientId = env.GOOGLE_INTEGRACOES_CLIENT_ID;
  const clientSecret = env.GOOGLE_INTEGRACOES_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GoogleAgendaIndisponivel();
  return { clientId, clientSecret };
}

/** URL pública do app (sem barra no fim): AUTH_URL, senão APP_PUBLIC_URL. Nunca o host interno. */
export function urlPublicaDoApp(): string | null {
  const base = env.AUTH_URL ?? env.APP_PUBLIC_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

/** Push ligado: não desligado no .env e com URL pública https (o Google exige). */
export function pushDaAgendaHabilitado(): boolean {
  return env.GOOGLE_AGENDA_PUSH !== "off" && Boolean(urlPublicaDoApp()?.startsWith("https://"));
}

/** URL de retorno do OAuth — a MESMA cadastrada no cliente "CRM Agro — Integrações". */
export function urlDeRetornoGoogle(): string {
  if (env.GOOGLE_INTEGRACOES_REDIRECT_URI) return env.GOOGLE_INTEGRACOES_REDIRECT_URI;
  const base = urlPublicaDoApp();
  if (!base) throw new GoogleAgendaIndisponivel();
  return `${base}/api/integracoes/google/callback`;
}

// ---------------------------------------------------------------------------
// Liberação até a verificação do Google (A2)
// ---------------------------------------------------------------------------

/**
 * Quem pode usar a Agenda Google enquanto o app não é verificado pelo Google.
 *
 * Sem verificação, o Google limita o projeto a 100 pessoas novas NO TOTAL, PARA
 * SEMPRE — e o projeto é o mesmo do "Entrar com Google". Cada conexão gasta uma
 * vaga que não volta. Por isso só conecta quem o dono listar em
 * `GOOGLE_AGENDA_LIBERADOS` (FAIL-CLOSED: vazio ou ausente = ninguém).
 */
export type LiberacaoDaAgenda = { todos: boolean; emails: ReadonlySet<string>; times: ReadonlySet<string> };

/**
 * Lê o texto de `GOOGLE_AGENDA_LIBERADOS`. Itens separados por vírgula, ponto e
 * vírgula ou espaço, sem maiúsculas nem espaços sobrando: `todos` (ou `*`)
 * libera geral; item com `@` é o e-mail de login de uma pessoa; qualquer outro é
 * o id de um time. Ausente ou vazio = tudo vazio (ninguém). Pura, para testar
 * sem env.
 */
export function lerLiberados(valor: string | undefined | null): LiberacaoDaAgenda {
  const emails = new Set<string>();
  const times = new Set<string>();
  let todos = false;
  for (const bruto of String(valor ?? "").split(/[,;\s]+/)) {
    const item = bruto.trim().toLowerCase();
    if (!item) continue;
    if (item === "todos" || item === "*") todos = true;
    else if (item.includes("@")) emails.add(item);
    else times.add(item);
  }
  return { todos, emails, times };
}

/** A pessoa (time + e-mail de login) consta na liberação? Pura, sem banco. */
function estaNaLiberacao(l: LiberacaoDaAgenda, p: { teamId: string; email?: string | null }): boolean {
  if (l.todos) return true;
  if (l.times.has(p.teamId.trim().toLowerCase())) return true;
  const email = p.email?.trim().toLowerCase();
  return Boolean(email && l.emails.has(email));
}

/**
 * A pessoa dona da conexão está liberada pela lista ATUAL do `.env`? Sem
 * banco: quem chama já leu o time e o e-mail (worker, envio ao Google).
 */
export function agendaGoogleLiberadaPara(p: { teamId: string; email?: string | null }): boolean {
  return estaNaLiberacao(lerLiberados(env.GOOGLE_AGENDA_LIBERADOS), p);
}

/**
 * Filtro Prisma das conexões cujas donas estão liberadas: as consultas do
 * worker o usam para as paradas não ocuparem as vagas de leitura (senão 100
 * conexões antigas fora da lista segurariam a fila das que valem). Nada
 * liberado casa com NADA (fail-closed).
 */
export function filtroDeConexoesLiberadas(): Prisma.OAuthConnectionWhereInput {
  const l = lerLiberados(env.GOOGLE_AGENDA_LIBERADOS);
  if (l.todos) return {};
  const ou: Prisma.OAuthConnectionWhereInput[] = [];
  if (l.times.size) ou.push({ teamId: { in: [...l.times] } });
  for (const email of l.emails) ou.push({ user: { email: { equals: email, mode: "insensitive" } } });
  return ou.length ? { OR: ou } : { id: { in: [] } };
}

/**
 * A pessoa logada está liberada para conectar/usar a Agenda Google? Sem ator ou
 * no contexto de sistema (a conexão é de uma PESSOA) = não. Só consulta o banco
 * (o e-mail) quando a lista tem e-mails e nada mais decidiu antes.
 */
export async function agendaGoogleLiberadaParaMim(): Promise<boolean> {
  const ator = getActor();
  if (!ator || ator.system) return false;
  const l = lerLiberados(env.GOOGLE_AGENDA_LIBERADOS);
  if (l.todos || l.times.has(ator.teamId.trim().toLowerCase())) return true;
  if (!l.emails.size) return false;
  const eu = await db().user.findUnique({ where: { id: ator.userId }, select: { email: true } });
  return estaNaLiberacao(l, { teamId: ator.teamId, email: eu?.email });
}

/** Exige a liberação da pessoa logada; lança `AgendaGoogleNaoLiberada` se não estiver. */
export async function exigirAgendaGoogleLiberada(): Promise<void> {
  if (!(await agendaGoogleLiberadaParaMim())) throw new AgendaGoogleNaoLiberada();
}

// ---------------------------------------------------------------------------
// state assinado + PKCE
// ---------------------------------------------------------------------------

export type VoltaDaConexao = "integracoes" | "agenda" | "canais";
/** O que a volta do Google conecta: só a Agenda (padrão) ou o envio pelo Gmail (`gmail.send`). */
type RecursoDaConexao = "agenda" | "gmail";
/** `r` ausente = `"agenda"`: os `state` antigos (de antes do envio pelo Gmail) continuam valendo. */
type DadosDoEstado = { u: string; t: string; n: string; e: number; v: VoltaDaConexao; r?: RecursoDaConexao };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const assinatura = (payload: string) => createHmac("sha256", `crmagro-google-agenda-state:${env.AUTH_SECRET}`).update(payload).digest();

export function assinarEstado(dados: DadosDoEstado): string {
  const payload = b64url(JSON.stringify(dados));
  return `${payload}.${b64url(assinatura(payload))}`;
}

/**
 * Confere o `state` do retorno: assinatura (tempo constante), validade e que é
 * da MESMA pessoa/time da sessão e do MESMO navegador (nonce do cookie).
 */
export function verificarEstado(state: string, esperado: { userId: string; teamId: string; nonce: string | null | undefined }, agora = Date.now()): DadosDoEstado {
  const [payload, sig] = String(state ?? "").split(".");
  if (!payload || !sig) throw new EstadoOAuthInvalido("formato");
  const recebida = Buffer.from(sig, "base64url");
  const certa = assinatura(payload);
  if (recebida.length !== certa.length || !timingSafeEqual(recebida, certa)) throw new EstadoOAuthInvalido("assinatura");
  let dados: DadosDoEstado;
  try {
    dados = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DadosDoEstado;
  } catch {
    throw new EstadoOAuthInvalido("conteúdo");
  }
  if (typeof dados.e !== "number" || dados.e < agora) throw new EstadoOAuthInvalido("vencido");
  if (dados.u !== esperado.userId || dados.t !== esperado.teamId) throw new EstadoOAuthInvalido("outra pessoa");
  const nonce = Buffer.from(String(esperado.nonce ?? ""));
  const doEstado = Buffer.from(String(dados.n ?? ""));
  if (!esperado.nonce || nonce.length !== doEstado.length || !timingSafeEqual(nonce, doEstado)) throw new EstadoOAuthInvalido("navegador");
  return dados;
}

/** Desafio PKCE (S256) do verificador. */
export function desafioPkce(verificador: string): string {
  return createHash("sha256").update(verificador).digest("base64url");
}

// ---------------------------------------------------------------------------
// Quem pode
// ---------------------------------------------------------------------------

/**
 * Conexão PRÓPRIA: papel de membro e a tela Agenda OU Integrações. Nunca o
 * sistema (a conexão é de uma pessoa). Devolve o ator.
 */
export function exigirConexaoPropria() {
  const ator = requireCan("conexao.propria");
  if (ator.system) throw new ForbiddenError();
  const modulos = getCurrentModulos();
  if (!temModulo(ator.role, modulos, "agenda") && !temModulo(ator.role, modulos, "integracoes")) throw new ForbiddenError();
  return ator;
}

/** A pessoa logada pode CONECTAR a agenda (sem lançar; a tela esconde o botão para quem não pode)? */
export function podeConectarGoogle(): boolean {
  try {
    exigirConexaoPropria();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Início e fim do OAuth
// ---------------------------------------------------------------------------

/**
 * Monta a URL de autorização do Google. Devolve também o `nonce` e o
 * `verificador` PKCE, que a rota guarda num cookie httpOnly do navegador.
 *
 * `recurso: "gmail"` (E7) acrescenta o `gmail.send` em cima da conexão da Agenda
 * que a pessoa JÁ tem (autorização incremental: `include_granted_scopes` soma o que o
 * Google já tinha). Exige a chave `GOOGLE_GMAIL_ENVIO=on`, a mesma lista da Agenda e a
 * Agenda conectada. Vai com `prompt=consent` sem `select_account` e com o `login_hint`
 * da conta Google da conexão: a pessoa não deve trocar de conta aqui.
 */
export async function iniciarConexaoGoogle(
  opts: { volta?: VoltaDaConexao; recurso?: RecursoDaConexao } = {},
): Promise<{ url: string; nonce: string; verificador: string }> {
  const ator = exigirConexaoPropria();
  const prisma = db(); // no início, antes de qualquer await (AGENTS.md §12)
  const recurso: RecursoDaConexao = opts.recurso === "gmail" ? "gmail" : "agenda";
  if (recurso === "gmail" && env.GOOGLE_GMAIL_ENVIO !== "on") throw new EnvioPeloGmailDesligado();
  // Cada conexão gasta uma das 100 vagas VITALÍCIAS do projeto enquanto o Google
  // não verifica o app (e o projeto é o do login): só quem está na lista conecta.
  await exigirAgendaGoogleLiberada();
  const { clientId } = clienteOAuth();
  // Envio pelo Gmail: a Agenda vem antes (a conexão é uma só) e dela vêm o e-mail da conta Google.
  let contaGoogle: string | null = null;
  if (recurso === "gmail") {
    const conexao = await prisma.oAuthConnection.findFirst({
      where: { userId: ator.userId, provider: PROVEDOR_GOOGLE, status: "connected" },
      select: { email: true, scopes: true },
    });
    if (!conexao || !conexao.scopes.includes(ESCOPO_AGENDA)) throw new AgendaGoogleNecessaria();
    contaGoogle = conexao.email;
  }
  const eu = recurso === "agenda" ? await prisma.user.findUnique({ where: { id: ator.userId }, select: { email: true } }) : null;
  const nonce = b64url(randomBytes(24));
  const verificador = b64url(randomBytes(32));
  const volta: VoltaDaConexao = opts.volta === "agenda" ? "agenda" : opts.volta === "canais" ? "canais" : "integracoes";
  const state = assinarEstado({
    u: ator.userId,
    t: ator.teamId,
    n: nonce,
    e: Date.now() + VALIDADE_STATE_MS,
    v: volta,
    ...(recurso === "gmail" ? { r: "gmail" as const } : {}),
  });
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: urlDeRetornoGoogle(),
    response_type: "code",
    // Agenda: escopo mínimo + identidade (qual conta foi conectada). Envio pelo Gmail:
    // identidade + `gmail.send`; o Google soma o da Agenda (include_granted_scopes).
    scope: [...ESCOPOS_IDENTIDADE, recurso === "gmail" ? ESCOPO_GMAIL_ENVIO : ESCOPO_AGENDA].join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    // "consent" garante o refresh token; "select_account" deixa escolher a conta (só na
    // Agenda: no envio pelo Gmail a conta é a da conexão).
    prompt: recurso === "gmail" ? "consent" : "consent select_account",
    state,
    code_challenge: desafioPkce(verificador),
    code_challenge_method: "S256",
  });
  const dica = contaGoogle ?? eu?.email;
  if (dica) q.set("login_hint", dica);
  return { url: `${GOOGLE_AUTH_URL}?${q.toString()}`, nonce, verificador };
}

type IdentidadeGoogle = { sub: string; email: string };

/**
 * Lê o id_token recebido DIRETO do endpoint de token do Google (TLS): a
 * especificação OIDC dispensa conferir a assinatura nesse caso, mas conferimos
 * o emissor, o público (nosso client id) e a validade.
 */
export function identidadeDoIdToken(idToken: string | undefined, clientId: string, agora = Date.now()): IdentidadeGoogle {
  if (!idToken) throw new RespostaDoGoogleInvalida("sem id_token");
  const partes = idToken.split(".");
  if (partes.length < 2) throw new RespostaDoGoogleInvalida("id_token");
  let p: { iss?: string; aud?: string | string[]; sub?: string; email?: string; exp?: number };
  try {
    p = JSON.parse(Buffer.from(partes[1]!, "base64url").toString("utf8"));
  } catch {
    throw new RespostaDoGoogleInvalida("id_token");
  }
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (p.iss !== "https://accounts.google.com" && p.iss !== "accounts.google.com") throw new RespostaDoGoogleInvalida("emissor");
  if (!aud.includes(clientId)) throw new RespostaDoGoogleInvalida("público");
  if (typeof p.exp === "number" && p.exp * 1000 < agora - 5 * 60_000) throw new RespostaDoGoogleInvalida("vencido");
  if (!p.sub || !p.email) throw new RespostaDoGoogleInvalida("sem conta");
  return { sub: p.sub, email: p.email.toLowerCase() };
}

type Credenciais = { refreshToken?: string; accessToken?: string };

function lerCredenciais(valor: unknown): Credenciais {
  const c = decryptCredentials(valor);
  return c && typeof c === "object" ? (c as Credenciais) : {};
}

/**
 * Retorno do Google: confere o `state`, troca o `code` (com o verificador
 * PKCE), confere os escopos concedidos e grava a conexão com os tokens
 * CIFRADOS. A primeira sincronização vai para a fila (worker), não roda aqui.
 *
 * Com `r=gmail` no `state` (envio pelo Gmail, E7), ANTES de gravar qualquer coisa:
 * a chave tem de estar ligada, o `gmail.send` tem de ter sido concedido, a conta Google
 * que voltou tem de ser a da Agenda atual (senão a "troca de conta" encerraria a
 * Agenda sem a pessoa pedir) e não pode haver caixa com senha do mesmo endereço.
 * Depois do upsert da conexão, nasce a caixa `gmail_api`. Com `r=agenda`, só se
 * religa ou desliga a caixa `gmail_api` que JÁ existe: com `include_granted_scopes`,
 * toda reconexão da Agenda devolve o `gmail.send` de novo, e ela nunca cria caixa
 * nem recusa por causa dela.
 */
export async function concluirConexaoGoogle(input: {
  code: string;
  state: string;
  nonce: string | null | undefined;
  verificador: string | null | undefined;
}): Promise<{ volta: VoltaDaConexao; email: string; recurso: RecursoDaConexao }> {
  const ator = exigirConexaoPropria();
  // A volta do Google também confere a lista: quem saiu dela no meio do caminho
  // (ou chegou aqui por uma URL montada à mão) não grava conexão.
  await exigirAgendaGoogleLiberada();
  const dados = verificarEstado(input.state, { userId: ator.userId, teamId: ator.teamId, nonce: input.nonce });
  const recurso: RecursoDaConexao = dados.r === "gmail" ? "gmail" : "agenda";
  if (recurso === "gmail" && env.GOOGLE_GMAIL_ENVIO !== "on") throw new EnvioPeloGmailDesligado();
  if (!input.verificador) throw new EstadoOAuthInvalido("navegador");
  if (!input.code || input.code.length > 512) throw new EstadoOAuthInvalido("code");
  const cliente = clienteOAuth();
  const tokens = await trocarCodigo({ code: input.code, codeVerifier: input.verificador, redirectUri: urlDeRetornoGoogle(), ...cliente });
  if (!tokens.escopos.includes(ESCOPO_AGENDA)) throw new PermissaoDaAgendaNegada();
  if (recurso === "gmail" && !tokens.escopos.includes(ESCOPO_GMAIL_ENVIO)) throw new PermissaoDoGmailNegada();
  const conta = identidadeDoIdToken(tokens.idToken, cliente.clientId);

  // A mesma conta Google em outra pessoa (de qualquer time): recusa, não transfere.
  const dono = await basePrisma.oAuthConnection.findUnique({
    where: { provider_externalAccountId: { provider: PROVEDOR_GOOGLE, externalAccountId: conta.sub } },
    select: { userId: true },
  });
  if (dono && dono.userId !== ator.userId) throw new AgendaGoogleDeOutraPessoa();

  const prisma = db();
  const atual = await prisma.oAuthConnection.findFirst({
    where: { userId: ator.userId, provider: PROVEDOR_GOOGLE },
    select: { id: true, externalAccountId: true, credentials: true },
  });
  if (recurso === "gmail") {
    // O envio pelo Gmail só liga em cima da Agenda que já existe, e da MESMA conta Google.
    if (!atual) throw new AgendaGoogleNecessaria();
    if (atual.externalAccountId !== conta.sub) throw new GmailEmOutraConta();
    if (await caixaComSenhaDoMesmoEndereco(conta.email)) throw new CaixaJaConectadaComSenha();
  }
  // Trocou de conta Google: a antiga sai (revogada e apagada) antes da nova.
  if (atual && atual.externalAccountId !== conta.sub) {
    await encerrarConexoes(await lerParaEncerrar(prisma, { id: atual.id }));
  }
  const refreshToken = tokens.refreshToken ?? (atual?.externalAccountId === conta.sub ? lerCredenciais(atual.credentials).refreshToken : undefined);
  if (!refreshToken) throw new RespostaDoGoogleInvalida("sem refresh token (desconecte e conecte de novo)");

  const credentials = encryptCredentials({ refreshToken, accessToken: tokens.accessToken }) as unknown as Prisma.InputJsonValue;
  const campos = {
    externalAccountId: conta.sub,
    email: conta.email,
    scopes: tokens.escopos,
    credentials,
    accessTokenExpiraEm: tokens.expiraEm,
    status: "connected" as const,
    falhas: 0,
    ultimoErro: null,
    ultimoErroEm: null,
  };
  const conexao = await prisma.oAuthConnection.upsert({
    where: { userId_provider: { userId: ator.userId, provider: PROVEDOR_GOOGLE } },
    create: { userId: ator.userId, provider: PROVEDOR_GOOGLE, ...campos } as Prisma.OAuthConnectionUncheckedCreateInput,
    update: campos,
    select: { id: true },
  });
  // Agenda principal: a próxima rodada do worker faz a sincronização completa.
  await prisma.calendarSync.upsert({
    where: { connectionId_calendarId: { connectionId: conexao.id, calendarId: "primary" } },
    create: { connectionId: conexao.id, calendarId: "primary", proximaSincronizacaoEm: new Date() } as Prisma.CalendarSyncUncheckedCreateInput,
    update: { proximaSincronizacaoEm: new Date(), falhas: 0, ultimoErro: null },
  });
  logger.info({ connectionId: conexao.id, userId: ator.userId, recurso }, "[agenda-google] agenda conectada");
  // Caixa de envio pelo Gmail: cria (r=gmail) ou só religa/desliga a que existe (r=agenda).
  if (recurso === "gmail") {
    await conectarContaGmailApi({ ownerId: ator.userId, conexaoId: conexao.id, sub: conta.sub, email: conta.email });
  } else {
    await religarContaGmailApi({
      ownerId: ator.userId,
      conexaoId: conexao.id,
      sub: conta.sub,
      email: conta.email,
      comEnvio: tokens.escopos.includes(ESCOPO_GMAIL_ENVIO),
    });
  }
  // Sem Redis agora, a rodada de manutenção (a cada minuto) pega do mesmo jeito.
  await enfileirarSyncGoogle(conexao.id).catch(() => {});
  return { volta: dados.v, email: conta.email, recurso };
}

// ---------------------------------------------------------------------------
// Envio pelo Gmail: em que passo a pessoa está (a tela da E7b usa, no servidor)
// ---------------------------------------------------------------------------

/**
 * - `desligado`: a integração, a chave `GOOGLE_GMAIL_ENVIO`, a permissão da pessoa ou a
 *   lista da Agenda não deixam (a tela nem mostra o botão);
 * - `agenda-antes`: falta conectar a Agenda (o envio é um passo em cima dela);
 * - `pode-conectar`: falta só acrescentar o envio pelo Gmail;
 * - `conectado`: a conexão tem o `gmail.send` e a caixa `gmail_api` está ligada.
 */
export type EnvioPeloGmail = "desligado" | "agenda-antes" | "pode-conectar" | "conectado";

export async function envioPeloGmailParaMim(): Promise<EnvioPeloGmail> {
  const ator = getActor();
  if (!ator || ator.system) return "desligado";
  const prisma = db();
  if (!googleAgendaConfigurada() || env.GOOGLE_GMAIL_ENVIO !== "on" || !podeConectarGoogle() || !(await agendaGoogleLiberadaParaMim())) return "desligado";
  const conexao = await prisma.oAuthConnection.findFirst({
    where: { userId: ator.userId, provider: PROVEDOR_GOOGLE, status: "connected" },
    select: { externalAccountId: true, scopes: true },
  });
  if (!conexao || !conexao.scopes.includes(ESCOPO_AGENDA)) return "agenda-antes";
  if (conexao.scopes.includes(ESCOPO_GMAIL_ENVIO)) {
    const caixa = await prisma.channelAccount.findFirst({
      where: { canal: "email", provider: PROVEDOR_GMAIL_API, externalId: externalIdDoGmail(conexao.externalAccountId), ownerId: ator.userId, status: "connected" },
      select: { id: true },
    });
    if (caixa) return "conectado";
  }
  return "pode-conectar";
}

// ---------------------------------------------------------------------------
// Leitura (só a PRÓPRIA)
// ---------------------------------------------------------------------------

export type ConexaoGoogleDTO = {
  email: string;
  status: "connected" | "reauth_required" | "error";
  conectadaEm: string;
  ultimaSincronizacaoEm: string | null;
  ultimoErro: string | null;
  /** O Google avisa na hora (canal de push ativo); senão, polling a cada ~15 min. */
  avisoNaHora: boolean;
};

/** A conexão da pessoa logada (nunca a de outra, nem para o master). */
export async function minhaConexaoGoogle(): Promise<ConexaoGoogleDTO | null> {
  const ator = getActor();
  if (!ator || ator.system) return null;
  const c = await db().oAuthConnection.findFirst({
    where: { userId: ator.userId, provider: PROVEDOR_GOOGLE },
    select: {
      email: true,
      status: true,
      createdAt: true,
      ultimoErro: true,
      calendarios: { select: { ultimaSincronizacaoEm: true, ultimoErro: true, canalExpiraEm: true } },
    },
  });
  if (!c) return null;
  const s = c.calendarios[0];
  return {
    email: c.email,
    status: c.status,
    conectadaEm: c.createdAt.toISOString(),
    ultimaSincronizacaoEm: s?.ultimaSincronizacaoEm?.toISOString() ?? null,
    ultimoErro: c.ultimoErro ?? s?.ultimoErro ?? null,
    avisoNaHora: pushDaAgendaHabilitado() && Boolean(s?.canalExpiraEm && s.canalExpiraEm > new Date()),
  };
}

// ---------------------------------------------------------------------------
// Access token (renovação sob demanda)
// ---------------------------------------------------------------------------

export type ConexaoComToken = {
  id: string;
  teamId: string;
  userId: string;
  status: string;
  credentials: unknown;
  accessTokenExpiraEm: Date | null;
};

export class ConexaoGoogleInativa extends Error {
  constructor(status: string) {
    super(`ConexaoGoogleInativa: ${status}`);
    this.name = "ConexaoGoogleInativa";
  }
}

// Duas renovações ao mesmo tempo no mesmo processo viram uma só. Entre
// processos não há perigo: o Google não troca o refresh token a cada uso.
const renovando = new Map<string, Promise<string>>();

/** Access token válido da conexão; renova (e grava cifrado) quando está para vencer. */
export async function accessTokenDaConexao(c: ConexaoComToken): Promise<string> {
  if (c.status !== "connected") throw new ConexaoGoogleInativa(c.status);
  const cred = lerCredenciais(c.credentials);
  if (cred.accessToken && c.accessTokenExpiraEm && c.accessTokenExpiraEm.getTime() > Date.now() + 60_000) return cred.accessToken;
  const emCurso = renovando.get(c.id);
  if (emCurso) return emCurso;
  const p = renovar(c, cred).finally(() => renovando.delete(c.id));
  renovando.set(c.id, p);
  return p;
}

async function renovar(c: ConexaoComToken, cred: Credenciais): Promise<string> {
  if (!cred.refreshToken) {
    await marcarReautorizacao(c, "sem refresh token");
    throw new GoogleAutorizacaoInvalida("sem_refresh_token");
  }
  try {
    const t = await renovarAccessToken({ refreshToken: cred.refreshToken, ...clienteOAuth() });
    const credentials = encryptCredentials({ refreshToken: t.refreshToken ?? cred.refreshToken, accessToken: t.accessToken }) as unknown as Prisma.InputJsonValue;
    await runAsSystem(c.teamId, () =>
      db().oAuthConnection.update({ where: { id: c.id }, data: { credentials, accessTokenExpiraEm: t.expiraEm, falhas: 0 } }),
    );
    c.credentials = credentials;
    c.accessTokenExpiraEm = t.expiraEm;
    return t.accessToken;
  } catch (e) {
    if (e instanceof GoogleAutorizacaoInvalida) await marcarReautorizacao(c, "o Google recusou a autorização");
    throw e;
  }
}

/**
 * O Google recusou o refresh token: a conexão para de sincronizar (sem laço) e
 * a pessoa recebe UM aviso para reconectar (Web Push + selo em Integrações).
 */
export async function marcarReautorizacao(c: { id: string; teamId: string; userId: string }, motivo: string): Promise<void> {
  const { count } = await runAsSystem(c.teamId, async () => {
    const prisma = db();
    // A conta Google (sub) vem ANTES: a caixa de envio pelo Gmail dela vai para "erro" junto.
    const antes = await prisma.oAuthConnection.findFirst({ where: { id: c.id }, select: { externalAccountId: true } });
    const r = await prisma.oAuthConnection.updateMany({
      where: { id: c.id, status: "connected" },
      data: { status: "reauth_required", ultimoErro: motivo.slice(0, 200), ultimoErroEm: new Date() },
    });
    if (r.count === 1 && antes) await desligarContasGmail(prisma, [{ teamId: c.teamId, externalAccountId: antes.externalAccountId }], "error");
    return r;
  });
  if (count !== 1) return;
  logger.warn({ connectionId: c.id }, "[agenda-google] autorização recusada — sincronização parada até reconectar");
  // O aviso leva para uma tela que a pessoa TEM (a Agenda também tem o botão
  // "Reconectar"): quem só tem a Agenda não pode cair em "sem acesso".
  const u = await basePrisma.user.findUnique({ where: { id: c.userId }, select: { role: true, modulos: true } }).catch(() => null);
  const tela = !u || temModulo(u.role, u.modulos, "agenda") ? "/agenda" : "/integracoes";
  await runAsSystem(c.teamId, () =>
    enviarPush({ userIds: [c.userId] }, {
      titulo: "Reconecte sua Agenda Google",
      corpo: "O Google parou de aceitar a conexão. Abra a Agenda (ou Integrações) e clique em Reconectar. No modo de teste do Google isso acontece a cada 7 dias.",
      url: tela,
      tag: "agenda-google-reconectar",
    }),
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Desconectar / revogar (decisão 7)
// ---------------------------------------------------------------------------

/** O que é preciso para revogar no Google DEPOIS de apagar a linha (tokens em memória). */
export type ConexaoParaEncerrar = {
  id: string;
  teamId: string;
  /** `sub` da conta Google: acha a caixa `gmail_api` (`gmail:<sub>`) que sai junto. */
  externalAccountId: string;
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpiraEm: Date | null;
  canais: { id: string; resourceId: string }[];
  /** Linha da fila de revogação gravada junto com o delete (apagada quando o Google confirma). */
  revogacaoId?: string | null;
};

/** Espera da fila antes de tentar pela 1ª vez: o caminho normal revoga na hora e apaga a linha. */
const FOLGA_DA_FILA_MS = 2 * 60_000;

/**
 * Revogação DURÁVEL: grava o token (cifrado) na fila de revogação NA MESMA
 * TRANSAÇÃO que apaga a conexão. Se o processo cair (deploy, timeout) antes de
 * o Google ser avisado, o worker revoga depois — o token nunca some do banco
 * sem ter sido revogado. `tx`: a transação do basePrisma (teamId explícito) ou
 * a do time (o teamId é injetado; o mesmo valor passa).
 */
type TransacaoDoTime = Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0];

export async function guardarRevogacoes(
  cliente: Pick<Prisma.TransactionClient, "oAuthRevogacaoPendente"> | TransacaoDoTime,
  lista: ConexaoParaEncerrar[],
): Promise<void> {
  // Transação do basePrisma (equipe) ou a do time: a gravação é a mesma.
  const tx = cliente as Pick<Prisma.TransactionClient, "oAuthRevogacaoPendente">;
  for (const c of lista) {
    const token = c.refreshToken ?? c.accessToken;
    if (!token) continue;
    const r = await tx.oAuthRevogacaoPendente.create({
      data: {
        teamId: c.teamId,
        provider: PROVEDOR_GOOGLE,
        credentials: encryptCredentials({ token }) as unknown as Prisma.InputJsonValue,
        proximaEm: new Date(Date.now() + FOLGA_DA_FILA_MS),
      },
      select: { id: true },
    });
    c.revogacaoId = r.id;
  }
}

type ClienteDeLeitura = Pick<Prisma.TransactionClient, "oAuthConnection"> | TenantPrismaClient;

/** Lê as conexões (com os tokens decifrados, só em memória) para encerrar. */
export async function lerParaEncerrar(p: ClienteDeLeitura, where: Prisma.OAuthConnectionWhereInput): Promise<ConexaoParaEncerrar[]> {
  // Transação do basePrisma (equipe) ou o client do time: a consulta é a mesma.
  const rows = await (p as Pick<Prisma.TransactionClient, "oAuthConnection">).oAuthConnection.findMany({
    where,
    select: {
      id: true,
      teamId: true,
      externalAccountId: true,
      credentials: true,
      accessTokenExpiraEm: true,
      calendarios: { select: { canalId: true, canalResourceId: true } },
    },
  });
  return rows.map((r) => {
    const cred = lerCredenciais(r.credentials);
    return {
      id: r.id,
      teamId: r.teamId,
      externalAccountId: r.externalAccountId,
      refreshToken: cred.refreshToken ?? null,
      accessToken: cred.accessToken ?? null,
      accessTokenExpiraEm: r.accessTokenExpiraEm,
      canais: r.calendarios.flatMap((s) => (s.canalId && s.canalResourceId ? [{ id: s.canalId, resourceId: s.canalResourceId }] : [])),
    };
  });
}

/**
 * Apaga as conexões lidas (vínculos, estado da sincronização e blocos
 * "Ocupado" saem em cascata; os compromissos ficam) — junto, na mesma
 * transação, o token entra na fila de revogação — e, DEPOIS, avisa o Google:
 * para os canais de push e revoga o token (fora da transação: é rede).
 */
export async function encerrarConexoes(lista: ConexaoParaEncerrar[], opts: { jaApagadas?: boolean } = {}): Promise<{ revogadas: number; falhas: number }> {
  if (!opts.jaApagadas) {
    for (const c of lista) {
      await runAsSystem(c.teamId, () =>
        db().$transaction(async (tx) => {
          await guardarRevogacoes(tx, [c]);
          // A caixa de envio pelo Gmail sai de cena na MESMA transação (sem conexão, não envia).
          await desligarContasGmail(tx, [c], "disconnected");
          await tx.oAuthConnection.deleteMany({ where: { id: c.id } });
        }),
      );
    }
  }
  return revogarNoGoogle(lista);
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Para os canais de push e revoga o token no Google (3 tentativas). Nunca lança. */
export async function revogarNoGoogle(lista: ConexaoParaEncerrar[]): Promise<{ revogadas: number; falhas: number }> {
  let revogadas = 0;
  let falhas = 0;
  for (const c of lista) {
    // O canal só para com o token da própria pessoa: antes de revogar.
    if (c.canais.length) {
      try {
        let access = c.accessToken && c.accessTokenExpiraEm && c.accessTokenExpiraEm.getTime() > Date.now() + 30_000 ? c.accessToken : null;
        if (!access && c.refreshToken && googleAgendaConfigurada()) {
          access = (await renovarAccessToken({ refreshToken: c.refreshToken, ...clienteOAuth() })).accessToken;
        }
        if (access) for (const canal of c.canais) await pararCanal(access, canal).catch(() => {});
      } catch {
        /* o canal vence sozinho (até 7 dias); a rota de aviso ignora canal desconhecido */
      }
    }
    const token = c.refreshToken ?? c.accessToken;
    if (!token) continue;
    let ok = false;
    for (let tentativa = 0; tentativa < 3 && !ok; tentativa++) {
      try {
        await revogarToken(token);
        ok = true;
      } catch {
        if (tentativa < 2) await esperar(500 * 2 ** tentativa);
      }
    }
    if (ok) {
      revogadas++;
      // Revogou: a linha da fila (gravada junto com o delete) não é mais necessária.
      if (c.revogacaoId) {
        await runAsSystem(c.teamId, () => db().oAuthRevogacaoPendente.deleteMany({ where: { id: c.revogacaoId! } })).catch(() => {});
      }
    } else {
      falhas++;
      // Revogação DURÁVEL: a conexão já saiu; só o token (cifrado) fica na
      // fila até o Google confirmar (worker, tentativas limitadas).
      await runAsSystem(c.teamId, () =>
        c.revogacaoId
          ? db().oAuthRevogacaoPendente.update({
              where: { id: c.revogacaoId },
              data: { proximaEm: new Date(Date.now() + 5 * 60_000), ultimoErro: "o Google não confirmou a revogação" },
            })
          : db().oAuthRevogacaoPendente.create({
              data: {
                provider: PROVEDOR_GOOGLE,
                credentials: encryptCredentials({ token }) as unknown as Prisma.InputJsonValue,
                proximaEm: new Date(Date.now() + 5 * 60_000),
                ultimoErro: "o Google não confirmou a revogação",
              } as Prisma.OAuthRevogacaoPendenteUncheckedCreateInput,
            }),
      ).catch((e) => logger.error({ connectionId: c.id, err: e instanceof Error ? e.name : "erro" }, "[agenda-google] não guardei a revogação pendente"));
      logger.warn({ connectionId: c.id }, "[agenda-google] o Google não confirmou a revogação — fica na fila de revogação");
    }
  }
  return { revogadas, falhas };
}

/** Tentativas da revogação pendente antes de desistir (a linha sai com aviso no log). */
const MAX_TENTATIVAS_REVOGACAO = 10;

/**
 * Worker: tenta de novo as revogações que o Google não confirmou. Sucesso (ou
 * token já inválido) apaga a linha; depois de 10 tentativas (espera crescente
 * até 24 h) desiste e apaga também — o token não fica guardado para sempre.
 */
export async function processarRevogacoesPendentes(agora = new Date(), prazo = Number.POSITIVE_INFINITY): Promise<{ revogadas: number; desistencias: number }> {
  let revogadas = 0;
  let desistencias = 0;
  const rows = await basePrisma.oAuthRevogacaoPendente.findMany({
    where: { proximaEm: { lte: agora } },
    orderBy: { proximaEm: "asc" },
    take: 50,
    select: { id: true, teamId: true, credentials: true, tentativas: true },
  });
  for (const r of rows) {
    if (Date.now() > prazo) break;
    const token = (decryptCredentials(r.credentials) as { token?: string } | null)?.token;
    const apagar = () => runAsSystem(r.teamId, () => db().oAuthRevogacaoPendente.deleteMany({ where: { id: r.id } }));
    if (!token) {
      await apagar();
      continue;
    }
    try {
      await revogarToken(token);
      await apagar();
      revogadas++;
    } catch (e) {
      const tentativas = r.tentativas + 1;
      if (tentativas >= MAX_TENTATIVAS_REVOGACAO) {
        await apagar();
        desistencias++;
        logger.warn({ revogacaoId: r.id }, "[agenda-google] desisti de revogar no Google depois de 10 tentativas (token apagado)");
        continue;
      }
      const espera = Math.min(24 * 60, 5 * 2 ** tentativas) * 60_000;
      await runAsSystem(r.teamId, () =>
        db().oAuthRevogacaoPendente.update({
          where: { id: r.id },
          data: { tentativas, ultimoErro: e instanceof GoogleApiErro ? e.message.slice(0, 200) : e instanceof Error ? e.name : "erro", proximaEm: new Date(agora.getTime() + espera) },
        }),
      );
    }
  }
  return { revogadas, desistencias };
}

/**
 * "Desconectar minha Agenda Google": revoga no Google e apaga a conexão.
 * Revogar o consentimento tem de ser tão fácil quanto dar (LGPD): NÃO depende
 * de papel nem de tela — quem virou "só leitura" ou perdeu a Agenda e as
 * Integrações desconecta pelo menu da conta. Basta ser uma pessoa (não o
 * sistema), e só a PRÓPRIA conexão (filtro userId = eu).
 */
export async function desconectarGoogle(): Promise<{ desconectada: boolean }> {
  const ator = getActor();
  if (!ator || ator.system) throw new ForbiddenError();
  const lista = await lerParaEncerrar(db(), { userId: ator.userId, provider: PROVEDOR_GOOGLE });
  if (!lista.length) return { desconectada: false };
  await encerrarConexoes(lista);
  logger.info({ userId: ator.userId }, "[agenda-google] agenda desconectada pela pessoa");
  return { desconectada: true };
}
