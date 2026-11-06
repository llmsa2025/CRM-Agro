import { randomInt } from "node:crypto";
import { z } from "zod";
import { basePrisma, getCurrentTeamId } from "@crmagro/db";
import { ForbiddenError, requireCan, requireRole, type Actor } from "./authz";
import { forgetSessionCache } from "./session";
import { normalizarEditarTudoEm, normalizarModulos, normalizarVerTudoEm, type ModuloComDono } from "./modulos";
import { masterDefinidoDoTime } from "./master";
import { guardarRevogacoes, lerParaEncerrar, revogarNoGoogle } from "../agenda/google/conexao";
import { desligarContasGmail } from "../agenda/google/gmail-envio";

/**
 * Equipe (plano-equipe-permissoes F2a): integrantes do time, papel, "ver tudo"
 * por tela, permissões de equipe por administrador, desativar/excluir,
 * redefinir senha. O master é fixo.
 *
 * Decisões do dono (28/09):
 * - O MASTER é UM só por time: quem criou a empresa (`Team.masterId`, papel
 *   "owner"). Ninguém vira "owner" pela tela e o master NUNCA muda pela
 *   plataforma: só pelo banco (`script de operação`).
 * - O master dá acesso de administrador e escolhe o que cada administrador pode
 *   fazer com a equipe: convidar, desativar, excluir. Administrador NUNCA mexe
 *   no master (excluir, desativar, rebaixar, senha, telas, "ver tudo").
 * - "owner" que sobrou de antes do master único: só o master mexe nele (rebaixa
 *   para administrador, membro ou só leitura; desativa; exclui).
 * - Desativar = sem acesso (login recusado, sessões derrubadas), nada apagado.
 * - Excluir exige transferir os registros da pessoa para outra (os de dono).
 * - "Ver as senhas" não existe (hash irreversível): o master REDEFINE a senha e
 *   recebe uma senha provisória, que passa à pessoa.
 * - "Ver tudo" é por tela: o administrador escolhe, por pessoa, em quais telas
 *   ela vê os registros de todos (F3; `MODULOS_COM_DONO`).
 *
 * Toda escrita derruba as sessões do alvo (sessionVersion + cache), para o
 * papel/acesso novo valer na próxima requisição.
 */

export const PERMISSOES_EQUIPE = ["convidar", "desativar", "excluir"] as const;
export type PermissaoEquipe = (typeof PERMISSOES_EQUIPE)[number];
/** Papéis que se atribuem a um integrante (o master não se transfere por aqui). */
export const PAPEIS_ATRIBUIVEIS = ["admin", "member", "viewer"] as const;
/**
 * O que ganha quem DEIXA de ser "owner" e vira administrador (o "owner" antigo
 * rebaixado pelo master ou pelo script de operação): tudo com a equipe, menos excluir
 * — excluir contas só com a liberação explícita do master (decisão do dono).
 */
export const PERMISSOES_DE_EX_MASTER: readonly PermissaoEquipe[] = ["convidar", "desativar"];

export type IntegranteDTO = {
  id: string;
  nome: string;
  email: string;
  role: string;
  /** É o master do time (um só; `Team.masterId`). */
  master: boolean;
  /** Telas em que vê os registros de todos (vazio = só os seus em todas). */
  verTudoEm: ModuloComDono[];
  /** Telas em que também ALTERA os de todos ("Ver e editar de todos"); sempre dentro de `verTudoEm`. */
  editarTudoEm: ModuloComDono[];
  permissoesEquipe: PermissaoEquipe[];
  modulos: string[];
  desativadoEm: string | null;
  ultimoAcesso: string | null;
  criadoEm: string;
  temSenha: boolean;
};

export class IntegranteNaoEncontrado extends Error {
  constructor(id: string) {
    super(`IntegranteNaoEncontrado: ${id} não é da sua equipe.`);
    this.name = "IntegranteNaoEncontrado";
  }
}
export class AcaoNaoPermitida extends Error {
  constructor(motivo: string) {
    super(`AcaoNaoPermitida: ${motivo}`);
    this.name = "AcaoNaoPermitida";
  }
}

