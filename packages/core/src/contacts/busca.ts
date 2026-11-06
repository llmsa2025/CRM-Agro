import { Prisma, RelacionamentoStatus as StatusDoBanco, Interesse as InteresseDoBanco } from "@prisma/client";
import type { RelacionamentoStatus, Interesse } from "@prisma/client";
import { db, getCurrentTeamId } from "@crmagro/db";
import { sqlDoEscopo } from "../tenancy/escopo";
import { logger } from "../logger/index";
import { listarPessoasDoTime } from "../dono/service";
import { BuscaFalhou, BuscaMuitoLenta } from "./errors";
import { hashDoCpfDoTime } from "./cpf";
import { buscaExataDeContatos, ondeBuscaDeIdentificador, valorDe } from "./identificadores-cifra";
import { AGRO_SEM_TIPO, agroFiltroValido } from "../agro/schema";

/**
 * Busca da tela de Contatos: acha por QUALQUER dado que aparece na tela e na ficha.
 *
 * Como funciona:
 *  - o texto digitado vira PALAVRAS (sem acento, sem diferença de maiúscula); TODAS precisam aparecer (E), cada
 *    uma em qualquer lugar: dados do contato, da empresa (e do enriquecimento: razão social, sócios), tags,
 *    responsável, e-mail, telefone e CPF;
 *  - contato e empresa são achados pelo texto normalizado que o banco guarda na linha (`buscaTexto`, mantido
 *    por trigger, com índice trigram por time); e-mail e telefone pelo caminho que já respeita a cifra
 *    (`identificadores-cifra.ts`); CPF só por igualdade exata do hash (nunca por trecho);
 *  - cada palavra vira um conjunto de ids (consulta indexada) e a resposta é a interseção dos conjuntos, já com
 *    o escopo por dono e os filtros da tela, ordenada do contato mais novo para o mais antigo, com TETO.
 *
 * Segurança: tudo filtra `teamId` primeiro e o escopo por dono vai dentro do SQL (`sqlDoEscopo`); o SQL cru roda
 * por `db()` (com o RLS ligado, o Postgres confere o time de novo). O termo e os ids NUNCA vão para o log.
 */

/** Sentinela do filtro "sem tag" (contatos sem nenhuma tag vinculada). */
export const TAG_NONE = "__none__";

/** Menos que isso não é busca (o campo ignora e a tela mostra tudo). */
export const BUSCA_MIN_CARACTERES = 2;
/** No máximo estas palavras entram (o resto é ignorado), cada uma com até este tamanho. */
export const BUSCA_MAX_PALAVRAS = 6;
export const BUSCA_MAX_CARACTERES = 120;
/** Teto de contatos que uma busca devolve (e que "selecionar todos" alcança). Passou disso: "refine a busca". */
export const BUSCA_TETO = 5000;
/** Teto de identificadores (telefone, e-mail, @) lidos por palavra. */
const TETO_IDENTIFICADORES = 5000;
/** Passou disso, o banco desiste e a tela pede uma palavra mais específica. */
const TEMPO_LIMITE_MS = 8000;
/**
 * Com o histórico na busca o limite é menor: estourou, refaz sem o histórico em vez de deixar a pessoa esperando.
 * Objeto (e não constante) só para o teste: `simularEstouroDoHistorico` força o caminho do estouro de tempo sem
 * depender da velocidade do banco.
 */
export const AJUSTES_DA_BUSCA = { tempoHistoricoMs: 5000, pausaDoHistoricoMs: 60_000, simularEstouroDoHistorico: false };

/** Só para teste: esquece as pausas do histórico. */
export function esquecerPausasDoHistorico(): void {
  historicoPausadoAte.clear();
}
/** O trecho do histórico mostrado tem no máximo isto de caracteres (e começa um pouco antes da palavra). */
const TRECHO_TAMANHO = 120;
const TRECHO_ANTES = 40;
/** Palavra do histórico precisa de 3 letras ou mais (com 2, "começo de palavra" acharia mensagem demais). */
const HISTORICO_MIN_CARACTERES = 3;

// ---------------------------------------------------------------------------
// Normalização (espelho do `crmagro_norm` do banco: mesma tabela, caractere por caractere)
// ---------------------------------------------------------------------------

const COM_ACENTO = "ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäåéèêëíìîïóòôõöúùûüçñ";
const SEM_ACENTO = "AAAAAAEEEEIIIIOOOOOUUUUCNaaaaaaeeeeiiiiooooouuuucn";
const MAPA_ACENTOS = new Map<string, string>([...COM_ACENTO].map((c, i) => [c, SEM_ACENTO[i]!]));

/**
 * Texto sem acento e em minúsculas, do MESMO tamanho do original (a posição de um acerto no texto
 * normalizado é a posição no texto original). Igual ao `crmagro_norm` do Postgres.
 */
export function normalizarBusca(texto: string): string {
  let saida = "";
  for (const ch of texto) saida += MAPA_ACENTOS.get(ch) ?? ch;
  return saida.toLowerCase();
}

