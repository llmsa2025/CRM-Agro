import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { basePrisma, db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { enviarEmailDoSistema } from "../email/sistema";
import { ehEmailSimples } from "../email/endereco";
import { modeloConvite } from "../email/modelos";
import { LimiteDaPlataforma, erroParaLog, mascararEmail, plataformaConfigurada, rodapeDeResposta } from "../email/plataforma";
import { logger } from "../logger/index";
import { env } from "@crmagro/config";
import { ForbiddenError, requireRole, isRole, type Role } from "./authz";
import { normalizarEditarTudoEm, normalizarModulos, normalizarVerTudoEm } from "./modulos";
import { rateLimit } from "../rate-limit/service";

/**
 * E-mail que já é do PRÓPRIO time não recebe convite (auditoria S9; e-mail de
 * outro time segue como um qualquer desde a auditoria do #52).
 * Antes, o convite para o e-mail do DONO deixava o admin que convidou abrir o
 * link, definir uma senha nova e entrar como dono. Quem já tem conta usa
 * "esqueci a senha", que vai para o e-mail real.
 */
export class EmailJaCadastrado extends Error {
  constructor(email: string) {
    super(`EmailJaCadastrado: ${email} já faz parte do seu time. Se esqueceu a senha, use "Esqueci a senha".`);
    this.name = "EmailJaCadastrado";
  }
}

/** Tentativas de aceite por IP (quando o chamador informa o IP). */
const ACEITE_POR_IP = { max: 10, janelaMs: 15 * 60 * 1000 };

/**
 * E-mails de convite por time por hora pelo remetente da PLATAFORMA: um time
 * não manda convite em massa (nem suja o domínio). Não basta sozinho — qualquer
 * conta Google cria um time —, então o remetente ainda tem o teto por
 * destinatário, o teto diário dos convites (45% do dia) e o teto diário da
 * plataforma (`enviarEmailDaPlataforma`). Passou de qualquer um, o convite é
 * criado igual e o link aparece para copiar.
 */
const CONVITES_POR_HORA_PELA_PLATAFORMA = 30;

/**
 * Convites (signup POR CONVITE — não self-service).
 *
 * Decisão do dono: criar conta por e-mail/senha só acontece a partir de um
 * convite emitido por um time. O Google é a única porta self-service (cria time).
 *
 * Segurança:
 * - Token com HASH (sha256) + prefixo visível (padrão relay/tokens.ts). Texto
 *   puro só no link enviado; nunca no banco/log.
 * - Emissão é tenant-scoped (`db()`/`tenantData`) — o convite pertence ao time
 *   da sessão. O aceite roda SEM sessão e resolve o time pelo próprio convite
 *   (hash único), NUNCA por input do usuário — não há como entrar em outro time.
 * - Expiração + revogação; e-mail já vinculado a OUTRO time é rejeitado (não
 *   re-tenanteia um usuário existente).
 */

/** Validade do convite: 7 dias. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_PREFIX = "inv_";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return INVITE_PREFIX + randomBytes(32).toString("base64url");
}

function publicBaseUrl(): string | null {
  return env.AUTH_URL ?? env.APP_PUBLIC_URL ?? null;
}

export type InviteDTO = {
  id: string;
  email: string;
  role: string;
  tokenPrefix: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type CreatedInvite = {
  id: string;
  email: string;
  /** Texto puro do token — exibido/enviado UMA vez, não recuperável depois. */
  token: string;
  link: string | null;
  /** true se o e-mail de convite saiu (remetente da plataforma ou, sem ele, caixa do time). */
  emailSent: boolean;
  /** Por que o e-mail NÃO saiu (só com `emailSent` false): a tela explica cada caso. */
  emailMotivo?: MotivoSemEmail;
};

/**
 * Por que o e-mail do convite não saiu:
 * - `sem-caixa`: sem remetente da plataforma e sem caixa conectada no time;
 * - `limite`: passou do limite de convites por hora do time ou de um teto do
 *   remetente da plataforma (destinatário, dia);
 * - `falhou`: o envio deu erro (SMTP recusou, remetente inválido etc.; o
 *   motivo técnico fica no log).
 */
