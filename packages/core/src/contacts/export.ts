import Papa from "papaparse";
import { z } from "zod";
import { db, getCurrentTeamId } from "@crmagro/db";
import { ondeBuscaDeIdentificador } from "./identificadores-cifra";
import { buscarContatos, BUSCA_TETO } from "./busca";
import { BuscaGrandeDemais } from "./errors";
import { Interesse, RelacionamentoStatus, type Prisma } from "@prisma/client";
import { primaryEmail, primaryTelefone } from "../contacts/identifiers";
import { AGRO_SEM_TIPO, AGRO_TIPOS } from "../agro/schema";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";

/**
 * Exportação de contatos — CSV e Excel.
 *
 * Exporta TODOS os contatos do time que casam com os filtros, em STREAMING
 * (item 2.7, K2): lê em lotes de 1.000 por cursor (createdAt desc, id desc —
 * índice do item 2.1) e escreve cada lote na resposta. Antes, um `findMany`
 * sem limite + a planilha inteira em memória: 50 mil contatos seguravam
 * centenas de MB no processo do web e a tela esperava tudo antes do 1º byte.
 */

export type ExportFormat = "csv" | "xlsx";

export interface ExportFilters {
  search?: string;
  status?: RelacionamentoStatus;
  interesse?: Interesse;
  origem?: string;
  /** id de tag específica, "__none__" para "sem tag", ou undefined para todas. */
  tag?: string;
  /** rótulo de produtor rural (o chip "Não produtor" da tela de Contatos). */
  produtor?: "produtor" | "provavel_produtor" | "nao_produtor";
  /** O que o contato é no agro (o chip da tela de Contatos): um tipo ou "nenhum" (sem classificação). */
  agro?: (typeof AGRO_TIPOS)[number] | typeof AGRO_SEM_TIPO;
  /** "Por vendedor" (F3d): só os contatos desta pessoa. */
  dono?: string;
  /** exportar SÓ estes contatos (seleção). Tem precedência sobre os filtros. */
  ids?: string[];
}

/** Colunas exportadas — ordem fixa para compatibilidade com imports. */
const COLUMNS = [
  { key: "nome", label: "Nome" },
  { key: "telefone", label: "Telefone" },
  { key: "email", label: "Email" },
  { key: "cidade", label: "Cidade" },
  { key: "estado", label: "Estado" },
  { key: "empresa", label: "Empresa" },
  { key: "cargo", label: "Cargo" },
  { key: "status", label: "Status" },
  { key: "interesse", label: "Interesse" },
  { key: "origem", label: "Origem" },
  { key: "tags", label: "Tags" },
  { key: "createdAt", label: "Criado em" },
] as const;

export type ExportRow = Record<(typeof COLUMNS)[number]["key"], string>;

/** Filtros da exportação vindos da URL — validados na borda (zod). */
export const exportFiltersSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.nativeEnum(RelacionamentoStatus).optional(),
  interesse: z.nativeEnum(Interesse).optional(),
  origem: z.string().min(1).max(100).optional(),
  tag: z.string().min(1).max(100).optional(),
  produtor: z.enum(["produtor", "provavel_produtor", "nao_produtor"]).optional(),
  agro: z.enum([...AGRO_TIPOS, AGRO_SEM_TIPO]).optional(),
  /** "Por vendedor" (F3d): exporta só os contatos de uma pessoa. */
  dono: z.string().uuid().optional(),
  ids: z.array(z.string().min(1)).max(10_000).optional(),
});

export const LOTE_EXPORTACAO = 1000;

/** Id que não existe: "nenhum contato" quando a busca não achou nada (lista vazia de ids valeria "todos"). */
const NENHUM_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Resolve a BUSCA por texto da tela antes de exportar, para a planilha ter exatamente os contatos que a tela
 * mostra (mesmos campos, mesmo escopo, mesmos filtros). Chame DENTRO do `runWithTeam`, antes de abrir os lotes
 * (a leitura em lotes acontece depois, fora do contexto). Sem busca válida devolve os filtros como vieram. Mais
 * contatos do que o teto da busca: recusa (`BuscaGrandeDemais`), em vez de exportar só uma parte sem avisar.
 */