/** Só os dígitos de um texto. */
export function soDigitos(texto: string): string {
  return texto.replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// O que a pessoa digitou
// ---------------------------------------------------------------------------

export type PalavraBusca = {
  /** Normalizada (sem acento, minúsculas); numérica: só os dígitos. É o que vai no LIKE do `buscaTexto`. */
  texto: string;
  /** Como a pessoa digitou (só para achar e-mail e @handle, que não entram no `buscaTexto`). */
  original: string;
  /** Só os dígitos, quando a palavra é um número (telefone, CNPJ, CPF, IE) com 3 dígitos ou mais. */
  digitos: string | null;
};

const SO_NUMERO = /^[\d\s().+/-]+$/;

/**
 * Palavras da busca, ou `[]` quando não há busca válida (vazia, curta demais ou só pontuação).
 * Telefone e CNPJ digitados com máscara e espaço ("(66) 99988-7766", "12.345.678/0001-90") valem como UMA
 * palavra numérica, comparada só pelos dígitos.
 */
export function interpretarBusca(entrada: string | null | undefined): PalavraBusca[] {
  const t = (entrada ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, BUSCA_MAX_CARACTERES);
  if (t.length < BUSCA_MIN_CARACTERES) return [];

  if (SO_NUMERO.test(t) && soDigitos(t).length >= 3) {
    const d = soDigitos(t);
    return [{ texto: d, original: t, digitos: d }];
  }

  const palavras: PalavraBusca[] = [];
  for (const bruta of t.split(" ")) {
    const w = bruta.replace(/^[,;:!?"'()[\]{}]+|[,;:!?"'()[\]{}]+$/g, "");
    if (!w) continue;
    const numerica = /^[\d().+/-]+$/.test(w) && soDigitos(w).length >= 3;
    const d = numerica ? soDigitos(w) : null;
    palavras.push({ texto: d ?? normalizarBusca(w), original: w, digitos: d });
  }
  // Palavra de 1 letra só atrapalha ("maria d" acharia todo mundo com d), exceto quando é a única.
  const uteis = palavras.filter((p) => p.texto.length >= 2);
  return uteis.slice(0, BUSCA_MAX_PALAVRAS);
}

/** `LIKE '%texto%'` com os curingas do próprio texto neutralizados. */
function padraoContem(texto: string): string {
  return `%${texto.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Formas que a palavra pode ter no texto guardado. Texto: ele mesmo. Número do tamanho de um telefone (10 a 13
 * dígitos): também com e sem o 9º dígito e com e sem o 55, porque o telefone da empresa vem em qualquer formato.
 */
function formasDaPalavra(p: PalavraBusca): string[] {
  if (p.digitos && p.digitos.length >= 10 && p.digitos.length <= 13) return variantesDeTelefone(p.digitos);
  return [p.texto];
}

/** `<coluna> LIKE a OR <coluna> LIKE b ...` (o OR deixa o índice trigram trabalhar em cada forma). */
function sqlContem(coluna: Prisma.Sql, formas: string[]): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(
    formas.map((f) => Prisma.sql`${coluna} LIKE ${padraoContem(f)}`),
    " OR ",
  )})`;
}

// ---------------------------------------------------------------------------
// Telefone: variantes com e sem o 9º dígito e com e sem o 55
// ---------------------------------------------------------------------------

/**
 * Formas de comparar um telefone digitado com o que está guardado (E.164, `+5566999887766`). O guardado já traz
 * o 55, então "contém" cobre quem digita com ou sem ele; aqui entram as duas formas do 9º dígito.
 */
export function variantesDeTelefone(digitos: string): string[] {
  const d = soDigitos(digitos);
  const nacional = d.length >= 12 && d.startsWith("55") ? d.slice(2) : d;
  const formas = new Set<string>([d, nacional]);
  if (nacional.length === 10) formas.add(`${nacional.slice(0, 2)}9${nacional.slice(2)}`);
  if (nacional.length === 11 && nacional[2] === "9") formas.add(`${nacional.slice(0, 2)}${nacional.slice(3)}`);
  return [...formas].filter((f) => f.length >= 3);
}

// ---------------------------------------------------------------------------
// Resolução da busca
// ---------------------------------------------------------------------------

export type FiltrosDaBusca = {
  search?: string;
  status?: RelacionamentoStatus;
  interesse?: Interesse;
  origem?: string;
  /** id de tag, `TAG_NONE` para "sem tag", ou nada. */
  tag?: string;
  produtor?: string;
  /** Tipo do agro (`AGRO_TIPOS`) ou `AGRO_SEM_TIPO`. */
  agro?: string;
  /** "Por vendedor": dono do contato (vale como filtro dentro do escopo de quem pede). */
  dono?: string;
  /**
   * Procura também nas PALAVRAS do histórico (mensagens, e-mails, notas e ligações). Só a tela de Contatos (e o que
   * age sobre a lista dela: selecionar todos e exportar) liga; os seletores de contato ficam só nos dados do contato.
   */
  historico?: boolean;
};

/** A palavra no histórico: a consulta de texto (começo de palavra, dicionário português) e as agulhas do trecho. */
export type ConsultaDeHistorico = { consulta: string; agulhas: string[] };

export type ResultadoDaBusca = {
  /** Ids na ordem da lista (mais novo primeiro), até `BUSCA_TETO`. */
  ids: string[];
  /** Havia mais do que o teto: a tela mostra "refine a busca". */
  truncada: boolean;
  palavras: PalavraBusca[];
  /** Por palavra: contatos achados pelo telefone, e-mail ou @ (e por qual canal). */
  porIdentificador: Map<string, Set<string>>[];
  /** Por palavra: responsáveis cujo nome casa. */
  donos: Set<string>[];
  /** Impressão do CPF digitado (11 dígitos), quando há. */
  cpfHash: string | null;
  /** Por palavra: a consulta no histórico (null = a palavra não entra no histórico). Vazio sem histórico. */
  historico: (ConsultaDeHistorico | null)[];
  /** O histórico foi pedido mas demorou demais: o resultado vale só para os dados do contato e da empresa. */
  historicoIndisponivel: boolean;
};

const STATUS_VALIDOS = new Set<string>(Object.values(StatusDoBanco));
const INTERESSES_VALIDOS = new Set<string>(Object.values(InteresseDoBanco));

/** Filtros da tela em SQL (a mesma regra de `filtrosDoContato` do service, para o SQL e o Prisma concordarem). */
function sqlDosFiltros(f: FiltrosDaBusca): Prisma.Sql {
  const partes: Prisma.Sql[] = [];
  if (f.status) partes.push(STATUS_VALIDOS.has(f.status) ? Prisma.sql` AND c."relacionamentoStatus" = ${f.status}::"RelacionamentoStatus"` : Prisma.sql` AND false`);
  if (f.interesse) partes.push(INTERESSES_VALIDOS.has(f.interesse) ? Prisma.sql` AND c."interesse" = ${f.interesse}::"Interesse"` : Prisma.sql` AND false`);
  if (f.origem) partes.push(Prisma.sql` AND c."origem" = ${f.origem}`);
  if (f.produtor) partes.push(Prisma.sql` AND c."produtorLabel" = ${f.produtor}`);
  const agro = agroFiltroValido(f.agro);
  if (agro === AGRO_SEM_TIPO) partes.push(Prisma.sql` AND COALESCE(cardinality(c."agroTipos"), 0) = 0`);
  else if (agro) partes.push(Prisma.sql` AND c."agroTipos" @> ARRAY[${agro}::text]`);
  if (f.dono) partes.push(Prisma.sql` AND c."ownerId" = ${f.dono}`);
  if (f.tag === TAG_NONE) partes.push(Prisma.sql` AND NOT EXISTS (SELECT 1 FROM "ContactTag" x WHERE x."contactId" = c.id)`);
  else if (f.tag) partes.push(Prisma.sql` AND EXISTS (SELECT 1 FROM "ContactTag" x WHERE x."contactId" = c.id AND x."tagId" = ${f.tag})`);
  return partes.length ? Prisma.join(partes, "") : Prisma.empty;
}

/** Palavra de 2 letras casaria com e-mail demais: só vale se for número ou tiver o tamanho de um pedaço de e-mail. */
function palavraServeParaIdentificador(p: PalavraBusca): boolean {
  return p.original.length >= 3 || Boolean(p.digitos);
}

/**
 * Braço de SQL do identificador (telefone, e-mail, @handle) com a cifra DESLIGADA (`off`/`dupla`): "contém" no
 * texto, com os curingas escapados (o `contains` do Prisma não escapa `_` nem `%`: "j_se" ou "%%%" casariam com
 * tudo). Telefone digitado com máscara é comparado pelos dígitos, com as variantes do 9º dígito.
 */
function sqlDoIdentificadorEmTexto(teamId: string, p: PalavraBusca): Prisma.Sql | null {
  if (buscaExataDeContatos() || !palavraServeParaIdentificador(p)) return null;
  const porDigitos = p.digitos ? Prisma.sql` OR (canal = 'whatsapp' AND ${sqlContem(Prisma.raw("valor"), variantesDeTelefone(p.digitos))})` : Prisma.empty;
  return Prisma.sql`SELECT "contactId" AS id, NULL::timestamp AS ts FROM "ChannelIdentifier" WHERE "teamId" = ${teamId} AND (valor ILIKE ${padraoContem(p.original)}${porDigitos})`;
}

/**
 * Com a cifra em `indice`/`ligada` o texto do telefone e do e-mail não serve mais para "contém": acha pelo caminho
 * de `identificadores-cifra.ts` (e-mail e telefone COMPLETOS pelo índice cego, mais o trecho dos handles de
 * Instagram e LinkedIn). Pedaço de telefone ou de e-mail não acha (limitação documentada em
 * a documentação interna). Devolve os ids com o canal de cada um (usado também no "achado em").
 */
async function acharPorIdentificadorCifrado(teamId: string, p: PalavraBusca): Promise<Map<string, Set<string>>> {
  const achados = new Map<string, Set<string>>();
  if (!buscaExataDeContatos() || !palavraServeParaIdentificador(p) || /[%\\]/.test(p.original)) return achados;
  const onde = ondeBuscaDeIdentificador(teamId, p.original);
  if (!onde) return achados;
  const linhas = await db().channelIdentifier.findMany({ where: onde, select: { contactId: true, canal: true }, take: TETO_IDENTIFICADORES });
  for (const l of linhas) {
    const canais = achados.get(l.contactId) ?? new Set<string>();
    canais.add(l.canal);
    achados.set(l.contactId, canais);
  }
  return achados;
}

/**
 * A palavra no histórico: cada pedaço alfanumérico de 3+ letras vira "começo de palavra" (`financ:*`) e TODOS os
 * pedaços precisam estar na mesma mensagem. O que entra na consulta é só [a-z0-9] (nunca operador de busca).
 * `null` quando não sobra nenhum pedaço (palavra curta ou só pontuação).
 */
export function consultaDeHistorico(p: PalavraBusca): ConsultaDeHistorico | null {
  const pedacos = p.texto.split(/[^a-z0-9]+/).filter((t) => t.length >= HISTORICO_MIN_CARACTERES);
  if (!pedacos.length) return null;
  // Agulhas para achar o trecho no texto: o pedaço inteiro e ele sem o final (o dicionário junta "plantio" e "plantar").
  const agulhas = new Set<string>();
  for (const t of pedacos) {
    agulhas.add(t);
    if (t.length >= 5) agulhas.add(t.slice(0, -1));
    if (t.length >= 6) agulhas.add(t.slice(0, -2));
  }
  return { consulta: pedacos.map((t) => `${t}:*`).join(" & "), agulhas: [...agulhas] };
}

/** Braços de SQL do histórico: mensagens (com o assunto do e-mail), notas e e-mails do histórico, ligações. */
function sqlDoHistorico(teamId: string, h: ConsultaDeHistorico): Prisma.Sql[] {
  const q = Prisma.sql`to_tsquery('portuguese', ${h.consulta})`;
  return [
    Prisma.sql`SELECT cv."contactId" AS id, m."createdAt" AS ts FROM "Message" m JOIN "Conversation" cv ON cv.id = m."conversationId" AND cv."teamId" = ${teamId}
               WHERE m."teamId" = ${teamId} AND cv."contactId" IS NOT NULL AND crmagro_tsv_mensagem(m."conteudo", m."meta") @@ ${q}`,
    Prisma.sql`SELECT a."contactId" AS id, a."createdAt" AS ts FROM "Activity" a
               WHERE a."teamId" = ${teamId} AND a."tipo" IN ('note', 'call', 'email') AND crmagro_tsv(a."conteudo") @@ ${q}`,
    Prisma.sql`SELECT k."contactId" AS id, coalesce(k."endedAt", k."createdAt") AS ts FROM "Call" k
               WHERE k."teamId" = ${teamId} AND crmagro_tsv_ligacao(k."transcript", k."summary", k."notes") @@ ${q}`,
  ];
}

/** SQL do conjunto de contatos que uma palavra acha (todas as fontes, cada uma por índice). Colunas: id, ts. */
function sqlDoConjunto(
  teamId: string,
  p: PalavraBusca,
  porIdentificador: Map<string, Set<string>>,
  donos: Set<string>,
  cpfHash: string | null,
  historico: ConsultaDeHistorico | null,
): Prisma.Sql {
  const formas = formasDaPalavra(p);
  // `ts` é a data do acerto no histórico (null nas demais fontes): ordena quem foi achado por uma conversa recente.
  const semData = Prisma.sql`NULL::timestamp AS ts`;
  const partes: Prisma.Sql[] = [
    // Dados do contato (nome, cidade, cargo, origem, tags, CNPJ legado...).
    Prisma.sql`SELECT c.id, ${semData} FROM "Contact" c WHERE c."teamId" = ${teamId} AND ${sqlContem(Prisma.raw('c."buscaTexto"'), formas)}`,
    // Dados da empresa e do enriquecimento (razão social, sócios, CNPJ, telefone...).
    Prisma.sql`SELECT cc."contactId" AS id, ${semData} FROM "Company" co JOIN "ContactCompany" cc ON cc."companyId" = co.id AND cc."teamId" = ${teamId}
               WHERE co."teamId" = ${teamId} AND ${sqlContem(Prisma.raw('co."buscaTexto"'), formas)}`,
    // Tags nomeadas.
    Prisma.sql`SELECT ct."contactId" AS id, ${semData} FROM "Tag" t JOIN "ContactTag" ct ON ct."tagId" = t.id AND ct."teamId" = ${teamId}
               WHERE t."teamId" = ${teamId} AND crmagro_norm(t.nome) LIKE ${padraoContem(p.texto)}`,
  ];
  const emTexto = sqlDoIdentificadorEmTexto(teamId, p);
  if (emTexto) partes.push(emTexto);
  if (porIdentificador.size) partes.push(Prisma.sql`SELECT unnest(${[...porIdentificador.keys()]}::text[]) AS id, ${semData}`);
  if (donos.size) partes.push(Prisma.sql`SELECT c.id, ${semData} FROM "Contact" c WHERE c."teamId" = ${teamId} AND c."ownerId" = ANY(${[...donos]}::text[])`);
  if (cpfHash) partes.push(Prisma.sql`SELECT c.id, ${semData} FROM "Contact" c WHERE c."teamId" = ${teamId} AND c."cpfHash" = ${cpfHash}`);
  if (historico) partes.push(...sqlDoHistorico(teamId, historico));
  // UNION ALL: o `IN (...)`/agrupamento de fora já ignora repetidos, então não paga a deduplicação aqui.
  return Prisma.join(partes, " UNION ALL ");
}

function ehTempoLimite(e: unknown): boolean {
  const meta = (e as { meta?: { code?: string; message?: string } } | null)?.meta;
  const texto = `${(e as Error | null)?.message ?? ""} ${meta?.message ?? ""}`;
  return meta?.code === "57014" || /statement timeout|canceling statement/i.test(texto);
}

/**
 * Executa a busca. `null` quando o texto não é uma busca válida (o chamador lista sem busca).
 * `limite` é o máximo de ids devolvidos (padrão `BUSCA_TETO`). Com `historico` e o banco lento demais para
 * procurar no histórico (base grande sem os índices), refaz a busca SEM o histórico e avisa em
 * `historicoIndisponivel`, em vez de falhar a tela inteira.
 */
export async function buscarContatos(filtros: FiltrosDaBusca, opts: { limite?: number } = {}): Promise<ResultadoDaBusca | null> {
  const palavras = interpretarBusca(filtros.search);
  if (!palavras.length) return null;
  const teamId = getCurrentTeamId() ?? "";
  // Este time estourou o tempo há pouco: não tenta de novo a cada tecla (cada tentativa custaria o tempo todo).
  const pausado = Boolean(filtros.historico) && (historicoPausadoAte.get(teamId) ?? 0) > Date.now();
  try {
    if (pausado) throw new BuscaMuitoLenta();
    return await executarBusca(filtros, palavras, opts.limite, Boolean(filtros.historico));
  } catch (e) {
    if (!(e instanceof BuscaMuitoLenta) || !filtros.historico) throw e;
    if (!pausado) historicoPausadoAte.set(teamId, Date.now() + AJUSTES_DA_BUSCA.pausaDoHistoricoMs);
    const semHistorico = await executarBusca(filtros, palavras, opts.limite, false);
    return { ...semHistorico, historicoIndisponivel: true };
  }
}

/** Por time: até quando a busca no histórico fica desligada depois de estourar o tempo (memória do processo). */
const historicoPausadoAte = new Map<string, number>();

async function executarBusca(filtros: FiltrosDaBusca, palavras: PalavraBusca[], limiteDe: number | undefined, comHistorico: boolean): Promise<ResultadoDaBusca> {
  const limite = Math.min(limiteDe ?? BUSCA_TETO, BUSCA_TETO);
  const historico = palavras.map((p) => (comHistorico ? consultaDeHistorico(p) : null));
  const vazio: ResultadoDaBusca = { ids: [], truncada: false, palavras, porIdentificador: [], donos: [], cpfHash: null, historico, historicoIndisponivel: false };

  // Sem time no contexto não há o que buscar (nunca "todos").
  const teamId = getCurrentTeamId();
  if (!teamId) return vazio;

  try {
    // Responsável: quem pede só enxerga as pessoas que o escopo dele permite (o próprio, ou o time todo).
    const pessoas = palavras.some((p) => !p.digitos) ? await listarPessoasDoTime("contatos") : [];
    const porIdentificador = await Promise.all(palavras.map((p) => acharPorIdentificadorCifrado(teamId, p)));
    const donos = palavras.map((p) => new Set(p.digitos ? [] : pessoas.filter((x) => normalizarBusca(x.nome).includes(p.texto)).map((x) => x.id)));
    // CPF: só por igualdade exata do hash (11 dígitos), nunca por trecho.
    const cpfDigitado = palavras.find((p) => p.digitos?.length === 11)?.digitos;
    const cpfHash = cpfDigitado ? hashDoCpfDoTime(cpfDigitado) : null;

    const conjuntos = palavras.map((p, i) =>
      Prisma.sql`${Prisma.raw(`p${i}`)} AS MATERIALIZED (${sqlDoConjunto(teamId, p, porIdentificador[i]!, donos[i]!, p.digitos?.length === 11 ? cpfHash : null, historico[i]!)})`,
    );
    // Sem histórico basta "está no conjunto". Com histórico entra também a data do acerto mais recente de cada
    // palavra, e a lista passa a ser ordenada pela mais recente entre a criação do contato e esses acertos.
    const comData = historico.some(Boolean);
    const juncoes = comData ? palavras.map((_, i) => Prisma.sql` JOIN (SELECT id, max(ts) AS ts FROM ${Prisma.raw(`p${i}`)} GROUP BY id) ${Prisma.raw(`h${i}`)} ON ${Prisma.raw(`h${i}`)}.id = c.id`) : [];
    const todas = comData ? [] : palavras.map((_, i) => Prisma.sql`c.id IN (SELECT id FROM ${Prisma.raw(`p${i}`)})`);
    const ordem = comData
      ? Prisma.sql`GREATEST(c."createdAt", ${Prisma.join(palavras.map((_, i) => Prisma.raw(`h${i}.ts`)), ", ")})`
      : Prisma.sql`c."createdAt"`;
    const consulta = Prisma.sql`
      WITH ${Prisma.join(conjuntos, ", ")}
      SELECT c.id FROM "Contact" c${juncoes.length ? Prisma.join(juncoes, "") : Prisma.empty}
       WHERE c."teamId" = ${teamId}${sqlDoEscopo("contatos", "c", "ownerId", { compartilhado: true })}${sqlDosFiltros(filtros)}${todas.length ? Prisma.sql` AND ${Prisma.join(todas, " AND ")}` : Prisma.empty}
       ORDER BY ${ordem} DESC, c.id DESC
       LIMIT ${limite + 1}`;

    if (comData && AJUSTES_DA_BUSCA.simularEstouroDoHistorico) throw new BuscaMuitoLenta();
    const tempo = comData ? AJUSTES_DA_BUSCA.tempoHistoricoMs : TEMPO_LIMITE_MS;
    const prisma = db();
    const linhas = await prisma.$transaction(
      async (tx) => {
        // statement_timeout só desta transação (set_config aceita parâmetro; SET LOCAL não aceita).
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(tempo)}, true)`;
        return tx.$queryRaw<{ id: string }[]>(consulta);
      },
      { timeout: tempo + 4000, maxWait: 4000 },
    );
    const truncada = linhas.length > limite;
    return { ids: linhas.slice(0, limite).map((l) => l.id), truncada, palavras, porIdentificador, donos, cpfHash, historico, historicoIndisponivel: false };
  } catch (e) {
    if (e instanceof BuscaMuitoLenta || ehTempoLimite(e)) throw new BuscaMuitoLenta();
    // Nunca o termo no log: só a classe do erro.
    logger.error({ erro: e instanceof Error ? e.name : "desconhecido" }, "[busca-contatos] falhou");
    throw new BuscaFalhou();
  }
}

// ---------------------------------------------------------------------------
// "Achado em": o motivo de cada contato aparecer no resultado
// ---------------------------------------------------------------------------

/** Trecho do histórico com a palavra achada separada (a tela destaca `achado`; nada de HTML pronto). */
export type TrechoAchado = { antes: string; achado: string; depois: string };
export type Achado = { rotulo: string; trecho?: TrechoAchado };

/** Máximo de motivos mostrados por contato. */
const MAX_ACHADOS = 3;

type Campo = { rotulo: string; texto: string; digitos?: string };

/** Campo de texto livre: guarda o texto normalizado (e os dígitos, para número). */
function campo(rotulo: string, valor: string | null | undefined, comDigitos = false): Campo | null {
  const v = (valor ?? "").trim();
  if (!v) return null;
  return { rotulo, texto: normalizarBusca(v), ...(comDigitos ? { digitos: soDigitos(v) } : {}) };
}

function casa(p: PalavraBusca, c: Campo): boolean {
  if (p.digitos && c.digitos !== undefined) return formasDaPalavra(p).some((f) => c.digitos!.includes(f));
  return c.texto.includes(p.texto);
}

type LinhaDoContato = {
  id: string;
  nome: string;
  sobrenome: string | null;
  cidade: string | null;
  estado: string | null;
  endereco: string | null;
  empresa: string | null;
  cargo: string | null;
  origem: string | null;
  site: string | null;
  cnpj: string | null;
  tags: string[];
  culturas: string[];
  ownerId?: string | null;
  contactTags?: { tag: { nome: string } }[];
  identifiers?: { canal: string; valor?: string | null; valorCifrado?: string | null }[];
};

type EmpresaDaLinha = {
  nome: string;
  cnpj: string | null;
  ie: string | null;
  site: string | null;
  email: string | null;
  telefone: string | null;
  endereco: string | null;
  cidade: string | null;
  estado: string | null;
  instagram: string | null;
  linkedin: string | null;
  naturezaJuridica: string | null;
  enrichment: unknown;
};

/** Campos do contato na ordem de importância (o primeiro que casar é o motivo mostrado). */
function camposDoContato(c: LinhaDoContato): Campo[] {
  const tags = [...c.tags, ...(c.contactTags ?? []).map((t) => t.tag.nome)].join(" ");
  return [
    campo("nome", `${c.nome} ${c.sobrenome ?? ""}`),
    campo("CNPJ", c.cnpj, true),
    campo("empresa", c.empresa),
    campo("cargo", c.cargo),
    campo("cidade", c.cidade),
    campo("estado", c.estado),
    campo("endereço", c.endereco),
    campo("origem", c.origem),
    campo("tag", tags),
    campo("cultura", c.culturas.join(" ")),
    campo("site", c.site),
  ].filter((x): x is Campo => x !== null);
}

type ItemPublico = { rotulo?: unknown; valor?: unknown };
type Socio = { nome?: unknown; qualificacao?: unknown };

/** Campos da empresa, incluindo o que veio do enriquecimento (dados da Receita e sócios). */
function camposDaEmpresa(e: EmpresaDaLinha): Campo[] {
  const lista: (Campo | null)[] = [
    campo("nome da empresa", e.nome),
    campo("CNPJ da empresa", e.cnpj, true),
    campo("inscrição estadual", e.ie, true),
    campo("telefone da empresa", e.telefone, true),
    campo("e-mail da empresa", e.email),
    campo("endereço da empresa", e.endereco),
    campo("cidade da empresa", e.cidade),
    campo("estado da empresa", e.estado),
    campo("site da empresa", e.site),
    campo("Instagram da empresa", e.instagram),
    campo("LinkedIn da empresa", e.linkedin),
    campo("natureza jurídica", e.naturezaJuridica),
  ];
  const enr = (e.enrichment ?? {}) as { publico?: ItemPublico[]; socios?: Socio[] };
  for (const item of Array.isArray(enr.publico) ? enr.publico : []) {
    const rotulo = typeof item?.rotulo === "string" ? item.rotulo.toLowerCase() : "dado da empresa";
    lista.push(campo(rotulo, typeof item?.valor === "string" ? item.valor : null));
  }
  for (const s of Array.isArray(enr.socios) ? enr.socios : []) {
    lista.push(campo("sócio", typeof s?.nome === "string" ? s.nome : null));
    lista.push(campo("sócio", typeof s?.qualificacao === "string" ? s.qualificacao : null));
  }
  return lista.filter((x): x is Campo => x !== null);
}

const ROTULO_DO_CANAL: Record<string, string> = { whatsapp: "telefone", email: "e-mail", instagram: "Instagram", linkedin: "LinkedIn" };

/**
 * Motivo de cada contato da página aparecer: para cada palavra, o campo mais importante em que ela está
 * (nome antes de cidade, dados do contato antes dos da empresa), no máximo 3. A palavra que não está em nenhum
 * campo só pode ter vindo do histórico: aí o motivo é a fonte (conversa, e-mail, nota, ligação) com um trecho curto.
 * Só da página mostrada (no máximo 250 linhas).
 */
export async function achadosDaPagina(busca: ResultadoDaBusca, linhas: LinhaDoContato[]): Promise<Record<string, Achado[]>> {
  const ids = linhas.map((l) => l.id);
  const saida: Record<string, Achado[]> = {};
  if (!ids.length) return saida;

  // Empresas vinculadas aos contatos da página (uma consulta só).
  const vinculos = await db().contactCompany.findMany({
    where: { contactId: { in: ids } },
    select: {
      contactId: true,
      company: { select: { nome: true, cnpj: true, ie: true, site: true, email: true, telefone: true, endereco: true, cidade: true, estado: true, instagram: true, linkedin: true, naturezaJuridica: true, enrichment: true } },
    },
  });
  const empresasPor = new Map<string, EmpresaDaLinha[]>();
  for (const v of vinculos) empresasPor.set(v.contactId, [...(empresasPor.get(v.contactId) ?? []), v.company]);

  // 1) Motivo por campo, por palavra. 2) As palavras sem campo vão para o histórico.
  const porLinha = new Map<string, (string | null)[]>();
  const pendentes = busca.palavras.map(() => [] as string[]);
  for (const linha of linhas) {
    const doContato = camposDoContato(linha);
    const daEmpresa = (empresasPor.get(linha.id) ?? []).flatMap(camposDaEmpresa);
    const motivos = busca.palavras.map((p, i) => motivoDaPalavra(p, i, linha.id, busca, doContato, daEmpresa, linha.ownerId ?? null, linha.identifiers));
    porLinha.set(linha.id, motivos);
    motivos.forEach((m, i) => {
      if (m === null && busca.historico[i]) pendentes[i]!.push(linha.id);
    });
  }
  const trechos = await trechosDoHistorico(busca, pendentes);

  for (const linha of linhas) {
    const achados: Achado[] = [];
    porLinha.get(linha.id)!.forEach((motivo, i) => {
      const achado: Achado | null = motivo ? { rotulo: motivo } : busca.historico[i] ? (trechos[i]?.get(linha.id) ?? { rotulo: "histórico" }) : null;
      if (achado && !achados.some((a) => a.rotulo === achado.rotulo)) achados.push(achado);
    });
    if (achados.length) saida[linha.id] = achados.slice(0, MAX_ACHADOS);
  }
  return saida;
}

// ---------------------------------------------------------------------------
// Trecho do histórico
// ---------------------------------------------------------------------------

type LinhaDeTrecho = { contactId: string; fonte: string; tam: number; ini: number; trecho: string };

const ROTULO_DA_FONTE: Record<string, string> = {
  conversa: "histórico (conversa)",
  email: "histórico (e-mail)",
  nota: "nota",
  ligacao: "ligação",
};

/** CPF não sai em trecho de histórico: o formatado (000.000.000-00) e 11 dígitos seguidos viram "***". */
function mascararCpf(texto: string): string {
  return texto.replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "***").replace(/\b\d{11}\b/g, "***");
}

/** Monta o trecho (até ~120 caracteres) com a primeira agulha achada destacada. */
export function montarTrecho(l: LinhaDeTrecho, agulhas: string[]): TrechoAchado {
  const texto = l.trecho.replace(/\s+/g, " ");
  const norm = normalizarBusca(texto);
  let i = -1;
  let tamanho = 0;
  for (const a of agulhas) {
    const k = norm.indexOf(a);
    if (k >= 0 && (i < 0 || k < i)) {
      i = k;
      tamanho = a.length;
    }
  }
  const reticenciasAntes = l.ini > 1 ? "…" : "";
  const reticenciasDepois = l.ini + TRECHO_TAMANHO - 1 < l.tam ? "…" : "";
  if (i < 0) return { antes: "", achado: "", depois: reticenciasAntes + mascararCpf(texto).trim() + reticenciasDepois };
  // Estende o destaque até o fim da palavra.
  let fim = i + tamanho;
  while (fim < norm.length && /[a-z0-9]/.test(norm[fim]!)) fim++;
  return {
    antes: reticenciasAntes + mascararCpf(texto.slice(0, i)).trimStart(),
    achado: mascararCpf(texto.slice(i, fim)),
    depois: mascararCpf(texto.slice(fim)).trimEnd() + reticenciasDepois,
  };
}

/**
 * O trecho mais recente do histórico em que cada contato pendente tem a palavra (uma consulta por palavra, só dos
 * contatos da página). Mantém o time primeiro e o tempo curto; qualquer falha vira "sem trecho" (a lista não quebra
 * por causa do selo). Nunca registra o termo nem o texto no log.
 */
async function trechosDoHistorico(busca: ResultadoDaBusca, pendentes: string[][]): Promise<Map<string, Achado>[]> {
  const teamId = getCurrentTeamId();
  const saida = busca.palavras.map(() => new Map<string, Achado>());
  if (!teamId) return saida;
  await Promise.all(
    busca.historico.map(async (h, i) => {
      const ids = pendentes[i]!;
      if (!h || !ids.length) return;
      try {
        const q = Prisma.sql`to_tsquery('portuguese', ${h.consulta})`;
        const linhas = await db().$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('statement_timeout', '4000', true)`;
            return tx.$queryRaw<LinhaDeTrecho[]>`
              SELECT t."contactId", t.fonte, length(t.texto)::int AS tam, greatest(1, p.pos - ${TRECHO_ANTES}::int)::int AS ini,
                     substr(t.texto, greatest(1, p.pos - ${TRECHO_ANTES}::int), ${TRECHO_TAMANHO}::int) AS trecho
                FROM (
                  SELECT DISTINCT ON (x."contactId") x."contactId", x.fonte, x.texto
                    FROM (
                      SELECT cv."contactId", CASE WHEN cv.canal = 'email' THEN 'email' ELSE 'conversa' END AS fonte, m."createdAt" AS quando,
                             coalesce(m."conteudo", '') || ' ' || coalesce(m."meta" ->> 'subject', '') AS texto
                        FROM "Message" m JOIN "Conversation" cv ON cv.id = m."conversationId" AND cv."teamId" = ${teamId}
                       WHERE m."teamId" = ${teamId} AND cv."contactId" = ANY(${ids}::text[]) AND crmagro_tsv_mensagem(m."conteudo", m."meta") @@ ${q}
                      UNION ALL
                      SELECT a."contactId", CASE WHEN a."tipo" = 'note' THEN 'nota' WHEN a."tipo" = 'call' THEN 'ligacao' ELSE 'email' END, a."createdAt", coalesce(a."conteudo", '')
                        FROM "Activity" a
                       WHERE a."teamId" = ${teamId} AND a."contactId" = ANY(${ids}::text[]) AND a."tipo" IN ('note', 'call', 'email') AND crmagro_tsv(a."conteudo") @@ ${q}
                      UNION ALL
                      SELECT k."contactId", 'ligacao', coalesce(k."endedAt", k."createdAt"),
                             coalesce(k."transcript", '') || ' ' || coalesce(k."summary", '') || ' ' || coalesce(k."notes", '')
                        FROM "Call" k
                       WHERE k."teamId" = ${teamId} AND k."contactId" = ANY(${ids}::text[]) AND crmagro_tsv_ligacao(k."transcript", k."summary", k."notes") @@ ${q}
                    ) x
                   ORDER BY x."contactId", x.quando DESC
                ) t
                CROSS JOIN LATERAL (
                  SELECT coalesce(min(s.p), 1) AS pos
                    FROM (SELECT nullif(strpos(crmagro_norm(t.texto), n), 0) AS p FROM unnest(${h.agulhas}::text[]) AS n) s
                ) p`;
          },
          { timeout: 8000, maxWait: 4000 },
        );
        for (const l of linhas) saida[i]!.set(l.contactId, { rotulo: ROTULO_DA_FONTE[l.fonte] ?? "histórico", trecho: montarTrecho(l, h.agulhas) });
      } catch (e) {
        logger.warn({ erro: e instanceof Error ? e.name : "desconhecido" }, "[busca-contatos] trecho do histórico indisponível");
      }
    }),
  );
  return saida;
}

