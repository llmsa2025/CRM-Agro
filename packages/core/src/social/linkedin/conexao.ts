import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "@crmagro/config";
import { db, decryptCredentials, encryptCredentials, getCurrentModulos, tenantData } from "@crmagro/db";
import { ForbiddenError, getActor, requireCan } from "../../auth/authz";
import { temModulo } from "../../auth/modulos";
import { logger } from "../../logger/index";
import { ESCOPO_PUBLICAR, ESCOPOS_LINKEDIN, LINKEDIN_AUTH_URL, lerPerfil, revogarToken, trocarCodigo } from "./cliente";

/**
 * Conexão do LinkedIn oficial POR PESSOA: entrar com o LinkedIn e publicar no perfil da própria pessoa.
 *
 * - App LinkedIn próprio (LINKEDIN_CLIENT_ID/SECRET). Sem as variáveis, nada aparece (fail-soft).
 * - Cada pessoa conecta o PRÓPRIO perfil (ação `conexao.propria`, nível membro), pela tela Integrações.
 * - `state` assinado (HMAC do AUTH_SECRET) amarrado à sessão (pessoa + time) e a um nonce guardado em
 *   cookie httpOnly do navegador. Sem o cookie, a volta é recusada (anti-CSRF).
 * - O token (cifrado com `encryptCredentials`) fica na conta de canal `linkedin_official`. Nunca sai do
 *   servidor, nunca vai para log, job ou tela. O LinkedIn não dá refresh token: o token vale cerca de
 *   60 dias e a pessoa reconecta.
 * - Uma conta de LinkedIn por pessoa, e o mesmo LinkedIn não fica em duas pessoas (recusa, não transfere).
 *
 * Escopo mínimo: identidade (openid, profile, email) e `w_member_social` (publicar). Mensagem, convite e
 * leitura da caixa NÃO existem neste caminho oficial (a API é restrita a parceiros).
 */

export const PROVEDOR_LINKEDIN = "linkedin_official" as const;
/** `ChannelAccount.externalId`: uma conta por perfil (`sub` do OpenID), única por provedor. */
export const externalIdDoLinkedin = (sub: string) => `linkedin:${sub}`;
/** O `state` vale 10 minutos (tempo de a pessoa passar pela tela do LinkedIn). */
const VALIDADE_STATE_MS = 10 * 60_000;
/** Aviso de "vence logo": a tela chama a atenção quando faltam 7 dias ou menos. */
export const DIAS_DO_AVISO_DE_VENCIMENTO = 7;

export class LinkedinIndisponivel extends Error {
  constructor() {
    super("LinkedinIndisponivel: a integração com o LinkedIn não está configurada neste servidor.");
    this.name = "LinkedinIndisponivel";
  }
}
/** `state` adulterado, vencido, de outra pessoa ou sem o cookie do início. */
export class EstadoLinkedinInvalido extends Error {
  constructor(motivo: string) {
    super(`EstadoLinkedinInvalido: ${motivo}`);
    this.name = "EstadoLinkedinInvalido";
  }
}
/** A pessoa desmarcou a permissão de publicar na tela do LinkedIn. */
export class PermissaoDePublicarNegada extends Error {
  constructor() {
    super("PermissaoDePublicarNegada: o LinkedIn não liberou a permissão de publicar. Conecte de novo e marque a permissão.");
    this.name = "PermissaoDePublicarNegada";
  }
}
/** O mesmo perfil de LinkedIn já está conectado por OUTRA pessoa (não transfere em silêncio). */
export class LinkedinDeOutraPessoa extends Error {
  constructor() {
    super("LinkedinDeOutraPessoa: este perfil do LinkedIn já está conectado por outra pessoa no CRM Agro.");
    this.name = "LinkedinDeOutraPessoa";
  }
}
/** O token vencido (60 dias) ou revogado: a pessoa precisa conectar de novo. */
export class LinkedinTokenExpirado extends Error {
  constructor() {
    super("LinkedinTokenExpirado: a conexão com o LinkedIn venceu. Conecte o LinkedIn de novo.");
    this.name = "LinkedinTokenExpirado";
  }
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/** A integração está configurada (as duas variáveis do app)? */
export function linkedinConfigurado(): boolean {
  return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);
}