export type MotivoSemEmail = "sem-caixa" | "limite" | "falhou";

/** Papéis que um convite pode conceder. `owner` NÃO é convidável (transferência
 * de posse é fluxo à parte, fora do escopo R0→R3). */
const INVITABLE_ROLES: readonly Role[] = ["admin", "member", "viewer"];

/**
 * Cria um convite para um e-mail entrar no time da sessão (tenant-scoped) e
 * tenta enviar o e-mail com o link. Retorna o token puro uma única vez.
 *
 * RBAC (R2/R3): exige papel `admin+` (fail-closed via requireRole) e grava o
 * papel (`role`, default `member`) que o convidado assume ao aceitar. Não é
 * possível convidar como `owner`.
 */
export async function createInvite(input: {
  email: string;
  role?: string;
  invitedByUserId?: string;
  /** Telas em que o convidado verá os registros de todos ("ver tudo" por tela). */
  verTudoEm?: string[];
  /** Telas em que também vai ALTERAR os registros de todos (dentro de `verTudoEm`). */
  editarTudoEm?: string[];
  /** Para convite de administrador: o que ele pode fazer com a equipe (só o master escolhe). */
  permissoesEquipe?: string[];
  /** Telas liberadas (F2b); vazio = padrão do papel. */
  modulos?: string[];
}): Promise<CreatedInvite> {
  // Enforce RBAC no INÍCIO (camada de serviço = segurança real, fail-closed).
  const actor = requireRole("admin");
  // Administrador só convida se o master liberou "convidar" (lido do banco).
  if (actor.role === "admin" && !actor.system) {
    const eu = await basePrisma.user.findFirst({ where: { id: actor.userId, teamId: actor.teamId, desativadoEm: null }, select: { permissoesEquipe: true } });
    if (!eu?.permissoesEquipe.includes("convidar")) throw new ForbiddenError();
  }

  // UM endereço simples (sem lista, nome, grupo ou texto livre): o campo vai
  // como destinatário do e-mail e para dentro do corpo (ver email/endereco.ts).
  const email = input.email.trim().toLowerCase();
  if (!ehEmailSimples(email)) throw new Error("e-mail inválido");

  // Papel do convite: default member; rejeita valores desconhecidos e `owner`.
  const role = input.role ?? "member";
  if (!isRole(role) || !INVITABLE_ROLES.includes(role)) {
    throw new Error("papel inválido para convite");
  }
  // Convidar alguém como administrador e escolher o que ele faz com a equipe é
  // decisão do master (dono): o administrador convida membros e só leitura.
  if (role === "admin" && actor.role !== "owner" && !actor.system) throw new ForbiddenError();
  const permissoesEquipe =
    role === "admin" ? [...new Set(input.permissoesEquipe ?? [])].filter((p) => ["convidar", "desativar", "excluir"].includes(p)) : [];
  // Telas (F2b): só módulos conhecidos; administrador vê todas (lista vazia).
  const modulos = role === "admin" ? [] : normalizarModulos(input.modulos ?? []);
  // "Ver tudo" por tela: só telas com dono; administrador já vê tudo.
  const verTudoEm = role === "admin" ? [] : normalizarVerTudoEm(input.verTudoEm ?? []);
  const editarTudoEm = role === "admin" ? [] : normalizarEditarTudoEm(input.editarTudoEm ?? [], verTudoEm);

  // S9: quem já é do PRÓPRIO time não é convidado de novo (mensagem clara para
  // o admin). E-mail com conta em OUTRO time segue como um e-mail qualquer: a
  // resposta não pode revelar que ele é usuário da plataforma (enumeração entre
  // times — auditoria do #52). É seguro: o aceite nunca troca a senha de conta
  // existente nem muda alguém de time (volta `email_in_other_team`).
  const jaExiste = await basePrisma.user.findUnique({ where: { email }, select: { teamId: true } });
  if (jaExiste && jaExiste.teamId === getCurrentTeamId()) throw new EmailJaCadastrado(email);

  const token = generateToken();
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, 8);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const row = await db().invite.create({
    data: tenantData<Prisma.InviteUncheckedCreateInput>({
      email,
      role,
      verTudoEm,
      editarTudoEm,
      permissoesEquipe,
      modulos,
      tokenHash,
      tokenPrefix,
      expiresAt,
      ...(input.invitedByUserId ? { invitedByUserId: input.invitedByUserId } : {}),
    }),
    select: { id: true, email: true },
  });

  const base = publicBaseUrl();
  const link = base ? `${base.replace(/\/$/, "")}/criar-conta?token=${encodeURIComponent(token)}` : null;

  const envio = link ? await enviarConvitePorEmail(email, link, input.invitedByUserId) : { enviado: false as const };

  return {
    id: row.id,
    email: row.email,
    token,
    link,
    emailSent: envio.enviado,
    ...(!envio.enviado && envio.motivo ? { emailMotivo: envio.motivo } : {}),
  };
}