export async function resolverBuscaDaExportacao(filters: ExportFilters): Promise<ExportFilters> {
  requireCan("contacts.export");
  if (filters.ids?.length || !filters.search) return filters;
  // A planilha traz o mesmo que a tela: a busca da tela também procura no histórico.
  const busca = await buscarContatos({ ...filters, historico: true });
  if (!busca) return { ...filters, search: undefined };
  if (busca.truncada) throw new BuscaGrandeDemais(BUSCA_TETO);
  return { ...filters, search: undefined, ids: busca.ids.length ? busca.ids : [NENHUM_ID] };
}

const SELECT_EXPORTACAO = {
  id: true,
  nome: true,
  cidade: true,
  estado: true,
  empresa: true,
  cargo: true,
  relacionamentoStatus: true,
  interesse: true,
  origem: true,
  tags: true,
  createdAt: true,
  identifiers: { select: { canal: true, valor: true, valorCifrado: true, isPrimary: true } },
} satisfies Prisma.ContactSelect;

type ContatoExportado = Prisma.ContactGetPayload<{ select: typeof SELECT_EXPORTACAO }>;

function paraLinha(c: ContatoExportado): ExportRow {
  return {
    nome: c.nome,
    telefone: primaryTelefone(c.identifiers) ?? "",
    email: primaryEmail(c.identifiers) ?? "",
    cidade: c.cidade ?? "",
    estado: c.estado ?? "",
    empresa: c.empresa ?? "",
    cargo: c.cargo ?? "",
    status: c.relacionamentoStatus,
    interesse: c.interesse,
    origem: c.origem ?? "",
    tags: c.tags.join(", "),
    createdAt: c.createdAt.toISOString().split("T")[0] ?? "",
  };
}

/**
 * Abre a exportação e devolve os contatos em LOTES (mesma ordem de sempre:
 * mais novos primeiro).
 *
 * O papel (`contacts.export`, admin) e o client do time são resolvidos AGORA,
 * de forma síncrona, dentro do `runWithTeam` de quem chamou: os lotes são lidos
 * depois, quando a resposta pede mais dados — fora do contexto da requisição.
 * Por isso esta função NÃO é async (um gerador async só rodaria o corpo no 1º
 * `next()`, já sem o ALS).
 *
 * Cursor por chave (createdAt, id) em vez de `skip`/cursor do Prisma: contato
 * apagado no meio da exportação não interrompe a leitura.
 */
export function lotesDeContatosParaExportar(
  filters: ExportFilters = {},
  opts: { lote?: number } = {},
): AsyncIterable<ExportRow[]> {
  requireCan("contacts.export");
  const prisma = db();
  const where = buildWhere(filters);
  const tamanho = opts.lote ?? LOTE_EXPORTACAO;
  return {
    async *[Symbol.asyncIterator]() {
      let ultimo: { createdAt: Date; id: string } | null = null;
      for (;;) {
        const depoisDoUltimo: Prisma.ContactWhereInput | null = ultimo
          ? { OR: [{ createdAt: { lt: ultimo.createdAt } }, { createdAt: ultimo.createdAt, id: { lt: ultimo.id } }] }
          : null;
        const contatos: ContatoExportado[] = await prisma.contact.findMany({
          where: depoisDoUltimo ? { AND: [where, depoisDoUltimo] } : where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: SELECT_EXPORTACAO,
          take: tamanho,
        });
        if (contatos.length === 0) return;
        yield contatos.map(paraLinha);
        if (contatos.length < tamanho) return;
        const u = contatos[contatos.length - 1]!;
        ultimo = { createdAt: u.createdAt, id: u.id };
      }
    },
  };
}

/**
 * Busca todos os contatos de uma vez (em memória). Mantida para quem precisa
 * da lista inteira (e para os testes de RBAC); a rota de exportação usa o
 * streaming (`exportarContatosCsv` / `lotesDeContatosParaExportar`).
 */
export async function fetchContactsForExport(filters: ExportFilters = {}): Promise<ExportRow[]> {
  const linhas: ExportRow[] = [];
  for await (const lote of lotesDeContatosParaExportar(filters)) linhas.push(...lote);
  return linhas;
}

function identificadoresDaBusca(search: string): Prisma.ContactWhereInput[] {
  const onde = ondeBuscaDeIdentificador(getCurrentTeamId() ?? "", search);
  return onde ? [{ identifiers: { some: onde } }] : [];
}

