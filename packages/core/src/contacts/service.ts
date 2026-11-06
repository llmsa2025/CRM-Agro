import { randomUUID } from "node:crypto";
import type { Canal } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, kidDoIndice, tenantData, TenantContextRequiredError } from "@crmagro/db";
import { normalizePhone } from "./phone";
import { normalizeIdentifier } from "./identifiers";
import { parseContactsCsv } from "./csv";
import { ContactNotFound, StatusDeQuemSaiuNaoMuda, IdentifierTaken, isUniqueViolation, UnificacaoIncompleta, BuscaGrandeDemais } from "./errors";
import { safeEnrollManyByTrigger } from "../flows/triggers";
import { writeContact, reconcileHistoryOnCreateMany } from "./write";
import { applyCursor, buildResult, type CursorPaginationResult } from "../shared/pagination";
import { assertOwned, assertOwnedMany } from "../tenancy/assert-owned";
import { moverDestinatariosDeCampanha } from "../campaigns/unificar";
import { logger } from "../logger/index";
import { vincularConversaAoContato } from "../conversations/vinculo";
import type { ContactCreate, ContactUpdate } from "./schema";
import type { RelacionamentoStatus, Interesse } from "@prisma/client";
import { requireCan } from "../auth/authz";
import { excluirContatos } from "./exclusao";
import { donoPadrao } from "../tenancy/escopo";
import { responsavelObrigatorio } from "./responsavel";
import { buscaExataDeContatos, ondeIdentificadorExato, valorDe } from "./identificadores-cifra";
import { buscarContatos, achadosDaPagina, BUSCA_TETO, TAG_NONE, type Achado, type ResultadoDaBusca } from "./busca";
import { AGRO_SEM_TIPO, agroFiltroValido } from "../agro/schema";
import {
  aplicarMudancaDeTags,
  diferencaDeTags,
  legadoComMudanca,
  somarTagsEmLote,
  tagsDoContato,
  temMudanca,
  vincularTagsDoCadastro,
  type MudancaDeTags,
} from "../tags/do-contato";

import { whereDoEscopo, sqlDoEscopo } from "../tenancy/escopo";
/**
 * Serviços de contato. Puros: dependem só de @crmagro/db, nunca de Next.
 *
 * O teamId NUNCA é passado manualmente — `db()` lê o AsyncLocalStorage de forma
 * eager (síncrona) e retorna um client com teamId no closure. Logo, toda chamada
 * aqui DEVE rodar dentro de `runWithTeam`/`runAsDev`, e `db()` deve ser chamado
 * no início da função (antes de qualquer await).
 *
 * Os writes usam `tenantData<...>()` (de @crmagro/db) no lugar de `as never`: o
 * teamId é injetado em runtime pela extensão via closure, e o helper mantém a
 * checagem dos demais campos em tempo de compilação.
 *
 * Identifiers multicanal: telefone/email do schema de input viram rows de
 * ChannelIdentifier (whatsapp/email, isPrimary=true). A coluna telefone/email
 * NÃO existe mais no Contact — ChannelIdentifier é a fonte de verdade.
 */

/** Monta dados primitivos do Contact (sem identifiers — esses vão em transaction). */
function toContactData(data: ContactCreate | ContactUpdate) {
  return {
    nome: data.nome,
    sobrenome: data.sobrenome || undefined,
    cidade: data.cidade || undefined,
    estado: data.estado || undefined,
    empresa: data.empresa || undefined,
    cargo: data.cargo || undefined,
    origem: data.origem || undefined,
    tags: data.tags,
    // undefined = não mexe; null = limpa.
    areaHa: data.areaHa,
    faturamentoAnual: data.faturamentoAnual,
  };
}

/** Identifiers derivados do input (telefone→whatsapp, email→email), normalizados. */
function identifiersFromInput(data: { telefone?: string; email?: string }) {
  const rows: { canal: Canal; valor: string; isPrimary: boolean }[] = [];
  const tel = data.telefone ? normalizeIdentifier("whatsapp", data.telefone) : null;
  if (tel) rows.push({ canal: "whatsapp", valor: tel, isPrimary: true });
  const email = data.email ? normalizeIdentifier("email", data.email) : null;
  if (email) rows.push({ canal: "email", valor: email, isPrimary: true });
  return rows;
}

type ContactWithIdentifiers = Prisma.ContactGetPayload<{
  include: { identifiers: true; contactTags: { include: { tag: true } }; owner: { select: { id: true; name: true } } };
}>;

/**
 * Lista contatos do time com paginação cursor-based (§paginação).
 *
 * Aceita `cursor` (id da última linha vista) OU `offset` — o `cursor` tem
 * precedência. Sem nenhum dos dois, devolve a primeira página. O `orderBy`
 * termina em `id` para desempate estável, requisito do cursor.
 */
/** Sentinela do filtro "sem tag" (contatos sem nenhuma tag vinculada). Mora em busca.ts (o SQL da busca também a usa). */
export { TAG_NONE };

type ContactListFilters = {
  search?: string;
  status?: RelacionamentoStatus;
  interesse?: Interesse;
  origem?: string;
  /** id de tag específica, TAG_NONE para "sem tag", ou undefined para todas. */
  tag?: string;
  /** rótulo de produtor: produtor | provavel_produtor | nao_produtor (indexável). */
  produtor?: string;
  /** O que o contato é no agro (verificador): um tipo (`AGRO_TIPOS`) ou `AGRO_SEM_TIPO` (sem classificação). Valor estranho = sem filtro. */
  agro?: string;
  /** Filtro "por vendedor" (F3): id do dono. Dentro do escopo de quem pede. */
  dono?: string;
  /** A busca por texto também procura nas palavras do histórico (só a tela de Contatos e o que age sobre a lista dela). */
  historico?: boolean;
};

/**
 * Escopo por dono (F3): membro/só leitura vê os contatos dele e os
 * compartilhados; master, admin e "ver tudo" veem todos. `dono` (filtro "por
 * vendedor" de quem vê tudo) restringe a uma pessoa.
 */
function escopoContato(dono?: string): Prisma.ContactWhereInput {
  const escopo = whereDoEscopo("contatos", "ownerId", { compartilhado: true }) as Prisma.ContactWhereInput;
  return dono ? { AND: [escopo, { ownerId: dono }] } : escopo;
}

/** Monta o `where` compartilhado por `list` e `count` (mesmos filtros + escopo). */
function contactWhere(f: ContactListFilters): Prisma.ContactWhereInput {
  return { AND: [filtrosDoContato(f), escopoContato(f.dono)] };
}

/**
 * Filtros da lista SEM a busca por texto (a busca é resolvida antes, em `buscarContatos`, e entra como lista de
 * ids). Os mesmos filtros existem em SQL em `busca.ts` (`sqlDosFiltros`): mexeu aqui, mexa lá.
 */