/**
 * Manda o e-mail do convite. Plataforma configurada: só por ela (nunca pela
 * caixa de uma pessoa do time); sem ela, pela caixa do time, como antes. Falha
 * de envio NÃO derruba o convite (já gravado): volta `enviado: false` com o
 * motivo, e a tela mostra o link para copiar — antes o erro do SMTP escondia o
 * link, que só aparece uma vez.
 */
async function enviarConvitePorEmail(
  email: string,
  link: string,
  invitedByUserId?: string,
): Promise<{ enviado: boolean; motivo?: MotivoSemEmail }> {
  const teamId = getCurrentTeamId();
  try {
    if (plataformaConfigurada() && teamId) {
      const rl = await rateLimit(`convite:email:${teamId}`, CONVITES_POR_HORA_PELA_PLATAFORMA, 60 * 60 * 1000);
      if (!rl.allowed) {
        logger.warn({ teamId, para: mascararEmail(email) }, "[convite] limite de e-mails de convite por hora: só o link");
        return { enviado: false, motivo: "limite" };
      }
    }
    // Nome do time e de quem convidou, para o e-mail dizer de onde vem o convite.
    const [time, quem] = await Promise.all([
      teamId ? basePrisma.team.findUnique({ where: { id: teamId }, select: { name: true } }) : null,
      invitedByUserId && teamId
        ? basePrisma.user.findFirst({ where: { id: invitedByUserId, teamId }, select: { name: true } })
        : null,
    ]);
    const mensagem = modeloConvite({
      email,
      link,
      validadeDias: Math.round(INVITE_TTL_MS / (24 * 60 * 60 * 1000)),
      nomeDoTime: time?.name,
      quemConvidou: quem?.name,
      resposta: rodapeDeResposta(),
    });
    // Mesma sessão → contexto de tenancy ativo (preciso só no envio legado).
    const r = await enviarEmailDoSistema({ to: email, ...mensagem, tipo: "convite" });
    if (r.enviado) return { enviado: true };
    return { enviado: false, motivo: r.via === "nenhuma" ? "sem-caixa" : "falhou" };
  } catch (e) {
    logger.warn({ para: mascararEmail(email), err: erroParaLog(e) }, "[convite] e-mail não saiu: só o link");
    return { enviado: false, motivo: e instanceof LimiteDaPlataforma ? "limite" : "falhou" };
  }
}

/**
 * Convites que ainda NÃO viraram integrante: os pendentes e o histórico
 * (revogados/expirados). O convite ACEITO fica de fora — a pessoa já aparece
 * em Integrantes, e listá-lo de novo em "Convites" era redundante (ajuste do
 * dono, 28/09). A tela separa pendente × histórico pelas datas.
 */