function timeAtual(): string {
  const t = getCurrentTeamId();
  if (!t) throw new ForbiddenError();
  return t;
}

const permissoes = (xs: string[]): PermissaoEquipe[] => xs.filter((x): x is PermissaoEquipe => (PERMISSOES_EQUIPE as readonly string[]).includes(x));

/**
 * Exige a permissão de equipe: o master pode tudo; o administrador só o que o
 * master liberou (lido do banco, não do token — tirar vale na hora).
 */
async function exigirPermissaoEquipe(acao: PermissaoEquipe): Promise<Actor> {
  const actor = requireRole("admin");
  if (actor.role === "owner" || actor.system) return actor;
  const eu = await basePrisma.user.findFirst({
    where: { id: actor.userId, teamId: actor.teamId, desativadoEm: null },
    select: { permissoesEquipe: true },
  });
  if (!eu || !eu.permissoesEquipe.includes(acao)) throw new ForbiddenError();
  return actor;
}

const idSchema = z.string().uuid();

/** O integrante alvo, do MEU time (id de outro time = não encontrado), e o master do time. */
async function alvoDoTime(idBruto: string) {
  // zod na borda: um objeto no lugar do id (ex.: `{ in: [...] }`) viraria filtro.
  const parsed = idSchema.safeParse(idBruto);
  if (!parsed.success) throw new IntegranteNaoEncontrado(String(idBruto));
  const id = parsed.data;
  const teamId = timeAtual();
  const [u, masterId] = await Promise.all([
    basePrisma.user.findFirst({ where: { id, teamId }, select: { id: true, role: true, desativadoEm: true } }),
    // Permissão: só o master DEFINIDO (time antigo sem master → ninguém é master).
    masterDefinidoDoTime(teamId),
  ]);
  if (!u) throw new IntegranteNaoEncontrado(id);
  return { ...u, masterId };
}

/**
 * Regras comuns para mexer em alguém:
 * - nunca em si mesmo;
 * - nunca no MASTER do time (nem administrador, nem "owner" antigo): o master
 *   é fixo (só muda pelo banco);
 * - "owner" que sobrou de antes do master único: só o master mexe (time sem
 *   master definido: ninguém — o script de operação define);
 * - administrador: só o master altera (um administrador só mexe em membro e só
 *   leitura).
 */
function conferirHierarquia(actor: Actor, alvo: { id: string; role: string; masterId: string | null }): void {
  if (alvo.id === actor.userId) throw new AcaoNaoPermitida("você não pode fazer isto com a sua própria conta.");
  if (alvo.id === alvo.masterId) throw new AcaoNaoPermitida("o master não pode ser alterado por aqui.");
  const souMaster = Boolean(actor.system) || (alvo.masterId !== null && actor.userId === alvo.masterId);
  if (alvo.role === "owner" && !souMaster) {
    throw new AcaoNaoPermitida(alvo.masterId ? "só o master altera esta conta." : "o master não pode ser alterado por aqui.");
  }
  if (alvo.role === "admin" && actor.role !== "owner" && !actor.system) throw new AcaoNaoPermitida("só o master altera um administrador.");
}

/** Sobe a versão da sessão (na mesma escrita) e apaga o cache DEPOIS de gravar. */
const derrubarSessoes = { sessionVersion: { increment: 1 } } as const;