function filtrosDoContato(f: ContactListFilters): Prisma.ContactWhereInput {
  const { status, interesse, origem, tag, produtor } = f;
  const agro = agroFiltroValido(f.agro);
  const where: Prisma.ContactWhereInput = {};
  if (status) where.relacionamentoStatus = status;
  if (interesse) where.interesse = interesse;
  if (origem) where.origem = origem;
  if (tag === TAG_NONE) where.contactTags = { none: {} };
  else if (tag) where.contactTags = { some: { tagId: tag } };
  if (produtor) where.produtorLabel = produtor;
  if (agro === AGRO_SEM_TIPO) where.agroTipos = { isEmpty: true };
  else if (agro) where.agroTipos = { has: agro };
  return where;
}

/** O que a lista carrega de cada contato (responsável, tag mais recente primeiro: a linha mostra uma só). */
const INCLUDE_DA_LISTA = {
  identifiers: true,
  contactTags: { include: { tag: true }, orderBy: { createdAt: "desc" } },
  owner: { select: { id: true, name: true } },
} satisfies Prisma.ContactInclude;

type ListaPaginada = CursorPaginationResult<ContactWithIdentifiers>;

/**
 * Página de uma busca por texto: a ordem e o total vêm da busca (`ids`, mais novo primeiro, até o teto);
 * aqui só se carregam as linhas da página. O escopo por dono é conferido DE NOVO no Prisma (a busca já o
 * aplica no SQL; a segunda trava garante que um erro de lá não vira vazamento).
 */
async function paginaDaBusca(busca: ResultadoDaBusca, opts: { cursor?: string; limit: number; offset: number; dono?: string }): Promise<ListaPaginada> {
  const prisma = db();
  const { ids } = busca;
  const noCursor = opts.cursor ? ids.indexOf(opts.cursor) : -1;
  const inicio = opts.cursor ? noCursor + 1 : opts.offset;
  const fatia = ids.slice(inicio, inicio + opts.limit + 1);
  if (!fatia.length) return buildResult<ContactWithIdentifiers>([], opts.limit);
  const linhas = await prisma.contact.findMany({ where: { AND: [{ id: { in: fatia } }, escopoContato(opts.dono)] }, include: INCLUDE_DA_LISTA });
  const posicao = new Map(fatia.map((id, i) => [id, i]));
  linhas.sort((x, y) => (posicao.get(x.id) ?? 0) - (posicao.get(y.id) ?? 0));
  return buildResult(linhas, opts.limit);
}