export async function listInvites(): Promise<InviteDTO[]> {
  // Convites pendentes (e-mails de fora) só para quem cuida da equipe.
  requireRole("admin");
  const rows = await db().invite.findMany({
    where: { acceptedAt: null },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      email: true,
      role: true,
      tokenPrefix: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  return rows;
}

/** Revoga um convite (soft, revokedAt). Tenant-scoped — só afeta o próprio time.
 * RBAC (R2): exige `admin+` (fail-closed). */
export async function revokeInvite(id: string): Promise<void> {
  const actor = requireRole("admin");
  // Administrador revoga só se o master liberou "convidar" (mesma porta de convidar).
  if (actor.role === "admin" && !actor.system) {
    const eu = await basePrisma.user.findFirst({ where: { id: actor.userId, teamId: actor.teamId, desativadoEm: null }, select: { permissoesEquipe: true } });
    if (!eu?.permissoesEquipe.includes("convidar")) throw new ForbiddenError();
  }
  await db().invite.updateMany({
    where: { id, revokedAt: null, acceptedAt: null },
    data: { revokedAt: new Date() },
  });
}

export type InviteCheck = { valid: boolean; email?: string; teamName?: string };

/**
 * Verifica um convite apresentado (SEM sessão) para a tela de criar conta.
 * Cross-team via `basePrisma`. Não revela nada além do e-mail/nome do time.
 */
export async function verifyInvite(rawToken: string): Promise<InviteCheck> {
  const token = rawToken?.trim();
  if (!token) return { valid: false };
  const row = await basePrisma.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, expiresAt: true, acceptedAt: true, revokedAt: true, team: { select: { name: true } } },
  });
  if (!row || row.acceptedAt || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
    return { valid: false };
  }
  return { valid: true, email: row.email, teamName: row.team.name };
}

export type AcceptInviteResult =
  | { ok: true; userId: string; teamId: string; email: string }
  | { ok: false; reason: "invalid" | "email_in_other_team" | "email_ja_cadastrado" | "rate_limited" | "senha_curta" };

/** Tamanho mínimo da senha nas telas de conta (criar conta, redefinir senha). */
export const SENHA_MIN = 8;

/** Calcula o hash da senha (o `bcryptjs` mora no app web e é injetado aqui). */
export type HashDeSenha = (senha: string) => Promise<string>;

/**
 * Aceita um convite (SEM sessão): cria o usuário no time que convidou e marca o
 * convite como aceito. O `passwordHash` já vem calculado pelo app web (bcrypt
 * mora lá). Cross-team via `basePrisma`, resolvendo o time pelo convite — nunca
 * por input do usuário.
 *
 * Auditoria S9:
 * - NUNCA sobrescreve a senha de usuário existente (antes: "usuário já existe no
 *   time: só define a senha" — era a porta para o admin virar dono). Quem já tem
 *   conta recebe `email_ja_cadastrado` e usa "esqueci a senha".
 * - Aceite ATÔMICO: o convite é "reservado" com `updateMany(acceptedAt: null)` e
 *   só um aceite ganha, mesmo com dois cliques/abas ao mesmo tempo. A criação do
 *   usuário vai na mesma transação (convite nunca fica gasto sem usuário).
 * - `opts.ip`: se informado, limita tentativas por IP (S8).
 */
