import { Prisma } from "@prisma/client";
import { basePrisma, getCurrentTeamId, getCurrentVerComo, getCurrentVerTudoEm, getCurrentEditarTudoEm } from "@crmagro/db";
import { getActor } from "../auth/authz";
import { editaTudoNaTela, veTudoNaTela, type ModuloComDono } from "../auth/modulos";

/**
 * Escopo por dono (plano-equipe-permissoes F3) — "cada um vê o seu".
 *
 * O time continua isolado pela extensão Prisma (fail-closed). DENTRO do time,
 * membro e só leitura veem só o que é deles (dono) ou compartilhado; master,
 * administrador e o sistema (motor/webhook) veem tudo.
 *
 * "Ver tudo" é POR TELA (pedido do dono, 28/09): o administrador libera, para
 * cada pessoa, as telas em que ela vê os registros de todos — ex.: Contatos de
 * todos, Conversas só as dela. Por isso todo escopo diz de qual TELA é o
 * registro (`modulo`): contato → contatos, negócio → funis, número/conversa →
 * conversas, ligação → ligacoes, campanha → campanhas, fluxo → fluxos,
 * rascunho → captacao. Painel e Mapa usam o da entidade (contatos/funis).
 *
 * LEITURA × ESCRITA (pedido do dono, 28/09): por tela, a pessoa tem "Só os
 * meus", "Ver de todos" (lê os dos colegas, não altera) ou "Ver e editar de
 * todos". Listas, leitura por id e tempo real usam o escopo de LEITURA
 * (`verTudoEm`); todo caminho que ALTERA um registro usa o de ESCRITA
 * (`{ escrita: true }` → `editarTudoEm`), a começar por `assertOwned`. O
 * registro compartilhado com o time segue como antes: quem vê, edita.
 *
 * É regra de SERVIÇO: toda listagem/leitura de registro com dono passa por
 * aqui (teste "dois usuários do mesmo time" por módulo).
 */
export type Escopo = { tudo: true } | { tudo: false; userId: string; semAtor?: true };

/** Leitura (padrão) ou escrita: `{ escrita: true }` = o que a pessoa pode ALTERAR. */
export type UsoDoEscopo = { escrita?: boolean };

/**
 * Escopo do ator do contexto NA TELA `modulo`, para ler (padrão) ou para
 * alterar (`{ escrita: true }`). Sem ator = nada (fail-closed: userId impossível).
 */
export function escopoDoAtor(modulo: ModuloComDono, uso: UsoDoEscopo = {}): Escopo {
  const actor = getActor();
  if (!actor) return { tudo: false, userId: "__sem_ator__", semAtor: true };
  if (uso.escrita) {
    // Escrita: "Ver e editar de todos" na tela. O "por vendedor" só estreita a
    // LEITURA — não entra aqui.
    return actor.system || editaTudoNaTela(actor.role, getCurrentEditarTudoEm(), modulo) ? { tudo: true } : { tudo: false, userId: actor.userId };
  }
  if (actor.system || veTudoNaTela(actor.role, getCurrentVerTudoEm(), modulo)) {
    // "Por vendedor" (F4): quem vê tudo pode ler como uma pessoa — só estreita.
    const verComo = getCurrentVerComo();
    return verComo ? { tudo: false, userId: verComo } : { tudo: true };
  }
  return { tudo: false, userId: actor.userId };
}

/**
 * Chave de cache do escopo (painel, mapa, não lidas): "tudo" ou a pessoa, em
 * cada tela envolvida — o mesmo resultado para quem tem o mesmo escopo, e
 * nunca o de um para outro (ex.: vê Contatos de todos, mas Funis só os seus).
 */
export function chaveDoEscopo(...modulos: ModuloComDono[]): string {
  return modulos
    .map((m) => {
      const e = escopoDoAtor(m);
      return e.tudo ? "tudo" : e.userId;
    })
    .join("|");
}

/**
 * Fragmento `where` do Prisma para o escopo da tela `modulo`: vazio para quem
 * vê (ou, com `escrita`, altera) tudo; senão `campo = eu` (e, quando o modelo
 * tem `compartilhado`, OR compartilhado — o compartilhado vale para os dois).
 */
export function whereDoEscopo<C extends string>(
  modulo: ModuloComDono,
  campo: C,
  opts: { compartilhado?: boolean; escrita?: boolean } = {},
): Record<string, unknown> {
  const e = escopoDoAtor(modulo, { escrita: opts.escrita });
  if (e.tudo) return {};
  // Sem ator não vê nem o compartilhado (fail-closed).
  if (e.semAtor) return { [campo]: e.userId };
  return opts.compartilhado ? { OR: [{ [campo]: e.userId }, { compartilhado: true }] } : { [campo]: e.userId };
}

/**
 * Escopo de registro PESSOAL, que nenhuma tela libera (ex.: o histórico do
 * assistente de IA): master, administrador e sistema veem os do time; os
 * demais, só os seus — o "ver tudo" por tela não abre o dos colegas. Sem
 * ator = nada (fail-closed).
 */
export function whereDoEscopoPessoal<C extends string>(campo: C): Record<string, unknown> {
  const actor = getActor();
  if (!actor) return { [campo]: "__sem_ator__" };
  if (actor.system || actor.role === "owner" || actor.role === "admin") return {};
  return { [campo]: actor.userId };
}

/**
 * O mesmo escopo em SQL cru: `AND (<alias>."<campo>" = eu [OR <alias>.compartilhado])`
 * ou vazio para quem vê tudo. `alias`/`campo` são constantes do código (nunca
 * entrada do cliente); o userId vai como parâmetro.
 */
export function sqlDoEscopo(modulo: ModuloComDono, alias: string, campo = "ownerId", opts: { compartilhado?: boolean } = {}): Prisma.Sql {
  const e = escopoDoAtor(modulo);
  if (e.tudo) return Prisma.empty;
  const col = Prisma.raw(`${alias}."${campo}"`);
  return opts.compartilhado && !e.semAtor
    ? Prisma.sql` AND (${col} = ${e.userId} OR ${Prisma.raw(`${alias}."compartilhado"`)})`
    : Prisma.sql` AND ${col} = ${e.userId}`;
}

/** Dono padrão de um registro novo: a pessoa que age (null = sistema/motor). */
export function donoPadrao(): string | null {
  const actor = getActor();
  if (!actor || actor.system) return null;
  return actor.userId;
}

/**
 * Dono que EXISTE no time (para colunas com FK, como `Contact.ownerId`): a
 * sessão de alguém recém-excluído ainda vale por até 60 s — sem a checagem, o
 * cadastro dele estouraria a FK. Não existe = sem dono (master/admin veem).
 */
export async function donoValido(ownerId: string | null): Promise<string | null> {
  const teamId = getCurrentTeamId();
  if (!ownerId || !teamId) return null;
  const u = await basePrisma.user.findFirst({ where: { id: ownerId, teamId }, select: { id: true } });
  return u?.id ?? null;
}