function buildWhere(filters: ExportFilters): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = {};
  // Seleção explícita vence os filtros — exporta exatamente os ids marcados.
  if (filters.ids && filters.ids.length) {
    where.id = { in: filters.ids };
    return where;
  }
  if (filters.search) {
    where.OR = [
      { nome: { contains: filters.search, mode: "insensitive" } },
      { empresa: { contains: filters.search, mode: "insensitive" } },
      // Telefone e e-mail: por trecho ou, com a cifra em `indice`/`ligada`, por valor completo (índice cego).
      ...identificadoresDaBusca(filters.search),
    ];
  }
  if (filters.status) where.relacionamentoStatus = filters.status;
  if (filters.interesse) where.interesse = filters.interesse;
  if (filters.origem) where.origem = filters.origem;
  if (filters.tag === "__none__") where.contactTags = { none: {} };
  else if (filters.tag) where.contactTags = { some: { tagId: filters.tag } };
  // A tela manda `produtor` na URL de exportação desde o filtro de produtor
  // rural, mas ele era ignorado: "ver só produtores" exportava a base inteira.
  if (filters.produtor) where.produtorLabel = filters.produtor;
  if (filters.agro === AGRO_SEM_TIPO) where.agroTipos = { isEmpty: true };
  else if (filters.agro) where.agroTipos = { has: filters.agro };
  if (filters.dono) where.ownerId = filters.dono;
  return where;
}

/**
 * Célula que o Excel/Sheets executaria como fórmula (item 3.7, S14): nome,
 * empresa e cidade vêm de fora (Maps, webhook, pushName, importação) e um
 * `=HYPERLINK(...)` ou `=cmd|...` rodaria ao abrir o CSV. Começa com `=`, `@`,
 * TAB ou CR → sempre; com `+`/`-` → só se não for número/telefone puro
 * ("+5565999991234" continua legível, sem apóstrofo). A célula ganha `'` na frente.
 */
export const CSV_FORMULA = /^[=@\t\r]|^[+-](?![\d\s().-]*$)/;

/** Gera CSV das linhas. Usa papaparse (já é dep do core). */
export function rowsToCsv(rows: ExportRow[]): string {
  return Papa.unparse(
    {
      fields: COLUMNS.map((c) => c.label),
      data: rows.map((r) => COLUMNS.map((c) => r[c.key])),
    },
    { escapeFormulae: CSV_FORMULA },
  );
}

/** Linhas de um lote em CSV (sem cabeçalho), com o mesmo `escapeFormulae`. */
function loteEmCsv(rows: ExportRow[]): string {
  return Papa.unparse(
    rows.map((r) => COLUMNS.map((c) => r[c.key])),
    { escapeFormulae: CSV_FORMULA },
  );
}

/**
 * CSV em streaming: o cabeçalho sai na hora e cada lote de 1.000 contatos é
 * lido só quando quem baixa pede mais (`pull` — contrapressão natural). O
 * texto final é idêntico ao de `rowsToCsv` com todas as linhas.
 *
 * Chame DENTRO do `runWithTeam` da requisição (o papel e o time são
 * resolvidos na chamada — ver `lotesDeContatosParaExportar`).
 */
export function exportarContatosCsv(filters: ExportFilters = {}, opts: { lote?: number } = {}): ReadableStream<Uint8Array> {
  const lotes = lotesDeContatosParaExportar(filters, opts)[Symbol.asyncIterator]();
  const enc = new TextEncoder();
  let primeiroLote = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // `unparse` com `data: []` devolve o cabeçalho já com a quebra de linha.
      controller.enqueue(enc.encode(Papa.unparse({ fields: COLUMNS.map((c) => c.label), data: [] }, { escapeFormulae: CSV_FORMULA })));
    },
    async pull(controller) {
      try {
        const { value, done } = await lotes.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode((primeiroLote ? "" : "\r\n") + loteEmCsv(value)));
        primeiroLote = false;
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "[export] falha no meio da exportação CSV");
        controller.error(err);
      }
    },
    async cancel() {
      await lotes.return?.();
    },
  });
}

/** Retorna os labels das colunas (para header do Excel). */
export function getColumnLabels(): string[] {
  return COLUMNS.map((c) => c.label);
}

export { COLUMNS as EXPORT_COLUMNS };