export async function list(
  opts: ContactListFilters & {
    cursor?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ListaPaginada> {
  const prisma = db();
  const { cursor, limit = 50, offset = 0 } = opts;
  // Busca por texto (2 letras ou mais): acha em qualquer dado do contato e da empresa (busca.ts).
  const busca = await buscarContatos(opts);
  if (busca) return paginaDaBusca(busca, { cursor, limit, offset, dono: opts.dono });
  const rows = await prisma.contact.findMany({
    where: contactWhere(opts),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: INCLUDE_DA_LISTA,
    // cursor tem precedência; senão mantém offset (compat) buscando limit+1.
    ...(cursor ? applyCursor({ cursor, limit }) : { take: limit + 1, skip: offset }),
  });
  return buildResult(rows, limit);
}

/**
 * Total de contatos (mesmos filtros de `list`) — para paginação. Com busca por texto o total para no teto
 * (`BUSCA_TETO`); quem precisa saber se passou do teto usa `listarContatosDaTela`.
 */
export async function count(opts: ContactListFilters = {}) {
  const prisma = db();
  const busca = await buscarContatos(opts);
  if (busca) return busca.ids.length;
  return prisma.contact.count({ where: contactWhere(opts) });
}

export type ContatosDaTela = {
  items: ContactWithIdentifiers[];
  /** Total do filtro (com busca, até o teto). */
  total: number;
  /** A busca achou mais do que o teto: o total é "mais de N" e a tela pede para refinar. */
  truncada: boolean;
  /** Há busca por texto na lista (os selos "achado em" só existem nesse caso). */
  buscaAtiva: boolean;
  /** Por contato da página: onde a busca achou. */
  achados: Record<string, Achado[]>;
  /** Pediu histórico, mas a base não deu conta a tempo: o resultado vale só para os dados do contato e da empresa. */
  semHistorico: boolean;
};

/** A lista da tela de Contatos: a página, o total e, quando há busca, onde cada contato foi achado. */
export async function listarContatosDaTela(filtros: ContactListFilters, pagina: { limit: number; offset: number }): Promise<ContatosDaTela> {
  const busca = await buscarContatos(filtros);
  if (!busca) {
    const [r, total] = await Promise.all([list({ ...filtros, ...pagina }), count(filtros)]);
    return { items: r.items, total, truncada: false, buscaAtiva: false, achados: {}, semHistorico: false };
  }
  const r = await paginaDaBusca(busca, { ...pagina, dono: filtros.dono });
  const achados = await achadosDaPagina(busca, r.items);
  return { items: r.items, total: busca.ids.length, truncada: busca.truncada, buscaAtiva: true, achados, semHistorico: busca.historicoIndisponivel };
}

/**
 * Origens distintas cadastradas (para o filtro de Origem).
 *
 * `groupBy` vira `GROUP BY origem` no banco (DP-10). O `distinct` do Prisma não
 * vira `DISTINCT`: trazia `id, origem` de TODOS os contatos do time e deduplicava
 * na memória, a cada abertura de /contatos.
 */
export async function listOrigens() {
  const prisma = db();
  const rows = await prisma.contact.groupBy({
    by: ["origem"],
    where: { AND: [{ origem: { not: null } }, escopoContato()] },
    orderBy: { origem: "asc" },
  });
  return rows.map((r) => r.origem as string);
}

/**
 * Escrita no contato (editar, excluir, nota, status, interesse): além de VER
 * (`getById` — "não encontrado" para quem não vê), a pessoa tem de poder
 * ALTERAR: com "Ver de todos" em Contatos lê o contato do colega, mas não
 * altera (`EdicaoNaoPermitida`); com "Ver e editar de todos", altera.
 */
async function exigirContatoEditavel(id: string): Promise<void> {
  await assertOwned("contact", id);
}

export async function getById(id: string) {
  const prisma = db();
  // F3: fora do escopo = não encontrado (mesma resposta de outro time).
  const contact = await prisma.contact.findFirst({
    where: { AND: [{ id }, escopoContato()] },
    include: {
      identifiers: true,
      activities: { orderBy: { createdAt: "desc" }, take: 100 },
      // Camada do mapa (nome/cor para a ficha). A camada é sempre do time do
      // contato: só entra por `moverContatosParaCamada`, que confere os dois.
      camada: { select: { id: true, nome: true, cor: true } },
      // Responsável pelo contato (obrigatório; o gestor muda).
      owner: { select: { id: true, name: true } },
    },
  });
  if (!contact) throw new ContactNotFound(id);
  return contact;
}

/**
 * Cadastra um contato (casca fina sobre `writeContact` — o caminho canônico §2).
 * Mantém a assinatura `create(ContactCreate)` para não quebrar os call sites;
 * mapeia telefone→whatsapp e email→email para os identifiers canônicos e devolve
 * o Contact com os identifiers (o formato que os chamadores esperam).
 */
export async function create(data: ContactCreate) {
  requireCan("contacts.write");
  const prisma = db();
  const { contactId } = await writeContact(
    {
      nome: data.nome,
      sobrenome: data.sobrenome,
      cidade: data.cidade,
      estado: data.estado,
      cargo: data.cargo,
      empresa: data.empresa,
      origem: data.origem,
      tags: data.tags ?? [],
      areaHa: data.areaHa ?? undefined,
      faturamentoAnual: data.faturamentoAnual ?? undefined,
      identifiers: { whatsapp: data.telefone, email: data.email },
      provenance: { source: data.origem || "form", actor: "human" },
    },
    { mode: "create" },
  );
  // As tags digitadas também entram no catálogo (barra de filtro e autocomplete leem de lá). Não derruba o cadastro.
  await vincularTagsDoCadastro(contactId, data.tags ?? []);
  return prisma.contact.findUniqueOrThrow({
    where: { id: contactId },
    include: { identifiers: true },
  });
}

/**
 * Acha (por telefone/e-mail) ou cria um contato. Base do gatilho de WEBHOOK: um
 * lead que "levanta a mão" numa campanha chega por HTTP e não pode virar
 * duplicata se já existir. Casca fina sobre `writeContact` em modo upsert (dedup
 * canônico + idempotência sob corrida).
 */
export async function findOrCreateContact(data: {
  nome?: string;
  telefone?: string;
  email?: string;
  empresa?: string;
  cidade?: string;
  cargo?: string;
  origem?: string;
}): Promise<{ contactId: string; created: boolean }> {
  requireCan("contacts.write");
  return writeContact(
    {
      nome: data.nome?.trim() || "Lead (webhook)",
      cidade: data.cidade,
      cargo: data.cargo,
      origem: data.origem ?? "webhook",
      identifiers: { whatsapp: data.telefone, email: data.email },
      provenance: { source: data.origem ?? "webhook", actor: "system" },
    },
    { mode: "upsert" },
  );
}

export async function update(id: string, data: ContactUpdate) {
  requireCan("contacts.write");
  const prisma = db();
  const atual = await getById(id); // lança ContactNotFound (e valida escopo do time)
  await exigirContatoEditavel(id);

  // Campo "Tags". `tagsIniciais` é a lista que a pessoa via ao abrir o formulário: com ela, só a DIFERENÇA vale, no
  // catálogo e no campo legado. Salvar sem mexer nas tags não toca em nada, tag que entrou por outro caminho enquanto
  // a ficha estava aberta não é apagada, e tag que só existia no campo antigo não é religada nem dispara fluxo.
  // Sem ela (API), `tags` é a lista final e a base é o que o contato tem agora (catálogo + campo legado).
  // Ausente (`undefined`) = não mexe.
  let tagsDoCampoLegado = data.tags;
  let mudancaDeTags: MudancaDeTags | null = null;
  if (data.tags !== undefined) {
    const visto = data.tagsIniciais ?? (await tagsDoContato(id, atual.tags));
    mudancaDeTags = diferencaDeTags(visto, data.tags);
    if (data.tagsIniciais) tagsDoCampoLegado = temMudanca(mudancaDeTags) ? legadoComMudanca(atual.tags, mudancaDeTags) : undefined;
  }

  // Identifiers: se telefone/email vieram no update, garante o identifier
  // primário do canal (cria se não existe; atualiza valor/isPrimary se existe).
  const tel = data.telefone;
  const email = data.email;

  await prisma.contact.update({
    where: { id },
    data: toContactData({ ...data, tags: tagsDoCampoLegado }),
  });

  if (tel !== undefined) {
    const valor = tel ? normalizeIdentifier("whatsapp", tel) : null;
    await upsertIdentifier(prisma, id, "whatsapp", valor);
  }
  if (email !== undefined) {
    const valor = email ? normalizeIdentifier("email", email) : null;
    await upsertIdentifier(prisma, id, "email", valor);
  }

  // O catálogo (barra de filtro, autocomplete, tag da linha) recebe a mesma diferença que o campo legado acima.
  // Dispara "tag adicionada" só para o vínculo que esta chamada de fato criou.
  if (mudancaDeTags && temMudanca(mudancaDeTags)) await aplicarMudancaDeTags(id, mudancaDeTags, { gatilho: true });

  // Re-busca com identifiers atualizados (os upserts aconteceram depois do update).
  return prisma.contact.findUniqueOrThrow({
    where: { id },
    include: { identifiers: true },
  });
}

/**
 * Garante o identifier primário de um canal pra um contato.
 *   - valor === null → remove o identifier primário existente do canal.
 *   - valor !== null → cria ou atualiza pra { valor, isPrimary: true }.
 *   Idempotente pelo unique [teamId, canal, valor].
 */
async function upsertIdentifier(
  prisma: ReturnType<typeof db>,
  contactId: string,
  canal: Canal,
  valor: string | null,
) {
  if (valor === null) {
    await prisma.channelIdentifier.deleteMany({ where: { contactId, canal, isPrimary: true } });
    return;
  }
  // Se o valor já pertence a OUTRO contato (unique global do time), erro nomeado
  // e amigável em vez de P2002 cru (que virava 500 + flood de log).
  const dono = await prisma.channelIdentifier.findFirst({
    where: ondeIdentificadorExato(getCurrentTeamId() ?? "", canal, [valor]),
    select: { contactId: true },
  });
  if (dono && dono.contactId !== contactId) throw new IdentifierTaken(canal, valor);

  const existing = await prisma.channelIdentifier.findFirst({
    where: { contactId, canal },
  });
  try {
    if (existing) {
      await prisma.channelIdentifier.update({
        where: { id: existing.id },
        // Endereço novo não herda a marca de bounce do antigo (item 3.4).
        data: { canal, valor, isPrimary: true, ...(valorDe(existing) !== valor ? { invalido: false, invalidoMotivo: null } : {}) },
      });
    } else {
      await prisma.channelIdentifier.create({
        data: tenantData<Prisma.ChannelIdentifierUncheckedCreateInput>({
          contactId,
          canal,
          valor,
          isPrimary: true,
        }),
      });
    }
  } catch (e) {
    if (isUniqueViolation(e)) throw new IdentifierTaken(canal, valor);
    throw e;
  }
}

export async function remove(id: string) {
  requireCan("contacts.delete");
  await getById(id);
  await exigirContatoEditavel(id);
  // Apaga também enriquecimento e mídias do Storage (LGPD — item 3.7, S15).
  await excluirContatos([id]);
}

/**
 * Contatos que precisam de REVISÃO manual — falta WhatsApp ou e-mail (dados que
 * o SDR precisa completar/validar antes de prospectar), ou o número foi dado
 * como ERRADO numa ligação (produto §D: `ChannelIdentifier.invalido`). Base do
 * menu Atividades ("Revisar dados"). Retorna o contato + o que está faltando.
 * `faltaWhatsapp` = nenhum número VÁLIDO (o inválido não conta).
 */
export async function contatosParaRevisar(limit = 50) {
  const prisma = db();
  const rows = await prisma.contact.findMany({
    where: {
      AND: [
        {
          OR: [
            { identifiers: { none: { canal: "whatsapp", invalido: false } } },
            { identifiers: { none: { canal: "email" } } },
            { identifiers: { some: { canal: "whatsapp", invalido: true } } },
          ],
        },
        escopoContato(),
      ],
    },
    orderBy: { createdAt: "desc" },
    include: { identifiers: true },
    take: limit,
  });
  return rows.map((c) => {
    const canais = new Set(c.identifiers.map((i) => i.canal));
    const numeroErrado = c.identifiers.find((i) => i.canal === "whatsapp" && i.invalido);
    return {
      id: c.id,
      nome: c.nome,
      empresa: c.empresa,
      criadoEm: c.createdAt,
      faltaWhatsapp: !c.identifiers.some((i) => i.canal === "whatsapp" && !i.invalido),
      faltaEmail: !canais.has("email"),
      /** Número marcado como errado (ligação): o valor e o motivo, para a tela. */
      numeroErrado: numeroErrado ? { valor: valorDe(numeroErrado) ?? numeroErrado.valor, motivo: numeroErrado.invalidoMotivo } : null,
    };
  });
}

/**
 * Todos os ids que casam com um filtro (para operações "selecionar todos os N
 * do filtro"). Só `id` — leve mesmo com milhares de linhas.
 */
export async function listContactIds(filters: ContactListFilters = {}): Promise<string[]> {
  const prisma = db();
  const busca = await buscarContatos(filters);
  if (busca) {
    // "Todos os N da busca" só vale até o teto: acima dele, o N é desconhecido e agir em parte seria enganoso.
    if (busca.truncada) throw new BuscaGrandeDemais(BUSCA_TETO);
    return busca.ids;
  }
  const rows = await prisma.contact.findMany({ where: contactWhere(filters), select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * Exclusão em massa por ids (ação em lote da listagem). Só apaga do time atual
 * (a extensão filtra) e leva junto enriquecimento e mídias (item 3.7, S15).
 */
export async function removeMany(ids: string[]): Promise<{ deleted: number }> {
  requireCan("contacts.delete");
  if (ids.length === 0) return { deleted: 0 };
  return excluirContatos(ids);
}

export async function addNote(contactId: string, conteudo: string) {
  requireCan("contacts.write");
  const prisma = db();
  await getById(contactId); // valida existência + escopo
  await exigirContatoEditavel(contactId);
  return prisma.activity.create({
    data: tenantData<Prisma.ActivityUncheckedCreateInput>({
      contactId,
      tipo: "note",
      direcao: "out",
      conteudo,
    }),
  });
}

/** Tamanho do lote por statement — evita um INSERT gigante numa planilha grande. */
const IMPORT_CHUNK = 500;
/** Identificadores por consulta de duplicata (bem abaixo do limite de bind do Postgres). */
const DEDUP_CHUNK = 1000;

/**
 * Importa CSV em LOTE.
 *
 * A versão anterior fazia, por linha, um SELECT de duplicata + uma transação com
 * 2 escritas, tudo em série: ~3 round-trips por contato. Numa planilha de mil
 * linhas passavam de 3.000 idas ao banco em sequência (dezenas de segundos, com
 * risco de estourar o timeout do server action). Este é o caminho que o README
 * chama de "mata a dor da planilha", então era justamente o mais lento.
 *
 * Agora: 1 SELECT resolve todas as duplicatas de uma vez, e as inserções vão em
 * `createMany` por blocos. Os ids dos contatos são gerados aqui (o schema usa
 * uuid) para poder ligar os identifiers sem precisar ler de volta o que foi
 * inserido — `createMany` não retorna linhas.
 */
export async function importCsv(text: string) {
  requireCan("contacts.import");
  const prisma = db();
  // F3: os contatos importados são de quem importou (lido antes de qualquer await).
  const dono = donoPadrao();
  const { valid, errors } = parseContactsCsv(text);

  // 1) Normaliza os identifiers de todas as linhas de uma vez.
  const linhas = valid.map((c) => ({ input: c, identifiers: identifiersFromInput(c) }));

  // 2) Quais desses identifiers já existem no time? Em blocos de 1.000 por canal
  //    (`valor IN (...)`): um OR único com todas as linhas estourava o limite de
  //    parâmetros do Postgres acima de ~16 mil linhas e a importação quebrava (DP-16).
  const existentes = new Set<string>();
  const porCanal = new Map<Canal, string[]>();
  for (const i of linhas.flatMap((l) => l.identifiers)) {
    const lista = porCanal.get(i.canal) ?? [];
    lista.push(i.valor);
    porCanal.set(i.canal, lista);
  }
  for (const [canal, valores] of porCanal) {
    const unicos = [...new Set(valores)];
    for (let i = 0; i < unicos.length; i += DEDUP_CHUNK) {
      const achados = await prisma.channelIdentifier.findMany({
        where: ondeIdentificadorExato(getCurrentTeamId() ?? "", canal, unicos.slice(i, i + DEDUP_CHUNK)),
        select: { canal: true, valor: true, valorCifrado: true },
      });
      for (const a of achados) existentes.add(`${a.canal}:${valorDe(a)}`);
    }
  }

  // 3) Separa o que entra do que é duplicata. `existentes` também acumula os
  //    identifiers desta importação — sem isso, duas linhas do MESMO arquivo com
  //    o mesmo telefone passariam as duas (o loop antigo não tinha esse furo
  //    porque cada insert já era visível para a linha seguinte).
  const aCriar: { id: string; input: (typeof valid)[number]; identifiers: ReturnType<typeof identifiersFromInput> }[] = [];
  let skipped = 0;
  for (const l of linhas) {
    const chaves = l.identifiers.map((i) => `${i.canal}:${i.valor}`);
    if (chaves.some((k) => existentes.has(k))) {
      skipped++;
      continue;
    }
    for (const k of chaves) existentes.add(k);
    aCriar.push({ id: randomUUID(), input: l.input, identifiers: l.identifiers });
  }

  // 4) Insere em blocos. Contatos e seus identifiers no mesmo $transaction para
  //    não deixar contato órfão se o segundo statement falhar.
  const ownerId = await responsavelObrigatorio(dono);
  for (let i = 0; i < aCriar.length; i += IMPORT_CHUNK) {
    const bloco = aCriar.slice(i, i + IMPORT_CHUNK);
    await prisma.$transaction(async (tx) => {
      await tx.contact.createMany({
        data: bloco.map((b) =>
          tenantData<Prisma.ContactUncheckedCreateInput>({
            ...toContactData(b.input),
            id: b.id,
            nome: b.input.nome,
            ownerId,
          }),
        ),
      });
      const ident = bloco.flatMap((b) =>
        b.identifiers.map((idf) =>
          tenantData<Prisma.ChannelIdentifierCreateManyInput>({
            contactId: b.id,
            canal: idf.canal,
            valor: idf.valor,
            isPrimary: idf.isPrimary,
          }),
        ),
      );
      if (ident.length) {
        // skipDuplicates: rede de segurança contra corrida com outra importação
        // simultânea (o @@unique([teamId,canal,valor]) é a garantia real).
        await tx.channelIdentifier.createMany({ data: ident, skipDuplicates: true });
      }
    });
  }

  // Fecha o furo histórico: o import CSV inseria em lote e PULAVA o gatilho, então
  // o contato entrava "morto" para o motor (sem `contact_created`) e sem reconcile
  // de histórico. O pós-processo também é em LOTE (DP-16/MF-13): antes eram ~5–7
  // consultas por contato, em série, dentro da server action. Não-fatal.
  // Ver contato-canonico-e-enriquecimento.md §2/§5-A.
  for (let i = 0; i < aCriar.length; i += IMPORT_CHUNK) {
    const bloco = aCriar.slice(i, i + IMPORT_CHUNK);
    await reconcileHistoryOnCreateMany(bloco.map((b) => ({ contactId: b.id, valores: b.identifiers.map((x) => x.valor) })));
    // As tags da planilha entram no catálogo (barra de filtro e autocomplete leem de lá; o campo legado já foi
    // gravado acima). Em lote, sem o gatilho "tag adicionada" e sem derrubar a importação. Antes do gatilho
    // `contact_created`, para o fluxo que ele inicia já enxergar as tags.
    const comTags = bloco.filter((b) => b.input.tags.length > 0);
    if (comTags.length > 0) {
      try {
        await somarTagsEmLote(comTags.map((b) => ({ contactId: b.id, nomes: b.input.tags })));
      } catch (err) {
        logger.error(
          { contatos: comTags.length, err: err instanceof Error ? err.message : String(err) },
          "[tags] falha ao levar as tags da planilha para o catálogo (o campo legado guarda o texto)",
        );
      }
    }
    await safeEnrollManyByTrigger(
      "contact_created",
      bloco.map((b) => b.id),
      { emLote: true },
    );
  }

  const created = aCriar.length;
  return { created, skipped, errors };
}

// ---------------------------------------------------------------------------
// Relacionamento — insumos do Passo 9 (motor de fluxos / condition "respondeu?")
// ---------------------------------------------------------------------------

const NOME_DO_STATUS: Record<RelacionamentoStatus, string> = {
  novo: "nunca contatado",
  ja_conversou: "contatado",
  cliente: "cliente",
  opt_out: "não quer contato",
};

/**
 * Atualiza o relacionamentoStatus do contato (editável manualmente: Nunca contatado, Contatado, Cliente).
 * Quem pediu para sair (`opt_out`) não muda por aqui, para não religar campanhas e fluxos sem querer. A mudança
 * vira uma anotação na linha do tempo do contato (quem marcou e quando).
 */
export async function setRelacionamentoStatus(
  contactId: string,
  status: RelacionamentoStatus,
) {
  requireCan("contacts.write");
  const prisma = db();
  const atual = await getById(contactId);
  await exigirContatoEditavel(contactId);
  if (atual.relacionamentoStatus === status) return atual;
  if (atual.relacionamentoStatus === "opt_out") throw new StatusDeQuemSaiuNaoMuda();
  const updated = await prisma.contact.update({
    where: { id: contactId },
    data: { relacionamentoStatus: status },
  });
  await prisma.activity.create({
    data: tenantData<Prisma.ActivityUncheckedCreateInput>({
      contactId,
      tipo: "note",
      direcao: "out",
      conteudo: `Status: ${NOME_DO_STATUS[atual.relacionamentoStatus]} → ${NOME_DO_STATUS[status]}`,
      meta: { kind: "status_change", de: atual.relacionamentoStatus, para: status },
    }),
  });
  return updated;
}

/**
 * Muda o status de VÁRIOS contatos de uma vez (Nunca contatado, Contatado, Cliente), por exemplo para marcar
 * como Cliente quem já é cliente na base. Mesmas regras de `setRelacionamentoStatus`: quem pediu para sair não
 * muda (conta em `pulados`) e cada mudança vira uma anotação na linha do tempo. Um id fora do escopo derruba o
 * lote inteiro (`assertOwnedMany`).
 */
export async function setRelacionamentoStatusBulk(
  contactIds: string[],
  status: Exclude<RelacionamentoStatus, "opt_out">,
): Promise<{ atualizados: number; jaEstavam: number; pulados: number }> {
  requireCan("contacts.write");
  if (contactIds.length === 0) return { atualizados: 0, jaEstavam: 0, pulados: 0 };
  await assertOwnedMany("contact", contactIds);
  const prisma = db();
  const atuais = await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, relacionamentoStatus: true } });
  const pulados = atuais.filter((c) => c.relacionamentoStatus === "opt_out").length;
  const jaEstavam = atuais.filter((c) => c.relacionamentoStatus === status).length;
  const mudam = atuais.filter((c) => c.relacionamentoStatus !== status && c.relacionamentoStatus !== "opt_out");
  if (mudam.length > 0) {
    await prisma.$transaction([
      prisma.contact.updateMany({ where: { id: { in: mudam.map((c) => c.id) } }, data: { relacionamentoStatus: status } }),
      prisma.activity.createMany({
        data: mudam.map((c) =>
          tenantData<Prisma.ActivityCreateManyInput>({
            contactId: c.id,
            tipo: "note",
            direcao: "out",
            conteudo: `Status: ${NOME_DO_STATUS[c.relacionamentoStatus]} → ${NOME_DO_STATUS[status]}`,
            meta: { kind: "status_change", de: c.relacionamentoStatus, para: status },
          }),
        ),
      }),
    ]);
  }
  return { atualizados: mudam.length, jaEstavam, pulados };
}

/**
 * Define o interesse do contato (qualificação manual). Registra também uma
 * Activity `note` para o histórico — quem qualificou e quando aparece na
 * timeline, e vira insumo para métricas de conversão depois.
 */
export async function setInteresse(contactId: string, interesse: Interesse) {
  requireCan("contacts.write");
  const prisma = db();
  await getById(contactId);
  await exigirContatoEditavel(contactId);
  const updated = await prisma.contact.update({
    where: { id: contactId },
    data: { interesse },
  });
  await prisma.activity.create({
    data: tenantData<Prisma.ActivityUncheckedCreateInput>({
      contactId,
      tipo: "note",
      direcao: "out",
      conteudo: `Interesse: ${interesse.replace("_", " ")}`,
      meta: { kind: "interesse_change", interesse },
    }),
  });
  return updated;
}

/**
 * "Consulta pré-cadastro": o contato já recebeu alguma mensagem inbound
 * (ou seja, já conversou pela plataforma)? Base da condition de primeiro
 * contato do Passo 9. Fronteira honesta: conversa pré-plataforma não é
 * enxergada aqui — nesses casos o status é marcado manualmente.
 */
export async function hasInboundActivity(contactId: string): Promise<boolean> {
  const prisma = db();
  const count = await prisma.activity.count({
    where: { contactId, direcao: "in" },
  });
  return count > 0;
}

/**
 * "Respondeu no período?": existe Activity inbound do contato com `createdAt`
 * depois de `since`. Base do nó `condition` "responded" do motor de fluxos —
 * `since` é o `enrollment.lastOutboundAt` (último send_message do enrollment).
 */
export async function hasInboundActivitySince(contactId: string, since: Date): Promise<boolean> {
  const prisma = db();
  const count = await prisma.activity.count({
    where: { contactId, direcao: "in", createdAt: { gt: since } },
  });
  return count > 0;
}

/**
 * "Respondeu no período por um CANAL específico?": inbound do contato após
 * `since`, restrito a um canal. WhatsApp/e-mail vêm da Activity (o `tipo` == o
 * canal). Instagram/LinkedIn não têm ActivityTipo próprio — a resposta vive na
 * Message inbound da conversa daquele canal. Base do nó `condition` "responded"
 * com canal (verificação multicanal do motor).
 */
export async function hasInboundOnChannelSince(
  contactId: string,
  since: Date,
  canal: "whatsapp" | "email" | "instagram" | "linkedin",
): Promise<boolean> {
  const prisma = db();
  if (canal === "whatsapp" || canal === "email") {
    const count = await prisma.activity.count({
      where: { contactId, direcao: "in", tipo: canal, createdAt: { gt: since } },
    });
    return count > 0;
  }
  const count = await prisma.message.count({
    where: { direcao: "in", createdAt: { gt: since }, conversation: { contactId, canal } },
  });
  return count > 0;
}

// Reexporta normalizePhone pra compat de imports existentes.
export { normalizePhone };

// ────────────────────────────────────────────────────────────────────────────
// Contatos duplicados (determinístico, sem IA). Agrupa por nome igual, telefone
// (normalizado — pega variações com/sem o 9º dígito) e e-mail. `mergeContacts`
// unifica: reatribui histórico/negócios/conversas/tags/identifiers pro contato
// mantido e apaga os demais.
// ────────────────────────────────────────────────────────────────────────────

export type DuplicateContact = {
  id: string;
  nome: string;
  telefone: string | null;
  email: string | null;
  empresa: string | null;
  cidade: string | null;
  createdAt: string;
};
/**
 * `total` = tamanho real do grupo. `contacts` traz no máximo
 * `DUP_CONTATOS_POR_GRUPO` (um grupo "Lead (webhook)" com 20 mil contatos não
 * vem inteiro para a memória do web).
 */
export type DuplicateGroup = { reasons: string[]; total: number; contacts: DuplicateContact[] };

const DUP_REASON_LABEL: Record<string, string> = {
  nome: "Nome igual",
  telefone: "Telefone igual",
  email: "E-mail igual",
};

/** Teto de grupos devolvidos (os maiores primeiro — DP-17). */
export const DUP_MAX_GRUPOS = 200;
/** Teto de contatos listados por grupo (`total` diz o tamanho real). */
export const DUP_CONTATOS_POR_GRUPO = 50;

type LinhaGrupoDuplicado = { motivos: string[]; n: number; ids: string[] };

/**
 * Espaços para as chaves de nome/e-mail. O `\s` do Postgres não pega o NBSP e
 * os outros espaços Unicode que o `\s` do JS pegava (nome colado de planilha ou
 * site). As regex vão como PARÂMETRO do SQL (nada de escape dentro do template).
 */
const CLASSE_ESPACO = "[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";
/** Sequência de espaços (vira um espaço só na chave do nome). */
const ESPACOS_SQL = `${CLASSE_ESPACO}+`;
/** Espaços nas pontas (o `trim()` do JS, para o e-mail). */
const PONTAS_SQL = `^${CLASSE_ESPACO}+|${CLASSE_ESPACO}+$`;

/** Valor legível de um identificador (ou null). */
function valorOuNull(i: { valor?: string | null; valorCifrado?: string | null } | undefined): string | null {
  return i ? valorDe(i) : null;
}

/**
 * O time tem TODO telefone (8+ dígitos) com índice de sufixo e TODO e-mail com índice? Só então os
 * Duplicados agrupam pelo índice cego; com qualquer linha sem índice, agrupar por ele separaria em
 * silêncio quem tem índice de quem não tem. Nesse caso volta ao texto (e avisa no log).
 */
async function indiceCompletoParaDuplicados(prisma: ReturnType<typeof db>, teamId: string): Promise<boolean> {
  // Índice de outra chave (rotação em andamento) também conta como "incompleto": hashes de chaves diferentes nunca agrupam.
  const daChaveAtual = `${kidDoIndice()}.%`;
  const [r] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "ChannelIdentifier"
    WHERE "teamId" = ${teamId}
      AND ((canal = 'whatsapp' AND "valorSufixoHash" IS NULL AND length(regexp_replace(valor, '\\D', '', 'g')) >= 8)
        OR (canal = 'whatsapp' AND "valorSufixoHash" IS NOT NULL AND "valorSufixoHash" NOT LIKE ${daChaveAtual})
        OR (canal = 'email' AND "valorHash" IS NULL AND valor LIKE '%@%')
        OR (canal = 'email' AND "valorHash" IS NOT NULL AND "valorHash" NOT LIKE ${daChaveAtual}))`;
  const faltam = r?.n ?? 0;
  if (faltam > 0) logger.warn({ teamId, faltam }, "[duplicados] há telefone ou e-mail sem índice cego: agrupando pelo texto");
  return faltam === 0;
}

/**
 * Grupos de contatos duplicados, calculados no banco (DP-17).
 *
 * Antes: `contact.findMany` do time INTEIRO (com `enrichment` e identifiers)
 * para agrupar na memória — centenas de MB com 100 mil contatos. Agora um SQL
 * só, com `"teamId"` explícito em todas as tabelas (§12f), agrupa pelas mesmas
 * chaves do código antigo:
 *   - nome: minúsculo, espaços colapsados e aparados;
 *   - telefone: últimos 8 dígitos do WhatsApp (pega com/sem o 9º dígito);
 *   - e-mail: minúsculo e aparado.
 * Um identificador por canal por contato: o primário (empate → o mais antigo).
 * Antes era o primeiro que o `identifiers.find(...)` achasse, sem ordem
 * definida — num contato com dois WhatsApp o grupo agora é sempre pelo
 * primário.
 *
 * Grupos com o MESMO conjunto de contatos juntam os motivos (assinatura = md5
 * dos ids ordenados). Ordem: maior grupo primeiro; empate → nome antes de
 * telefone antes de e-mail, e depois o grupo cujo contato mais antigo veio
 * antes (a ordem em que o código antigo inseria). Contatos do grupo em ordem de
 * id (`COLLATE "C"` = a ordem do `sort()` do JS).
 */
export async function findDuplicateContacts(): Promise<DuplicateGroup[]> {
  const prisma = db();
  const teamId = getCurrentTeamId();
  if (!teamId) throw new TenantContextRequiredError("findDuplicateContacts", "Contact");

  // Cifra ligada (indice/ligada) e índice completo no time: agrupa pelo índice cego. Senão, pelo texto.
  const porIndice = buscaExataDeContatos() && (await indiceCompletoParaDuplicados(prisma, teamId));
  // A chave do grupo de telefone (8 últimos dígitos) e de e-mail (minúsculo e aparado). Pelo índice, as duas
  // variantes do 9º dígito continuam no mesmo grupo (mesmo sufixo); sem sufixo (menos de 8 dígitos) cai no texto.
  const chaveTel = porIndice
    ? Prisma.sql`COALESCE(t."valorSufixoHash", right(regexp_replace(t.valor, '\\D', '', 'g'), 8))`
    : Prisma.sql`right(regexp_replace(t.valor, '\\D', '', 'g'), 8)`;
  const chaveMail = porIndice
    ? Prisma.sql`COALESCE(m."valorHash", lower(regexp_replace(m.valor, ${PONTAS_SQL}, '', 'g')))`
    : Prisma.sql`lower(regexp_replace(m.valor, ${PONTAS_SQL}, '', 'g'))`;

  const linhas = await prisma.$queryRaw<LinhaGrupoDuplicado[]>`
    WITH tel AS (
      SELECT DISTINCT ON ("contactId") "contactId", valor, "valorSufixoHash"
      FROM "ChannelIdentifier"
      WHERE "teamId" = ${teamId} AND canal = 'whatsapp'
      ORDER BY "contactId", "isPrimary" DESC, "createdAt", id
    ), mail AS (
      SELECT DISTINCT ON ("contactId") "contactId", valor, "valorHash"
      FROM "ChannelIdentifier"
      WHERE "teamId" = ${teamId} AND canal = 'email'
      ORDER BY "contactId", "isPrimary" DESC, "createdAt", id
    ), chaves AS (
      SELECT 'nome' AS motivo, 0 AS prio, c.id, c."createdAt",
             lower(btrim(regexp_replace(c.nome, ${ESPACOS_SQL}, ' ', 'g'))) AS chave
      FROM "Contact" c
      WHERE c."teamId" = ${teamId}${sqlDoEscopo("contatos", "c", "ownerId", { compartilhado: true })}
      UNION ALL
      SELECT 'telefone', 1, c.id, c."createdAt",
             ${chaveTel}
      FROM tel t JOIN "Contact" c ON c.id = t."contactId" AND c."teamId" = ${teamId}${sqlDoEscopo("contatos", "c", "ownerId", { compartilhado: true })}
      UNION ALL
      SELECT 'email', 2, c.id, c."createdAt",
             ${chaveMail}
      FROM mail m JOIN "Contact" c ON c.id = m."contactId" AND c."teamId" = ${teamId}${sqlDoEscopo("contatos", "c", "ownerId", { compartilhado: true })}
    ), grupos AS (
      SELECT motivo, prio, count(*)::int AS n, min("createdAt") AS desde,
             md5(string_agg(id, ',' ORDER BY id COLLATE "C")) AS assinatura,
             (array_agg(id ORDER BY id COLLATE "C"))[1:${DUP_CONTATOS_POR_GRUPO}::int] AS ids
      FROM chaves
      WHERE chave <> ''
      GROUP BY motivo, prio, chave
      HAVING count(*) > 1
    )
    SELECT array_agg(motivo ORDER BY prio) AS motivos, n, min(ids) AS ids
    FROM grupos
    GROUP BY assinatura, n
    ORDER BY n DESC, min(prio), min(desde), assinatura
    LIMIT ${DUP_MAX_GRUPOS}::int`;
  if (linhas.length === 0) return [];

  // Só os contatos que aparecem nos grupos (≤ 200 × 50), com os mesmos campos
  // do DTO de antes. O telefone/e-mail exibido é o mesmo que entrou na chave.
  const ids = [...new Set(linhas.flatMap((l) => l.ids))];
  const contatos = await prisma.contact.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      nome: true,
      empresa: true,
      cidade: true,
      createdAt: true,
      identifiers: {
        where: { canal: { in: ["whatsapp", "email"] } },
        select: { canal: true, valor: true, valorCifrado: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  const porId = new Map(contatos.map((c) => [c.id, c]));

  return linhas.map((l) => ({
    reasons: l.motivos.map((r) => DUP_REASON_LABEL[r] ?? r),
    total: l.n,
    contacts: l.ids.flatMap((id) => {
      const c = porId.get(id);
      // Apagado entre as duas consultas: some do grupo em vez de quebrar a tela.
      if (!c) return [];
      return [
        {
          id,
          nome: c.nome,
          telefone: valorOuNull(c.identifiers.find((i) => i.canal === "whatsapp")),
          email: valorOuNull(c.identifiers.find((i) => i.canal === "email")),
          empresa: c.empresa,
          cidade: c.cidade,
          createdAt: c.createdAt.toISOString(),
        },
      ];
    }),
  }));
}

/**
 * Unifica contatos: mantém `keepId`, move tudo dos `dropIds` e os apaga.
 *
 * Re-executável (auditoria do #57): antes, com o mantido e um duplicado ativos
 * no MESMO fluxo (o caso mais comum — os dois entraram pelo `contact_created`),
 * mover as inscrições batia no índice único `Enrollment_um_ativo` DEPOIS de já
 * ter movido identificadores, tags, histórico e negócios; o duplicado ficava
 * vivo, com a inscrição rodando, e repetir falhava sempre no mesmo ponto.
 * Agora: 1) resolve o conflito de inscrição ANTES de mover; 2) move o que é só
 * banco numa transação; 3) conversas (mesclagem própria, idempotente); 4) só
 * então apaga. Se algo cair no meio, rodar de novo termina o trabalho.
 *
 * Tudo o que aponta para o contato precisa ser movido ou tratado ANTES do passo
 * 5, porque o `deleteMany` leva em cascata o que ficou para trás. No passo 2
 * seguem a pessoa: identificadores, tags, histórico (Activity), negócios,
 * inscrições, ligações (Call, com a prova do provedor e os ids dele), compromissos,
 * convites de compromisso e vínculos com empresa. Conversas (passo 3) e
 * destinatários de campanha (passo 4) têm tratamento próprio. A catraca
 * `merge-relacoes.catraca.test.ts` quebra se surgir um model com FK para
 * `Contact` que não esteja classificado. Apagar o contato de propósito
 * (`contacts/exclusao.ts`, LGPD) continua levando as ligações junto.
 */
export async function mergeContacts(keepId: string, dropIds: string[]): Promise<void> {
  requireCan("contacts.merge");
  const prisma = db();
  const ids = [...new Set(dropIds)].filter((d) => d !== keepId);
  if (ids.length === 0) return;

  const keep = await prisma.contact.findUnique({ where: { id: keepId }, include: { identifiers: true } });
  if (!keep) throw new ContactNotFound(keepId);
  // S1: unificar é intencional — id que não é do time é erro, não "ignora".
  await assertOwnedMany("contact", ids);
  const drops = await prisma.contact.findMany({ where: { id: { in: ids } }, include: { identifiers: true } });

  // 1. Uma inscrição ativa por fluxo: fica a do mantido (ou a primeira dos
  // duplicados, se o mantido não está no fluxo); as outras são ENCERRADAS antes
  // de mover — senão o updateMany do passo 2 bate no índice único.
  const ativas = await prisma.enrollment.findMany({
    // Só as inscrições de origem (ramos paralelos não entram no índice único e seguem com o contato).
    where: { contactId: { in: [keepId, ...ids] }, status: { in: ["active", "waiting"] }, paiId: null },
    select: { id: true, flowId: true, contactId: true },
    orderBy: { createdAt: "asc" },
  });
  const porFluxo = new Map<string, typeof ativas>();
  for (const e of ativas) porFluxo.set(e.flowId, [...(porFluxo.get(e.flowId) ?? []), e]);
  const encerrar: string[] = [];
  for (const lista of porFluxo.values()) {
    if (lista.length < 2) continue;
    const fica = lista.find((e) => e.contactId === keepId) ?? lista[0]!;
    encerrar.push(...lista.filter((e) => e.id !== fica.id).map((e) => e.id));
  }
  if (encerrar.length) {
    // Mesmo formato do "parar tudo" (item 1.5): o job que ainda estiver na fila
    // acha a inscrição `done` e sai.
    await prisma.enrollment.updateMany({
      where: { OR: [{ id: { in: encerrar } }, { paiId: { in: encerrar } }], status: { in: ["active", "waiting"] } }, // e os ramos delas
      data: { status: "done", nextRunAt: null, waitingFor: null, waitingUntil: null },
    });
  }

  // 2. O que é só banco, numa transação.
  const fill: Record<string, string> = {};
  for (const f of ["empresa", "cidade", "estado", "cargo", "origem"] as const) {
    if (!keep[f]) {
      const v = drops.map((d) => d[f]).find(Boolean);
      if (v) fill[f] = v;
    }
  }
  try {
  await prisma.$transaction(async (tx) => {
    // Preenche campos vazios do mantido com dados dos duplicados.
    if (Object.keys(fill).length) await tx.contact.update({ where: { id: keepId }, data: fill });

    // Identifiers: move os que faltam; apaga os já existentes no mantido.
    const have = new Set(keep.identifiers.map((i) => `${i.canal}:${valorDe(i)}`));
    for (const d of drops) {
      for (const idf of d.identifiers) {
        const k = `${idf.canal}:${valorDe(idf)}`;
        if (have.has(k)) {
          await tx.channelIdentifier.delete({ where: { id: idf.id } });
        } else {
          await tx.channelIdentifier.update({ where: { id: idf.id }, data: { contactId: keepId, isPrimary: false } });
          have.add(k);
        }
      }
    }

    // Tags: move (dedup por [contactId, tagId]).
    const keepTagSet = new Set(
      (await tx.contactTag.findMany({ where: { contactId: keepId }, select: { tagId: true } })).map((t) => t.tagId),
    );
    for (const t of await tx.contactTag.findMany({ where: { contactId: { in: ids } } })) {
      if (keepTagSet.has(t.tagId)) await tx.contactTag.delete({ where: { id: t.id } });
      else {
        await tx.contactTag.update({ where: { id: t.id }, data: { contactId: keepId } });
        keepTagSet.add(t.tagId);
      }
    }

    // Histórico, negócios e inscrições (sem conflito: resolvido no passo 1).
    await tx.activity.updateMany({ where: { contactId: { in: ids } }, data: { contactId: keepId } });
    // Ligações: a Call guarda a prova do provedor (ids, eventos, gravação) e a
    // Activity movida acima aponta para ela por `meta.callId`. Sem mover, o
    // `deleteMany` do passo 5 apagaria a Call em cascata e a Activity ficaria órfã.
    await tx.call.updateMany({ where: { contactId: { in: ids } }, data: { contactId: keepId } });
    await tx.deal.updateMany({ where: { contactId: { in: ids } }, data: { contactId: keepId } });
    await tx.enrollment.updateMany({ where: { contactId: { in: ids } }, data: { contactId: keepId } });

    // Agenda: o vínculo é `SetNull`, então o compromisso do duplicado perderia o
    // contato em silêncio. Compromisso e convite seguem a pessoa.
    await tx.appointment.updateMany({ where: { contactId: { in: ids } }, data: { contactId: keepId } });
    await tx.appointmentAttendee.updateMany({ where: { contactId: { in: ids } }, data: { contactId: keepId } });

    // Empresas: único (contactId, companyId). Mesmo dedup das tags, mas o papel
    // do mantido vence: se ele já tem a empresa, o vínculo do duplicado é apagado.
    const keepEmpresas = new Set(
      (await tx.contactCompany.findMany({ where: { contactId: keepId }, select: { companyId: true } })).map((v) => v.companyId),
    );
    for (const v of await tx.contactCompany.findMany({ where: { contactId: { in: ids } }, orderBy: { createdAt: "asc" } })) {
      if (keepEmpresas.has(v.companyId)) await tx.contactCompany.delete({ where: { id: v.id } });
      else {
        await tx.contactCompany.update({ where: { id: v.id }, data: { contactId: keepId } });
        keepEmpresas.add(v.companyId);
      }
    }

    // Fatos de enriquecimento seguem a pessoa (sem FK, ficariam órfãos — S15).
    await tx.enrichmentFact.updateMany({
      where: { targetType: "contact", targetId: { in: ids } },
      data: { targetId: keepId },
    });
  }, { timeout: 30_000 }); // contato com muito histórico passava dos 5 s padrão
  } catch (e) {
    // Um gatilho criou inscrição NOVA do duplicado entre o passo 1 e a
    // transação: nada se perdeu (a transação voltou atrás); rodar de novo resolve.
    if (isUniqueViolation(e)) throw new UnificacaoIncompleta();
    throw e;
  }

  // 3. Conversas: uma por uma — se o mantido já tem conversa na mesma conta, a
  // do duplicado é mesclada nela (índice único conta+contato — item 0.8). Fora
  // da transação: a mesclagem tem a própria, e é idempotente.
  for (const c of await prisma.conversation.findMany({ where: { contactId: { in: ids } }, select: { id: true } })) {
    await vincularConversaAoContato(c.id, keepId);
  }

  // 4. Destinatários de campanha seguem a pessoa: sem isso a cascata apagava o
  // histórico de envio e o "pediu para sair" (auditoria do #106). Antes do
  // deleteMany; usa o db() próprio (fora da transação do passo 2).
  await moverDestinatariosDeCampanha(keepId, ids);

  // 5. Apaga os duplicados — só os que não têm mais conversa (a exclusão em
  // cascata levaria as mensagens junto). Sobrou algum: avisa em vez de dizer
  // "unificado" com o duplicado vazio ainda na lista.
  const { count } = await prisma.contact.deleteMany({ where: { id: { in: ids }, conversations: { none: {} } } });
  if (count < ids.length) {
    logger.warn({ keepId, pedidos: ids.length, apagados: count }, "[contatos] unificação incompleta — duplicado ainda com conversa");
    throw new UnificacaoIncompleta();
  }
}