export async function acceptInvite(
  rawToken: string,
  input: { name: string; passwordHash: string },
  opts: { ip?: string | null } = {},
): Promise<AcceptInviteResult> {
  const token = rawToken?.trim();
  if (!token || !input.passwordHash) return { ok: false, reason: "invalid" };
  if (opts.ip) {
    const rl = await rateLimit(`auth:convite:ip:${opts.ip}`, ACEITE_POR_IP.max, ACEITE_POR_IP.janelaMs);
    if (!rl.allowed) return { ok: false, reason: "rate_limited" };
  }
  const tokenHash = hashToken(token);

  const invite = await basePrisma.invite.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      teamId: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      verTudoEm: true,
      editarTudoEm: true,
      permissoesEquipe: true,
      modulos: true,
    },
  });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "invalid" };
  }

  const email = invite.email.toLowerCase();
  const name = input.name.trim() || email.split("@")[0]!;
  // RBAC: o papel vem do convite. Fail-closed ao MENOR privilégio se, por
  // qualquer razão, o valor gravado for desconhecido (nunca escala para owner).
  const role: Role = isRole(invite.role) && invite.role !== "owner" ? invite.role : "member";

  const existing = await basePrisma.user.findUnique({
    where: { email },
    select: { id: true, teamId: true },
  });
  if (existing) {
    // Outro time: não re-tenanteia (isolamento). Mesmo time: não troca a senha.
    return { ok: false, reason: existing.teamId !== invite.teamId ? "email_in_other_team" : "email_ja_cadastrado" };
  }

  const agora = new Date();
  const userId = await basePrisma.$transaction(async (tx) => {
    const { count } = await tx.invite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: agora } },
      data: { acceptedAt: agora },
    });
    if (count !== 1) return null; // outro aceite ganhou a corrida
    const created = await tx.user.create({
      // NÃO comprova o e-mail: o link do convite aparece para quem convidou (e,
      // sem o remetente da plataforma, o e-mail sai pelo SMTP do time — auditoria
      // do #148, B2). Só o Google comprova.
      data: {
        teamId: invite.teamId,
        name,
        email,
        role,
        passwordHash: input.passwordHash,
        // O que o convite liberou (F2a): "ver tudo" por tela, telas e, para administrador, a equipe.
        verTudoEm: role === "admin" ? [] : normalizarVerTudoEm(invite.verTudoEm),
        editarTudoEm: role === "admin" ? [] : normalizarEditarTudoEm(invite.editarTudoEm, invite.verTudoEm),
        modulos: invite.modulos,
        permissoesEquipe: role === "admin" ? invite.permissoesEquipe : [],
      },
      select: { id: true },
    });
    return created.id;
  }).catch((e: unknown) => {
    // Corrida com outro cadastro do mesmo e-mail (unique): a transação volta
    // atrás (o convite continua válido) e o chamador vê "já cadastrado".
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") return "P2002" as const;
    throw e;
  });
  if (userId === "P2002") return { ok: false, reason: "email_ja_cadastrado" };
  if (!userId) return { ok: false, reason: "invalid" };

  return { ok: true, userId, teamId: invite.teamId, email };
}

/**
 * "Criar conta" pelo convite recebendo a senha PURA (auditoria do #52). Tudo o
 * que é barato vem ANTES do bcrypt — que custa ~70 ms de CPU num VPS de 2 vCPUs:
 *   1. limite por IP (10 / 15 min, a mesma chave do `acceptInvite`);
 *   2. tamanho da senha;
 *   3. convite válido (existe, não usado, não revogado, no prazo);
 *   4. e-mail do convite ainda sem conta.
 * Só então calcula o hash (`hashSenha`, injetado pelo web) e aceita.
 */
export async function aceitarConviteComSenha(
  rawToken: string,
  input: { name: string; senha: string },
  opts: { ip?: string | null; hashSenha: HashDeSenha },
): Promise<AcceptInviteResult> {
  const token = rawToken?.trim();
  if (!token) return { ok: false, reason: "invalid" };
  if (opts.ip) {
    const rl = await rateLimit(`auth:convite:ip:${opts.ip}`, ACEITE_POR_IP.max, ACEITE_POR_IP.janelaMs);
    if (!rl.allowed) return { ok: false, reason: "rate_limited" };
  }
  if ((input.senha ?? "").length < SENHA_MIN) return { ok: false, reason: "senha_curta" };
  const invite = await basePrisma.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { teamId: true, email: true, expiresAt: true, acceptedAt: true, revokedAt: true },
  });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "invalid" };
  }
  const existing = await basePrisma.user.findUnique({
    where: { email: invite.email.toLowerCase() },
    select: { teamId: true },
  });
  if (existing) {
    return { ok: false, reason: existing.teamId !== invite.teamId ? "email_in_other_team" : "email_ja_cadastrado" };
  }
  const passwordHash = await opts.hashSenha(input.senha);
  // Sem `ip`: o limite já foi contado acima (não gasta duas tentativas).
  return acceptInvite(token, { name: input.name, passwordHash });
}