function paraDTO(
  u: {
    id: string;
    name: string;
    email: string;
    role: string;
    verTudoEm: string[];
    editarTudoEm: string[];
    permissoesEquipe: string[];
    modulos: string[];
    desativadoEm: Date | null;
    lastLoginAt: Date | null;
    createdAt: Date;
    passwordHash: string | null;
  },
  masterId: string | null,
): IntegranteDTO {
  return {
    id: u.id,
    nome: u.name,
    email: u.email,
    role: u.role,
    master: u.id === masterId,
    verTudoEm: normalizarVerTudoEm(u.verTudoEm),
    editarTudoEm: normalizarEditarTudoEm(u.editarTudoEm, u.verTudoEm),
    permissoesEquipe: permissoes(u.permissoesEquipe),
    modulos: u.modulos,
    desativadoEm: u.desativadoEm?.toISOString() ?? null,
    ultimoAcesso: u.lastLoginAt?.toISOString() ?? null,
    criadoEm: u.createdAt.toISOString(),
    temSenha: u.passwordHash !== null,
  };
}
const SELECT_INTEGRANTE = {
  id: true,
  name: true,
  email: true,
  role: true,
  verTudoEm: true,
  editarTudoEm: true,
  permissoesEquipe: true,
  modulos: true,
  desativadoEm: true,
  lastLoginAt: true,
  createdAt: true,
  passwordHash: true,
} as const;

