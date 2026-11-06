import { basePrisma, getCurrentTeamId, getCurrentVerTudoEm, getCurrentEditarTudoEm } from "@crmagro/db";
import { getActor } from "../auth/authz";
import { masterDoTime } from "../auth/master";
import { editaTudoNaTela, veTudoNaTela } from "../auth/modulos";
import { ContatoJaCadastrado, ResponsavelInvalido } from "./errors";

/**
 * Responsável pelo contato (regra do dono, 28/09): TODO contato tem um
 * responsável (`Contact.ownerId`). Quem cadastra vira o responsável; o que
 * entra pelo sistema fica com quem o originou (dono do número, da campanha, da
 * importação) e, na falta, com o master do time. O gestor muda o responsável
 * ("Mudar responsável") e o contato — com todo o histórico — passa para a outra
 * pessoa. Ninguém cadastra de novo um contato que já existe.
 *
 * O obrigatório é garantido AQUI (no app), não no banco: a coluna continua
 * aceitando NULL porque centenas de fixtures de teste criam contato sem dono e
 * o `onDelete: SetNull` da FK precisa dela. O backfill
 * `20260928130000_responsavel_backfill` dá o master aos contatos antigos.
 */

/**
 * Quem age, do ponto de vista da regra: a pessoa, se ela VÊ os contatos do
 * time todo (abre o existente) e se ela os ALTERA ("Ver e editar de todos" em
 * Contatos: reaproveita o contato do colega, cadastra no nome de outro).
 */
export type QuemAge = { userId: string; veTudo: boolean; editaTudo: boolean };

/**
 * O ator do contexto vê os contatos do time todo? (master, admin, "ver tudo"
 * na tela Contatos — o "ver tudo" é por tela — ou sistema). Não usa
 * `escopoDoAtor`: o "por vendedor" (F4) só estreita a LEITURA — o gestor
 * lendo como um vendedor continua gestor para cadastrar e escolher.
 */
function atorVeTudo(): boolean {
  const actor = getActor();
  if (!actor) return false;
  return !!actor.system || veTudoNaTela(actor.role, getCurrentVerTudoEm(), "contatos");
}

/** O ator do contexto ALTERA os contatos do time todo? ("Ver e editar de todos" em Contatos, master, admin ou sistema). */
function atorEditaTudo(): boolean {
  const actor = getActor();
  if (!actor) return false;
  return !!actor.system || editaTudoNaTela(actor.role, getCurrentEditarTudoEm(), "contatos");
}

// O master do time (quem recebe o contato sem pessoa) vem do helper único do
// core: `masterDoTime` em auth/master.ts (`Team.masterId`, com recuo para o
// owner/admin/pessoa ativa mais antiga).

/**
 * Responsável de um contato NOVO: o candidato (se é pessoa ATIVA do time) ou o
 * master. A sessão de quem acabou de ser desativado/excluído ainda vale por
 * até 60 s, e o job de quem saiu continua rodando — o contato não fica com
 * alguém que ninguém mais acompanha. Só devolve null num time sem nenhuma
 * pessoa (não acontece no app; acontece nas fixtures de teste).
 */
export async function responsavelObrigatorio(candidato: string | null | undefined): Promise<string | null> {
  const teamId = getCurrentTeamId();
  if (!teamId) return null;
  if (candidato) {
    const u = await basePrisma.user.findFirst({ where: { id: candidato, teamId, desativadoEm: null }, select: { id: true } });
    if (u) return u.id;
  }
  return masterDoTime(teamId);
}

/** A pessoa vê / altera os contatos do time todo? (master, admin ou "ver tudo"/"editar" em Contatos). Para o worker, que age em nome dela. */
async function pessoaVeTudo(teamId: string, userId: string): Promise<{ veTudo: boolean; editaTudo: boolean }> {
  const u = await basePrisma.user.findFirst({ where: { id: userId, teamId }, select: { role: true, verTudoEm: true, editarTudoEm: true } });
  if (!u) return { veTudo: false, editaTudo: false };
  return { veTudo: veTudoNaTela(u.role, u.verTudoEm, "contatos"), editaTudo: editaTudoNaTela(u.role, u.editarTudoEm, "contatos") };
}

/**
 * Quem está agindo, para a regra do responsável: a pessoa informada (o job
 * age em nome de quem criou a campanha/importação/captura) ou a do contexto.
 * `null` = sistema puro (webhook, motor): reaproveita qualquer contato.
 */
