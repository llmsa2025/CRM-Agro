import { env } from "@crmagro/config";
import { basePrisma } from "@crmagro/db";
import { isRole, type Role } from "./authz";
import { normalizarEditarTudoEm, normalizarVerTudoEm } from "./modulos";
import { forgetSessionCache } from "./session";
import { seedNewTeam } from "./seed-time";

/**
 * Provisionamento de time/usuário na autenticação.
 *
 * Regra do dono (revista em 09/2026, item G): o login Google entra em conta
 * existente ou em convite pendente (no time do convite). Criar TIME NOVO por
 * e-mail desconhecido só com o cadastro aberto (`SIGNUP_ABERTO=true`); o padrão
 * é fechado.
 *
 * Segurança (multitenancy): isto é BOOTSTRAP de tenant — antes de existir a
 * sessão não há `teamId` no contexto, então usamos `basePrisma` (sem a extensão
 * de tenancy), exatamente como o `seed.ts`. O `teamId` é criado aqui e passa a
 * ser a autoridade da sessão; nunca vem de input do usuário. Como `User.email` é
 * único GLOBAL, cada e-mail pertence a no máximo um time — a reconciliação é
 * determinística (não há como um Google login "cair" em outro time).
 */

/** Dados da empresa que nasce junto com o dono (criar empresa pelo Google). */
export type EmpresaNova = { nome: string; cnpj?: string | null; cidade?: string | null; estado?: string | null };

export type ProvisionResult = { userId: string; teamId: string; role: string; sessionVersion: number };

/**
 * Login Google sem conta e sem convite, com o cadastro fechado (produto, item G).
 * Antes, qualquer e-mail Google desconhecido criava um TIME NOVO — inclusive o
 * de quem tinha sido convidado para um time existente (caía sozinho num time
 * vazio). A tela de login mostra "Peça um convite ao administrador do seu time".
 */
export class SemConvite extends Error {
  constructor(email: string) {
    super(`SemConvite: ${email} não tem conta nem convite pendente.`);
    this.name = "SemConvite";
  }
}

/** Conta desativada pelo master/administrador: login recusado. */
export class ContaDesativada extends Error {
  constructor(email: string) {
    super(`ContaDesativada: ${email} foi desativado pela equipe.`);
    this.name = "ContaDesativada";
  }
}

function cadastroAbertoPadrao(): boolean {
  return env.SIGNUP_ABERTO === "true";
}

/** Convite válido mais recente para o e-mail (não aceito, não revogado, no prazo). */
async function convitePendente(email: string) {
  return basePrisma.invite.findFirst({
    where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, teamId: true, role: true, verTudoEm: true, editarTudoEm: true, permissoesEquipe: true, modulos: true },
  });
}

/**
 * Pode entrar pelo Google? (chamado no `signIn`, ANTES de provisionar). Tem
 * conta, tem convite pendente, ou o cadastro está aberto.
 */
export async function googleSignInPermitido(
  emailBruto: string,
  opts: { cadastroAberto?: boolean } = {},
): Promise<boolean> {
  const email = emailBruto.trim().toLowerCase();
  if (!email) return false;
  if (opts.cadastroAberto ?? cadastroAbertoPadrao()) return true;
  const conta = await basePrisma.user.findUnique({ where: { email }, select: { id: true } });
  if (conta) return true;
  return Boolean(await convitePendente(email));
}

/**
 * Resolve (ou cria) o usuário/time a partir de um login Google verificado.
 *
 * - E-mail já cadastrado → devolve o usuário/time existente e atualiza
 *   `lastLoginAt`.
 * - E-mail com CONVITE pendente → cria o usuário NO TIME DO CONVITE, com o papel
 *   do convite (nunca owner), e marca o convite aceito — atômico: dois logins ao
 *   mesmo tempo não criam dois usuários nem gastam o convite à toa.
 * - Sem convite: cadastro aberto → cria Team + User (dono) + seed; fechado
 *   (padrão) → `SemConvite`.
 *
 * `email` DEVE vir verificado pelo provedor (o chamador checa `email_verified`).
 */