/**
 * Canal do identificador (telefone, e-mail, @) que a palavra achou neste contato, ou null. Com a cifra ligada vale
 * o que o índice cego achou (`porIdentificador`); desligada, o texto está nas linhas da página e se compara aqui,
 * do mesmo jeito que o SQL (contém, sem diferenciar maiúscula; número pelos dígitos com as variantes do 9º dígito).
 */
function canalAchadoPelaPalavra(p: PalavraBusca, i: number, id: string, busca: ResultadoDaBusca, identifiers: LinhaDoContato["identifiers"]): string | null {
  if (buscaExataDeContatos()) return [...(busca.porIdentificador[i]?.get(id) ?? [])][0] ?? null;
  if (!palavraServeParaIdentificador(p)) return null;
  for (const ident of identifiers ?? []) {
    const valor = valorDe(ident) ?? "";
    if (valor.toLowerCase().includes(p.original.toLowerCase())) return ident.canal;
    if (p.digitos && ident.canal === "whatsapp" && variantesDeTelefone(p.digitos).some((v) => soDigitos(valor).includes(v))) return ident.canal;
  }
  return null;
}

function motivoDaPalavra(p: PalavraBusca, i: number, id: string, busca: ResultadoDaBusca, doContato: Campo[], daEmpresa: Campo[], ownerId: string | null, identifiers: LinhaDoContato["identifiers"]): string | null {
  const nome = doContato.find((c) => c.rotulo === "nome");
  if (nome && casa(p, nome)) return "nome";
  const canal = canalAchadoPelaPalavra(p, i, id, busca, identifiers);
  if (canal) return ROTULO_DO_CANAL[canal] ?? "contato";
  if (busca.cpfHash && p.digitos?.length === 11) return "CPF";
  const outro = doContato.find((c) => c.rotulo !== "nome" && casa(p, c));
  if (outro) return outro.rotulo;
  const empresa = daEmpresa.find((c) => casa(p, c));
  if (empresa) return empresa.rotulo;
  if (ownerId && busca.donos[i]?.has(ownerId)) return "responsável";
  return null;
}