export async function quemAge(pessoa?: string | null): Promise<QuemAge | null> {
  const teamId = getCurrentTeamId();
  const actor = getActor();
  if (!teamId) return null;
  const id = pessoa ?? (actor && !actor.system ? actor.userId : null);
  if (!id) return null;
  if (actor && !actor.system && actor.userId === id) return { userId: id, veTudo: atorVeTudo(), editaTudo: atorEditaTudo() };
  return { userId: id, ...(await pessoaVeTudo(teamId, id)) };
}

/**
 * Dos contatos `ids`, quais a pessoa NÃO pode usar: de OUTRO responsável e não
 * compartilhados (id → nome do responsável). Quem ALTERA os contatos de todos
 * ("Ver e editar de todos" em Contatos) e o sistema puro usam todos; quem só
 * VÊ os dos colegas não age neles. Contato SEM responsável (só dado antigo antes do backfill, ou
 * fixture de teste) não é "de outro" — não bloqueia.
 */
export async function deOutroResponsavel(ids: readonly string[], quem: QuemAge | null): Promise<Map<string, string | null>> {
  const fora = new Map<string, string | null>();
  const teamId = getCurrentTeamId();
  if (!quem || quem.editaTudo || !teamId || ids.length === 0) return fora;
  const rows = await basePrisma.contact.findMany({
    where: { teamId, id: { in: [...ids] }, compartilhado: false, ownerId: { not: null }, NOT: { ownerId: quem.userId } },
    select: { id: true, owner: { select: { name: true } } },
  });
  for (const r of rows) fora.set(r.id, r.owner?.name ?? null);
  return fora;
}

/**
 * Recusa usar/cadastrar um contato que já existe: sempre com o nome do
 * responsável; o id só quando a pessoa pode abrir o contato (é dela,
 * compartilhado, ou ela vê o time).
 */
export async function recusarJaCadastrado(contactId: string, quem: QuemAge | null): Promise<never> {
  const teamId = getCurrentTeamId();
  const c = teamId
    ? await basePrisma.contact.findFirst({
        where: { id: contactId, teamId },
        select: { ownerId: true, compartilhado: true, owner: { select: { name: true } } },
      })
    : null;
  const pode = !quem || quem.veTudo || !!c?.compartilhado || (!!c?.ownerId && c.ownerId === quem.userId);
  throw new ContatoJaCadastrado(c?.owner?.name ?? null, pode ? contactId : null);
}

/** Recusa (ContatoJaCadastrado) se o contato é de OUTRO responsável para quem age. */
export async function recusarSeDeOutro(contactId: string, quem: QuemAge | null): Promise<void> {
  if ((await deOutroResponsavel([contactId], quem)).size) await recusarJaCadastrado(contactId, quem);
}

/**
 * Opções do campo "Responsável *" do cadastro: o gestor escolhe entre as
 * pessoas ATIVAS do time; o vendedor só vê a si mesmo (campo travado nele).
 */
export async function opcoesDeResponsavel(): Promise<{ pessoas: { id: string; nome: string }[]; eu: string | null; podeEscolher: boolean }> {
  const teamId = getCurrentTeamId();
  const actor = getActor();
  if (!teamId || !actor || actor.system) return { pessoas: [], eu: null, podeEscolher: false };
  // Cadastrar no nome de outra pessoa é alterar os contatos dela: pede "editar".
  const podeEscolher = atorEditaTudo();
  const rows = await basePrisma.user.findMany({
    where: { teamId, desativadoEm: null, ...(podeEscolher ? {} : { id: actor.userId }) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });
  return { pessoas: rows.map((u) => ({ id: u.id, nome: u.name || u.email })), eu: actor.userId, podeEscolher };
}

/**
 * Responsável escolhido na tela de cadastro. Vazio = quem cadastra. A própria
 * pessoa sempre pode; OUTRA pessoa, só quem vê o time todo (gestor) — e ela
 * tem de estar ativa no time. O vendedor que manda outro id é recusado (não
 * cadastra "no nome" do colega).
 */
export async function responsavelEscolhido(id: string | null | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const actor = getActor();
  if (actor && !actor.system && actor.userId === id) return id;
  if (!atorEditaTudo()) throw new ResponsavelInvalido("so_gestor");
  const teamId = getCurrentTeamId();
  if (!teamId || !/^[0-9a-f-]{36}$/i.test(id)) throw new ResponsavelInvalido("pessoa_invalida");
  const u = await basePrisma.user.findFirst({ where: { id, teamId, desativadoEm: null }, select: { id: true } });
  if (!u) throw new ResponsavelInvalido("pessoa_invalida");
  return u.id;
}