function clienteOAuth(): { clientId: string; clientSecret: string } {
  const clientId = env.LINKEDIN_CLIENT_ID;
  const clientSecret = env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new LinkedinIndisponivel();
  return { clientId, clientSecret };
}

/** URL de retorno do OAuth: a MESMA cadastrada no app do LinkedIn. */
export function urlDeRetornoLinkedin(): string {
  if (env.LINKEDIN_REDIRECT_URI) return env.LINKEDIN_REDIRECT_URI;
  const base = (env.AUTH_URL ?? env.APP_PUBLIC_URL)?.replace(/\/+$/, "");
  if (!base) throw new LinkedinIndisponivel();
  return `${base}/api/integracoes/linkedin/callback`;
}

// ---------------------------------------------------------------------------
// state assinado
// ---------------------------------------------------------------------------

export type VoltaLinkedin = "canais" | "integracoes";
type DadosDoEstado = { u: string; t: string; n: string; e: number; v: VoltaLinkedin };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
// Prefixo próprio: o `state` do Google não vale aqui (e o daqui não vale lá).
const assinatura = (payload: string) => createHmac("sha256", `crmagro-linkedin-state:${env.AUTH_SECRET}`).update(payload).digest();

export function assinarEstado(dados: DadosDoEstado): string {
  const payload = b64url(JSON.stringify(dados));
  return `${payload}.${b64url(assinatura(payload))}`;
}

/**
 * Confere o `state` do retorno: assinatura (tempo constante), validade e que é da MESMA pessoa/time da
 * sessão e do MESMO navegador (nonce do cookie).
 */
export function verificarEstado(state: string, esperado: { userId: string; teamId: string; nonce: string | null | undefined }, agora = Date.now()): DadosDoEstado {
  const [payload, sig] = String(state ?? "").split(".");
  if (!payload || !sig) throw new EstadoLinkedinInvalido("formato");
  const recebida = Buffer.from(sig, "base64url");
  const certa = assinatura(payload);
  if (recebida.length !== certa.length || !timingSafeEqual(recebida, certa)) throw new EstadoLinkedinInvalido("assinatura");
  let dados: DadosDoEstado;
  try {
    dados = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DadosDoEstado;
  } catch {
    throw new EstadoLinkedinInvalido("conteúdo");
  }
  if (typeof dados.e !== "number" || dados.e < agora) throw new EstadoLinkedinInvalido("vencido");
  if (dados.u !== esperado.userId || dados.t !== esperado.teamId) throw new EstadoLinkedinInvalido("outra pessoa");
  const nonce = Buffer.from(String(esperado.nonce ?? ""));
  const doEstado = Buffer.from(String(dados.n ?? ""));
  if (!esperado.nonce || nonce.length !== doEstado.length || !timingSafeEqual(nonce, doEstado)) throw new EstadoLinkedinInvalido("navegador");
  return dados;
}

// ---------------------------------------------------------------------------
// Quem pode
// ---------------------------------------------------------------------------

/** Conexão PRÓPRIA: papel de membro e a tela Integrações. Nunca o sistema (a conexão é de uma pessoa). */
export function exigirConexaoPropriaLinkedin() {
  const ator = requireCan("conexao.propria");
  if (ator.system) throw new ForbiddenError();
  if (!temModulo(ator.role, getCurrentModulos(), "integracoes")) throw new ForbiddenError();
  return ator;
}