/** Integrantes do time (master e administradores). O hash da senha nunca sai daqui. */
export async function listIntegrantes(): Promise<IntegranteDTO[]> {
  requireCan("team.manageMembers");
  const teamId = timeAtual();
  const [rows, masterId] = await Promise.all([
    basePrisma.user.findMany({
      where: { teamId },
      orderBy: [{ desativadoEm: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      select: SELECT_INTEGRANTE,
    }),
    masterDefinidoDoTime(teamId),
  ]);
  // O master primeiro (é quem responde pela conta); o resto na ordem de antes.
  return rows.map((u) => paraDTO(u, masterId)).sort((a, b) => Number(b.master) - Number(a.master));
}

/**
 * Troca o papel (só o master): administrador, membro ou só leitura. Nunca
 * "owner" — o master é um só e fixo (só muda pelo banco). O "owner" antigo
 * rebaixado a administrador fica com tudo da equipe menos excluir.
 */
export async function alterarPapel(id: string, papel: string): Promise<IntegranteDTO> {
  const actor = requireRole("owner");
  const role = z.enum(PAPEIS_ATRIBUIVEIS).parse(papel);
  const alvo = await alvoDoTime(id);
  conferirHierarquia(actor, alvo);
  // Deixou de ser administrador: as permissões de equipe saem junto. Virou
  // administrador: as telas e o "ver tudo" por tela saem (vê tudo; não voltam
  // se for rebaixado). "owner" antigo → administrador: `PERMISSOES_DE_EX_MASTER`.
  const extra =
    role !== "admin"
      ? { permissoesEquipe: [] }
      : { modulos: [], verTudoEm: [], editarTudoEm: [], ...(alvo.role === "owner" ? { permissoesEquipe: [...PERMISSOES_DE_EX_MASTER] } : {}) };
  const u = await basePrisma.user.update({
    where: { id: alvo.id },
    data: { role, ...extra, ...derrubarSessoes },
    select: SELECT_INTEGRANTE,
  });
  await forgetSessionCache(alvo.id);
  return paraDTO(u, alvo.masterId);
}

/** O que um administrador pode fazer com a equipe (só o master decide). */
export async function definirPermissoesEquipe(id: string, lista: string[]): Promise<IntegranteDTO> {
  const actor = requireRole("owner");
  const perms = z.array(z.enum(PERMISSOES_EQUIPE)).max(PERMISSOES_EQUIPE.length).parse([...new Set(lista)]);
  const alvo = await alvoDoTime(id);
  conferirHierarquia(actor, alvo);
  if (alvo.role !== "admin") throw new AcaoNaoPermitida("permissões de equipe valem só para administradores.");
  const u = await basePrisma.user.update({ where: { id: alvo.id }, data: { permissoesEquipe: perms }, select: SELECT_INTEGRANTE });
  return paraDTO(u, alvo.masterId);
}

/**
 * O que um membro/só leitura vê e altera POR TELA (administradores). Três
 * opções por tela: "Só os meus" (fora das duas listas), "Ver de todos" (só em
 * `ver`: lê os dos colegas, não altera) e "Ver e editar de todos" (em `ver` e
 * em `editar`). Ex.: ver ["contatos", "conversas"], editar ["contatos"] =
 * Contatos de todos com edição; Conversas de todos só para ler. `editar` fora
 * de `ver` é descartado. Derruba a sessão: o token novo leva as listas.
 */
export async function definirVerTudoEm(id: string, verBruto: string[], editarBruto: string[]): Promise<IntegranteDTO> {
  const actor = requireCan("team.manageMembers");
  const lista = z.array(z.string().max(40)).max(40);
  const ver = lista.parse(verBruto);
  const editar = lista.parse(editarBruto);
  const alvo = await alvoDoTime(id);
  conferirHierarquia(actor, alvo);
  if (alvo.role === "admin" || alvo.role === "owner") throw new AcaoNaoPermitida("administradores já veem tudo.");
  const u = await basePrisma.user.update({
    where: { id: alvo.id },
    data: { verTudoEm: normalizarVerTudoEm(ver), editarTudoEm: normalizarEditarTudoEm(editar, ver), ...derrubarSessoes },
    select: SELECT_INTEGRANTE,
  });
  await forgetSessionCache(alvo.id);
  return paraDTO(u, alvo.masterId);
}

/**
 * Telas de um membro/só leitura (F2b). Vazio = todas. Derruba a sessão: o
 * token novo leva as telas (menu, rota e ação passam a valer na hora).
 */
export async function definirModulos(id: string, listaBruta: string[]): Promise<IntegranteDTO> {
  const actor = requireCan("team.manageMembers");
  const lista = z.array(z.string().max(40)).max(40).parse(listaBruta);
  const alvo = await alvoDoTime(id);
  conferirHierarquia(actor, alvo);
  if (alvo.role === "admin" || alvo.role === "owner") throw new AcaoNaoPermitida("administradores veem todas as telas.");
  const u = await basePrisma.user.update({
    where: { id: alvo.id },
    data: { modulos: normalizarModulos(lista), ...derrubarSessoes },
    select: SELECT_INTEGRANTE,
  });
  await forgetSessionCache(alvo.id);
  return paraDTO(u, alvo.masterId);
}

// O MASTER NÃO MUDA pela plataforma (decisão do dono, 28/09): não existe
// "passar o master" aqui. Troca só pelo banco — `script de operação`.

/** Desativa: sem acesso, sessões derrubadas, nada apagado. */
export async function desativarIntegrante(id: string): Promise<IntegranteDTO> {
  const actor = await exigirPermissaoEquipe("desativar");
  const teamId = timeAtual(); // lido no início (AGENTS.md §12), antes das esperas
  const alvo = await alvoDoTime(id);
  conferirHierarquia(actor, alvo);
  const agora = new Date();
  const { u, conexoes } = await basePrisma.$transaction(async (tx) => {
    // Avisos no navegador levam dado de cliente (lembrete com contato e local):
    // as assinaturas saem; ao reativar, a pessoa liga de novo.
    await tx.pushSubscription.deleteMany({ where: { userId: alvo.id } });
    // Agenda Google (decisão 7, 28/09): a conexão é REVOGADA, não transferida.
    // Os tokens são lidos (só em memória) e a conexão sai aqui — vínculos e
    // blocos "Ocupado" em cascata; os compromissos ficam. O token entra na
    // fila de revogação NESTA transação (uma queda antes de avisar o Google
    // não deixa o token válido lá); o Google é avisado depois do commit.
    const conexoes = await lerParaEncerrar(tx, { teamId, userId: alvo.id });
    await guardarRevogacoes(tx, conexoes);
    // A caixa de envio pelo Gmail dela sai de cena na mesma transação (sem conexão, não envia).
    await desligarContasGmail(tx, conexoes, "disconnected");
    await tx.oAuthConnection.deleteMany({ where: { teamId, userId: alvo.id } });
    // Token da extensão emitido pela pessoa segue ativo sem isto (FK SetNull).
    await tx.relayAgentToken.updateMany({ where: { userId: alvo.id, revokedAt: null }, data: { revokedAt: agora } });
    // Convites pendentes que ela mandou deixam de valer.
    await tx.invite.updateMany({ where: { teamId, invitedByUserId: alvo.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: agora } });
    const u = await tx.user.update({
      where: { id: alvo.id },
      data: { desativadoEm: alvo.desativadoEm ?? agora, ...derrubarSessoes },
      select: SELECT_INTEGRANTE,
    });
    return { u, conexoes };
  });
  await forgetSessionCache(alvo.id);
  // Para o canal de push e revoga o token no Google (best-effort; nunca lança).
  if (conexoes.length) await revogarNoGoogle(conexoes);
  return paraDTO(u, alvo.masterId);
}

/** Reativa quem estava desativado (mesma permissão de desativar). */
export async function reativarIntegrante(id: string): Promise<IntegranteDTO> {
  const actor = await exigirPermissaoEquipe("desativar");
  const alvo = await alvoDoTime(id);
  conferirHierarquia(actor, alvo);
  const u = await basePrisma.user.update({ where: { id: alvo.id }, data: { desativadoEm: null }, select: SELECT_INTEGRANTE });
  // O cache guardava "sem acesso" (null): sem apagar, a volta levaria até 60 s.
  await forgetSessionCache(alvo.id);
  return paraDTO(u, alvo.masterId);
}

/**
 * Exclui o integrante, transferindo antes o que é dele para `transferirPara`
 * (outra pessoa ATIVA do mesmo time). Novos campos de dono (F3) entram aqui.
 */
export async function excluirIntegrante(id: string, transferirPara: string): Promise<{ transferidos: Record<string, number> }> {
  const actor = await exigirPermissaoEquipe("excluir");
  const teamId = timeAtual();
  const alvo = await alvoDoTime(id);
  conferirHierarquia(actor, alvo);
  const para = idSchema.safeParse(transferirPara);
  if (!para.success) throw new IntegranteNaoEncontrado(String(transferirPara));
  if (para.data === alvo.id) throw new AcaoNaoPermitida("escolha outra pessoa para receber os registros.");
  const destino = await basePrisma.user.findFirst({ where: { id: para.data, teamId, desativadoEm: null }, select: { id: true } });
  if (!destino) throw new IntegranteNaoEncontrado(transferirPara);

  const { transferidos, conexoes } = await basePrisma.$transaction(async (tx) => {
    // O que veio da Agenda Google da pessoa e ela nunca confirmou que era de
    // trabalho ("Manter no CRM Agro") era só dela: sai com ela, não vai para
    // quem recebe (seria a agenda pessoal dela na tela de outra pessoa).
    await tx.appointment.deleteMany({ where: { teamId, responsavelId: alvo.id, privadoAteConfirmar: true } });
    // O convite que saiu pelo Google dela passa a seguir pelo .ics do time
    // (a conexão sai abaixo; o .ics mantém o UID daquele evento).
    await tx.appointment.updateMany({ where: { teamId, responsavelId: alvo.id, convitesPorConexaoId: { not: null } }, data: { convitesPorConexaoId: null } });
    const r = {
      contatos: (await tx.contact.updateMany({ where: { teamId, ownerId: alvo.id }, data: { ownerId: destino.id } })).count,
      campanhas: (await tx.campaign.updateMany({ where: { teamId, createdById: alvo.id }, data: { createdById: destino.id } })).count,
      importacoes: (await tx.importJob.updateMany({ where: { teamId, createdById: alvo.id }, data: { createdById: destino.id } })).count,
      compromissos: (await tx.appointment.updateMany({ where: { teamId, responsavelId: alvo.id }, data: { responsavelId: destino.id } })).count,
      metas: (await tx.goal.updateMany({ where: { teamId, ownerId: alvo.id }, data: { ownerId: destino.id } })).count,
      // Escopo por dono (F3): negócios, canais, ligações, fluxos e a fila de captação.
      negocios: (await tx.deal.updateMany({ where: { teamId, ownerId: alvo.id }, data: { ownerId: destino.id } })).count,
      canais: (await tx.channelAccount.updateMany({ where: { teamId, ownerId: alvo.id }, data: { ownerId: destino.id } })).count,
      ligacoes: (await tx.call.updateMany({ where: { teamId, userId: alvo.id }, data: { userId: destino.id } })).count,
      fluxos: (await tx.flow.updateMany({ where: { teamId, createdById: alvo.id }, data: { createdById: destino.id } })).count,
      captacao: (await tx.prospectDraft.updateMany({ where: { teamId, ownerId: alvo.id }, data: { ownerId: destino.id } })).count,
    };
    // Linhas de ligação (F1B-05): a FK SetNull faria a linha pessoal dela virar linha do TIME (sem dono) e,
    // se fosse a única, `linhaParaLigar` a daria a qualquer membro, com o ramal e o número de quem saiu.
    // Por isso é PAUSADA e deixa de ser padrão; um administrador decide o que fazer com ela. Não entra em
    // `transferidos` (nada passou para ninguém). A desativada fica desativada, só perde a marca de padrão.
    await tx.linhaDeLigacao.updateMany({
      where: { teamId, userId: alvo.id, estado: { not: "desativada" } },
      data: { estado: "pausada", motivoPausa: "A pessoa dona da linha saiu da equipe. Um administrador decide o que fazer com ela.", pausadaAte: null },
    });
    await tx.linhaDeLigacao.updateMany({ where: { teamId, userId: alvo.id, padrao: true }, data: { padrao: false } });
    // Tokens da extensão: FK SetNull deixaria o token vivo e sem dono — revoga.
    await tx.relayAgentToken.updateMany({ where: { userId: alvo.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.invite.updateMany({ where: { teamId, invitedByUserId: alvo.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    // Agenda Google (decisão 7): revogada, NÃO transferida. Lida antes do
    // delete (a cascata apagaria o token sem revogar). Os compromissos já
    // passaram para `destino`; os vínculos e os "Ocupado" saem em cascata.
    const conexoes = await lerParaEncerrar(tx, { teamId, userId: alvo.id });
    await guardarRevogacoes(tx, conexoes);
    // A caixa de envio pelo Gmail dela sai de cena na mesma transação (sem conexão, não envia).
    await desligarContasGmail(tx, conexoes, "disconnected");
    await tx.oAuthConnection.deleteMany({ where: { teamId, userId: alvo.id } });
    // Sessões, avisos do navegador e tarefas feitas saem em cascata.
    await tx.user.delete({ where: { id: alvo.id } });
    return { transferidos: r, conexoes };
  }, { timeout: 30_000 }); // muitos contatos: o padrão de 5 s estouraria (P2028)
  await forgetSessionCache(alvo.id);
  if (conexoes.length) await revogarNoGoogle(conexoes);
  return { transferidos };
}

/** Senha provisória: 12 caracteres sem os que se confundem (0/O, 1/l/I). */
function senhaProvisoria(): string {
  const alfabeto = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 12 }, () => alfabeto[randomInt(alfabeto.length)]).join("");
}

/**
 * O master redefine a senha de um integrante e recebe uma senha PROVISÓRIA,
 * mostrada uma vez, para passar à pessoa (que troca depois). Sessões caem.
 */
export async function redefinirSenhaDeIntegrante(
  id: string,
  opts: { hashSenha: (s: string) => Promise<string> },
): Promise<{ senhaProvisoria: string }> {
  const actor = requireRole("owner");
  const alvo = await alvoDoTime(id);
  conferirHierarquia(actor, alvo);
  const senha = senhaProvisoria();
  await basePrisma.user.update({ where: { id: alvo.id }, data: { passwordHash: await opts.hashSenha(senha), ...derrubarSessoes } });
  await forgetSessionCache(alvo.id);
  return { senhaProvisoria: senha };
}

/** A conta existe e está desativada? (login recusa com mensagem própria) */
export async function contaDesativada(emailBruto: string): Promise<boolean> {
  const email = emailBruto.trim().toLowerCase();
  const u = await basePrisma.user.findUnique({ where: { email }, select: { desativadoEm: true } });
  return Boolean(u?.desativadoEm);
}