export async function provisionUserFromGoogle(
  input: { email: string; name?: string | null },
  opts: { cadastroAberto?: boolean; empresa?: EmpresaNova | null } = {},
): Promise<ProvisionResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error("e-mail do Google ausente");
  const name = (input.name ?? "").trim() || email.split("@")[0]!;

  const existing = await basePrisma.user.findUnique({
    where: { email },
    select: { id: true, teamId: true, role: true, sessionVersion: true, emailVerificadoEm: true, passwordHash: true, desativadoEm: true },
  });
  if (existing) {
    // Desativado pela equipe (F2a): não entra (o signIn já recusa antes; defesa em profundidade).
    if (existing.desativadoEm) throw new ContaDesativada(email);
    const agora = new Date();
    // Conta por senha nunca comprovada (/criar-empresa com senha, convite aceito
    // pelo link, script): o Google acabou de provar quem é o dono do e-mail. Se
    // foi outra pessoa que criou ("sequestro de antemão"), ela perde a senha e as
    // sessões — a conta fica com o dono verdadeiro, que define a senha dele por
    // "Esqueci a senha".
    const comprovarAgora = existing.emailVerificadoEm === null;
    const apagarSenha = comprovarAgora && existing.passwordHash !== null;
    const atualizado = await basePrisma.user.update({
      where: { id: existing.id },
      data: {
        lastLoginAt: agora,
        ...(comprovarAgora ? { emailVerificadoEm: agora } : {}),
        ...(apagarSenha ? { passwordHash: null, sessionVersion: { increment: 1 } } : {}),
      },
      select: { sessionVersion: true },
    });
    // Depois de gravar: sem isto o cache de 60 s ainda teria a versão velha —
    // a sessão de quem criou sobreviveria e o login novo cairia na 1ª checagem.
    if (apagarSenha) await forgetSessionCache(existing.id);
    return {
      userId: existing.id,
      teamId: existing.teamId,
      role: existing.role,
      sessionVersion: atualizado.sessionVersion,
    };
  }

  // Convite pendente → entra no time que convidou (item G).
  const convite = await convitePendente(email);
  if (convite) {
    const role: Role = isRole(convite.role) && convite.role !== "owner" ? convite.role : "member";
    const agora = new Date();
    const criado = await basePrisma
      .$transaction(async (tx) => {
        const { count } = await tx.invite.updateMany({
          where: { id: convite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: agora } },
          data: { acceptedAt: agora },
        });
        if (count !== 1) return null; // outro login levou o convite
        return tx.user.create({
          data: {
            teamId: convite.teamId,
            name,
            email,
            role,
            lastLoginAt: agora,
            emailVerificadoEm: agora,
            // O que o convite liberou (F2a): "ver tudo" por tela, telas e, para administrador, a equipe.
            verTudoEm: role === "admin" ? [] : normalizarVerTudoEm(convite.verTudoEm),
            editarTudoEm: role === "admin" ? [] : normalizarEditarTudoEm(convite.editarTudoEm, convite.verTudoEm),
            modulos: convite.modulos,
            permissoesEquipe: role === "admin" ? convite.permissoesEquipe : [],
          },
          select: { id: true, teamId: true, role: true, sessionVersion: true },
        });
      })
      .catch((e: unknown) => {
        // Corrida: o outro login criou o usuário (e-mail único) — usa o dele.
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") return null;
        throw e;
      });
    const u =
      criado ??
      (await basePrisma.user.findUnique({
        where: { email },
        select: { id: true, teamId: true, role: true, sessionVersion: true },
      }));
    if (!u) throw new SemConvite(email);
    return { userId: u.id, teamId: u.teamId, role: u.role, sessionVersion: u.sessionVersion };
  }

  if (!(opts.cadastroAberto ?? cadastroAbertoPadrao())) throw new SemConvite(email);

  // Cadastro aberto (ou "Criar a conta da minha empresa"): e-mail novo → time
  // novo com este usuário como DONO. Tudo numa transação: nasce inteiro ou nada.
  const agora = new Date();
  const e = opts.empresa;
  const criado = await basePrisma
    .$transaction(async (tx) => {
    const team = await tx.team.create({
      data: {
        name: e?.nome?.trim() || `Time de ${name}`,
        cnpj: e?.cnpj || null,
        cidade: e?.cidade || null,
        estado: e?.estado || null,
      },
    });
    const user = await tx.user.create({
      data: { teamId: team.id, name, email, role: "owner", lastLoginAt: agora, emailVerificadoEm: agora },
    });
    // Quem cria a empresa é o MASTER do time (um só; ver auth/equipe.ts).
    await tx.team.update({ where: { id: team.id }, data: { masterId: user.id } });
    await seedNewTeam(team.id, user.id, tx);
    return { team, user };
  })
    .catch((err: unknown) => {
      // Corrida: dois logins do mesmo e-mail novo; o outro criou primeiro (e-mail
      // único) e esta transação voltou atrás inteira — entra na conta dele.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") return null;
      throw err;
    });
  // Corrida perdida: entra de novo pelo caminho de conta existente (que faz a
  // limpeza de conta não comprovada — revisão do #148).
  if (!criado) return provisionUserFromGoogle(input);
  const { team, user } = criado;
  return { userId: user.id, teamId: team.id, role: user.role, sessionVersion: user.sessionVersion };
}