/** A pessoa logada pode CONECTAR o LinkedIn (sem lançar; a tela esconde o botão para quem não pode)? */
export function podeConectarLinkedin(): boolean {
  try {
    exigirConexaoPropriaLinkedin();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Início e fim do OAuth
// ---------------------------------------------------------------------------

/** Monta a URL de autorização do LinkedIn. Devolve também o `nonce`, que a rota guarda num cookie httpOnly. */
export function iniciarConexaoLinkedin(opts: { volta?: VoltaLinkedin } = {}): { url: string; nonce: string } {
  const ator = exigirConexaoPropriaLinkedin();
  const { clientId } = clienteOAuth();
  const nonce = b64url(randomBytes(24));
  const state = assinarEstado({
    u: ator.userId,
    t: ator.teamId,
    n: nonce,
    e: Date.now() + VALIDADE_STATE_MS,
    v: opts.volta === "integracoes" ? "integracoes" : "canais",
  });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: urlDeRetornoLinkedin(),
    state,
    scope: ESCOPOS_LINKEDIN.join(" "),
  });
  return { url: `${LINKEDIN_AUTH_URL}?${q.toString()}`, nonce };
}

/**
 * Retorno do LinkedIn: confere o `state`, troca o `code`, confere que a permissão de publicar foi
 * concedida e grava a conta `linkedin_official` com o token CIFRADO. ANTES de gravar, recusa o perfil
 * que já é de outra pessoa.
 */
export async function concluirConexaoLinkedin(input: {
  code: string;
  state: string;
  nonce: string | null | undefined;
}): Promise<{ volta: VoltaLinkedin; nome: string }> {
  const ator = exigirConexaoPropriaLinkedin();
  const prisma = db(); // no início, antes de qualquer await (AGENTS.md §12)
  const dados = verificarEstado(input.state, { userId: ator.userId, teamId: ator.teamId, nonce: input.nonce });
  if (!input.code || input.code.length > 1024) throw new EstadoLinkedinInvalido("code");
  const cliente = clienteOAuth();
  const tokens = await trocarCodigo({ code: input.code, redirectUri: urlDeRetornoLinkedin(), ...cliente });
  if (!tokens.escopos.includes(ESCOPO_PUBLICAR)) throw new PermissaoDePublicarNegada();
  const perfil = await lerPerfil(tokens.accessToken);
  const externalId = externalIdDoLinkedin(perfil.sub);

  const credentials = encryptCredentials({ accessToken: tokens.accessToken }) as unknown as Prisma.InputJsonValue;
  const meta = {
    nome: perfil.nome,
    email: perfil.email,
    escopos: tokens.escopos,
    conectadoEm: new Date().toISOString(),
    expiraEm: tokens.expiraEm.toISOString(),
  } satisfies Prisma.InputJsonObject;
  const dadosDaConta = { externalId, label: perfil.nome, status: "connected" as const, credentials, meta, ownerId: ator.userId, desconectadaEm: null };

  // Tudo abaixo é ATÔMICO (duas voltas ao mesmo tempo não se atropelam): o dono entra no filtro da escrita e a
  // chave única (provider, externalId) decide quem fica com o perfil. Nunca "lê, depois escreve".
  try {
    // 1) O perfil já é desta pessoa (ou é de uma conta sem dono, do mesmo time): atualiza. O perfil de OUTRA
    //    pessoa não casa com o filtro, então o dono nunca é trocado.
    const doPerfil = await prisma.channelAccount.updateMany({
      where: { canal: "linkedin", provider: PROVEDOR_LINKEDIN, externalId, OR: [{ ownerId: ator.userId }, { ownerId: null }] },
      data: dadosDaConta,
    });
    if (doPerfil.count === 0) {
      // 2) A pessoa troca de perfil: a conta que ela já tem passa para o perfil novo (uma conta por pessoa).
      const minha = await prisma.channelAccount.findFirst({
        where: { canal: "linkedin", provider: PROVEDOR_LINKEDIN, ownerId: ator.userId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const trocou = minha
        ? await prisma.channelAccount.updateMany({ where: { id: minha.id, ownerId: ator.userId }, data: dadosDaConta })
        : { count: 0 };
      // 3) Primeira conta da pessoa. Se o perfil já existe em outra pessoa (ou em outro time), a chave única recusa.
      if (trocou.count === 0) {
        await prisma.channelAccount.create({
          data: tenantData<Prisma.ChannelAccountUncheckedCreateInput>({ canal: "linkedin", provider: PROVEDOR_LINKEDIN, ...dadosDaConta }),
        });
      }
    }
  } catch (e) {
    // Sob RLS o `meta.target` do erro vem vazio: só o código decide.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new LinkedinDeOutraPessoa();
    throw e;
  }
  await manterUmaContaPorPessoa(prisma, ator.userId);
  logger.info({ userId: ator.userId }, "[linkedin] conta conectada");
  return { volta: dados.v, nome: perfil.nome };
}

/**
 * Uma conta de LinkedIn por pessoa. Duas voltas ao mesmo tempo (dois perfis) podem criar duas linhas antes de uma
 * ver a outra: sobra a mais nova (desempate pelo id, igual para as duas voltas) e a outra é desconectada, sem
 * token. Sem corrida, só existe uma linha e isto não faz nada.
 */
async function manterUmaContaPorPessoa(prisma: ReturnType<typeof db>, ownerId: string): Promise<void> {
  const minhas = await prisma.channelAccount.findMany({
    where: { canal: "linkedin", provider: PROVEDOR_LINKEDIN, ownerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (minhas.length <= 1) return;
  await prisma.channelAccount.updateMany({
    where: { id: { in: minhas.slice(1).map((c) => c.id) }, ownerId },
    data: { status: "disconnected", credentials: Prisma.DbNull, desconectadaEm: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Validade e token
// ---------------------------------------------------------------------------

type MetaDoLinkedin = { expiraEm?: unknown };

/** Quando o token do LinkedIn vence, pelo `meta` da conta (ISO), ou `null` se não consta. */
export function expiracaoDoLinkedin(meta: unknown): Date | null {
  const v = (meta as MetaDoLinkedin | null)?.expiraEm;
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Dias que faltam para vencer, ou `null` sem data. Menos de 1 dia = 0 (vence hoje); depois, arredonda para
 * CIMA (uma conexão recém-feita, com 59,99 dias, mostra 60). Já vencida = número negativo.
 */
export function diasParaVencerLinkedin(meta: unknown, agora = Date.now()): number | null {
  const d = expiracaoDoLinkedin(meta);
  if (!d) return null;
  const falta = d.getTime() - agora;
  if (falta <= 0) return Math.floor(falta / 86_400_000) || -1;
  return falta < 86_400_000 ? 0 : Math.ceil(falta / 86_400_000);
}

/**
 * O que a linha da conta diz sobre a validade da conexão: `ok`, `vence_logo` (faltam 7 dias ou menos),
 * `vencida` (a pessoa precisa conectar de novo) ou `desconhecida` (conta antiga, sem data).
 */
export function situacaoDaValidade(meta: unknown, agora = Date.now()): { estado: "ok" | "vence_logo" | "vencida" | "desconhecida"; dias: number | null } {
  const dias = diasParaVencerLinkedin(meta, agora);
  if (dias === null) return { estado: "desconhecida", dias };
  if (dias < 0) return { estado: "vencida", dias };
  if (dias <= DIAS_DO_AVISO_DE_VENCIMENTO) return { estado: "vence_logo", dias };
  return { estado: "ok", dias };
}

/**
 * O token e o autor (`urn:li:person:<sub>`) da conta, para publicar. Dentro do contexto do time (o worker
 * usa `runAsSystem`). Token vencido: marca a conta como `error` (a tela pede para conectar de novo) e lança
 * `LinkedinTokenExpirado`. Sem token (conta desconectada) = o mesmo erro.
 */
export async function lerTokenDoLinkedin(channelAccountId: string, agora = Date.now()): Promise<{ accessToken: string; autorUrn: string; ownerId: string | null }> {
  const ator = getActor();
  const prisma = db();
  const conta = await prisma.channelAccount.findUnique({
    where: { id: channelAccountId },
    select: { id: true, canal: true, provider: true, status: true, externalId: true, credentials: true, meta: true, ownerId: true, updatedAt: true },
  });
  if (!conta || conta.provider !== PROVEDOR_LINKEDIN || !conta.externalId?.startsWith("linkedin:")) throw new LinkedinTokenExpirado();
  // Só o DONO da conta usa o token (decisão D3: o administrador vê o estado, mas não publica pela conta de outra
  // pessoa). O motor (contexto de sistema) roda os fluxos do time, que já decidem de quem é a conta. Sem ator = nega.
  if (!ator || (!ator.system && ator.userId !== conta.ownerId)) throw new ForbiddenError();
  const venceEm = expiracaoDoLinkedin(conta.meta);
  const token = (decryptCredentials(conta.credentials) as { accessToken?: string } | null)?.accessToken;
  if (conta.status !== "connected" || !token) throw new LinkedinTokenExpirado();
  if (venceEm && venceEm.getTime() <= agora) {
    // Amarrado à versão lida: se a pessoa reconectou nesse meio tempo, a conexão nova não é marcada com erro.
    await prisma.channelAccount.updateMany({ where: { id: conta.id, updatedAt: conta.updatedAt }, data: { status: "error" } });
    throw new LinkedinTokenExpirado();
  }
  return { accessToken: token, autorUrn: `urn:li:person:${conta.externalId.slice("linkedin:".length)}`, ownerId: conta.ownerId };
}

/**
 * O LinkedIn recusou o token (401: revogado pela pessoa ou invalidado): a conta vira `error` para a tela pedir
 * a reconexão. Chamada por quem publicou e levou 401.
 */
export async function marcarLinkedinParaReconectar(channelAccountId: string): Promise<void> {
  await db().channelAccount.updateMany({ where: { id: channelAccountId, provider: PROVEDOR_LINKEDIN }, data: { status: "error" } });
}

// ---------------------------------------------------------------------------
// Desconectar
// ---------------------------------------------------------------------------

/**
 * Desconecta o LinkedIn: revoga o token (melhor esforço) e apaga o token da conta. A conta fica como
 * `disconnected`, para o histórico de posts continuar ligado a ela. Só o dono (ou quem administra as
 * conexões do time) desconecta.
 */
export async function desconectarLinkedin(channelAccountId: string): Promise<void> {
  const ator = requireCan("conexao.propria");
  const prisma = db();
  const conta = await prisma.channelAccount.findUnique({
    where: { id: channelAccountId },
    select: { id: true, provider: true, ownerId: true, credentials: true, updatedAt: true },
  });
  if (!conta || conta.provider !== PROVEDOR_LINKEDIN) throw new ForbiddenError();
  const ehDono = !ator.system && conta.ownerId === ator.userId;
  if (!ehDono) requireCan("integrations.manage");
  const token = (decryptCredentials(conta.credentials) as { accessToken?: string } | null)?.accessToken;
  // Primeiro apaga o token daqui, amarrado à versão que foi lida: se a pessoa reconectou no meio, o token novo
  // NÃO é apagado (a conexão nova vale) e nada é revogado.
  const limpou = await prisma.channelAccount.updateMany({
    where: { id: conta.id, updatedAt: conta.updatedAt },
    data: { status: "disconnected", credentials: Prisma.DbNull, desconectadaEm: new Date() },
  });
  if (limpou.count === 0) return;
  // Só então revoga no LinkedIn (melhor esforço), o token que acabou de sair daqui.
  if (token && linkedinConfigurado()) {
    try {
      await revogarToken({ token, ...clienteOAuth() });
    } catch (e) {
      // O token vence sozinho em até 60 dias; não impede desconectar.
      logger.warn({ err: e instanceof Error ? e.name : "erro" }, "[linkedin] não consegui revogar o token");
    }
  }
}

/** A pessoa logada é a dona da conta (útil para a tela decidir o que mostrar)? */
export function souDonoDaConta(ownerId: string | null): boolean {
  const ator = getActor();
  return Boolean(ator && !ator.system && ownerId && ator.userId === ownerId);
}
