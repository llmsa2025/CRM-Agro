import type { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, getCurrentUserId, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { ArquivoNaoLido, CARACTERES_MAX_DOC, conferirTextoExtraido, lerArquivo, type FonteDoArquivo } from "./leitor";
import { lerDocumentoDoGoogle, lerLinkDoGoogle } from "./google";
import { escolherTrechos, ORCAMENTO_PADRAO, type DocumentoParaBusca } from "./trechos";

/**
 * Base de conhecimento da empresa (Integrações → IA). O que a IA do Agente e do Assistente consulta para saber
 * como é a empresa, os produtos e as condições, e não inventar.
 *
 * Todo documento é tenant-scoped (`db()`), a escrita pede `conhecimento.write` (administrador) e a leitura
 * para a IA roda no contexto do time (motor e assistente já estão dentro de `runWithTeam`/`runAsSystem`).
 */

export const MAX_DOCUMENTOS = 60;
export const CARACTERES_MAX_BASE = 1_500_000;
const TITULO_MAX = 120;

/** Erro com frase escrita para a pessoa (a tela mostra como está). */
export class ConhecimentoInvalido extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ConhecimentoInvalido";
  }
}

export type FonteDoDocumento = FonteDoArquivo | "google";

export type DocumentoDaBase = {
  id: string;
  titulo: string;
  fonte: FonteDoDocumento;
  nomeArquivo: string | null;
  linkOrigem: string | null;
  caracteres: number;
  ativo: boolean;
  createdAt: string;
  updatedAt: string;
};

type Linha = {
  id: string;
  titulo: string;
  fonte: string;
  nomeArquivo: string | null;
  linkOrigem: string | null;
  caracteres: number;
  ativo: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT_DTO = { id: true, titulo: true, fonte: true, nomeArquivo: true, linkOrigem: true, caracteres: true, ativo: true, createdAt: true, updatedAt: true } as const;

function paraDto(d: Linha): DocumentoDaBase {
  return {
    id: d.id,
    titulo: d.titulo,
    fonte: d.fonte as FonteDoDocumento,
    nomeArquivo: d.nomeArquivo,
    linkOrigem: d.linkOrigem,
    caracteres: d.caracteres,
    ativo: d.ativo,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function tituloValido(t: string | undefined | null, padrao: string): string {
  const limpo = (t ?? "").replace(/\s+/g, " ").trim() || padrao;
  return limpo.slice(0, TITULO_MAX);
}

// ─── Cache da leitura para a IA ─────────────────────────────────────────────

const CACHE_MS = 60_000;
const cache = new Map<string, { em: number; docs: DocumentoParaBusca[] }>();
const invalidar = (teamId: string | null) => {
  if (teamId) cache.delete(teamId);
};

// ─── Leitura ────────────────────────────────────────────────────────────────

export async function listarDocumentos(): Promise<DocumentoDaBase[]> {
  const rows = await db().knowledgeDoc.findMany({ orderBy: { createdAt: "desc" }, select: SELECT_DTO });
  return rows.map(paraDto);
}

/** Texto completo de um documento (para a tela mostrar e editar o que é "texto"). */
export async function lerDocumento(id: string): Promise<DocumentoDaBase & { conteudo: string }> {
  const d = await db().knowledgeDoc.findFirst({ where: { id }, select: { ...SELECT_DTO, conteudo: true } });
  if (!d) throw new ConhecimentoInvalido("Não achei este documento.");
  return { ...paraDto(d), conteudo: d.conteudo };
}

export type ResumoDaBase = { documentos: number; ativos: number; caracteres: number; limiteDocumentos: number; limiteCaracteres: number };

export async function resumoDaBase(): Promise<ResumoDaBase> {
  const prisma = db();
  const [documentos, ativos, soma] = await Promise.all([
    prisma.knowledgeDoc.count(),
    prisma.knowledgeDoc.count({ where: { ativo: true } }),
    prisma.knowledgeDoc.aggregate({ _sum: { caracteres: true } }),
  ]);
  return { documentos, ativos, caracteres: soma._sum.caracteres ?? 0, limiteDocumentos: MAX_DOCUMENTOS, limiteCaracteres: CARACTERES_MAX_BASE };
}

// ─── Escrita ────────────────────────────────────────────────────────────────

/** Confere se ainda cabe: número de documentos e total de texto da base. */
async function exigirEspaco(caracteresNovos: number, caracteresRemovidos = 0): Promise<void> {
  const r = await resumoDaBase();
  if (caracteresRemovidos === 0 && r.documentos >= MAX_DOCUMENTOS) {
    throw new ConhecimentoInvalido(`A base já tem ${MAX_DOCUMENTOS} documentos. Exclua algum para adicionar outro.`);
  }
  if (r.caracteres - caracteresRemovidos + caracteresNovos > CARACTERES_MAX_BASE) {
    throw new ConhecimentoInvalido("A base chegou ao limite de texto. Exclua ou encurte algum documento para adicionar mais.");
  }
}

async function criar(input: {
  titulo: string;
  fonte: FonteDoDocumento;
  conteudo: string;
  nomeArquivo?: string | null;
  linkOrigem?: string | null;
}): Promise<DocumentoDaBase> {
  await exigirEspaco(input.conteudo.length);
  const row = await db().knowledgeDoc.create({
    data: tenantData<Prisma.KnowledgeDocUncheckedCreateInput>({
      titulo: input.titulo,
      fonte: input.fonte,
      conteudo: input.conteudo,
      caracteres: input.conteudo.length,
      nomeArquivo: input.nomeArquivo ?? null,
      linkOrigem: input.linkOrigem ?? null,
      criadoPorId: getCurrentUserId(),
    }),
    select: SELECT_DTO,
  });
  invalidar(getCurrentTeamId());
  logger.info({ docId: row.id, fonte: input.fonte, caracteres: row.caracteres }, "[conhecimento] documento adicionado");
  return paraDto(row);
}

/** Texto escrito ou colado na tela. */
export async function adicionarTexto(input: { titulo: string; conteudo: string }): Promise<DocumentoDaBase> {
  requireCan("conhecimento.write");
  const titulo = (input.titulo ?? "").trim();
  if (!titulo) throw new ConhecimentoInvalido("Dê um título ao texto.");
  const conteudo = conferirTextoExtraido(input.conteudo ?? "", "texto");
  return criar({ titulo: tituloValido(titulo, "Texto"), fonte: "texto", conteudo });
}

/** Arquivo enviado (PDF, Word, Excel ou texto). O arquivo não é guardado: só o texto extraído. */
export async function adicionarArquivo(input: { nome: string; bytes: Uint8Array; titulo?: string }): Promise<DocumentoDaBase> {
  requireCan("conhecimento.write");
  const { fonte, texto } = await lerArquivo(input.nome, input.bytes);
  const semExtensao = input.nome.replace(/\.[^.]+$/, "");
  return criar({ titulo: tituloValido(input.titulo, semExtensao || "Arquivo"), fonte, conteudo: texto, nomeArquivo: input.nome.slice(0, 200) });
}

/** Documento do Google pelo link de compartilhamento (Docs, Planilhas, Apresentações ou arquivo do Drive). */
export async function adicionarLinkDoGoogle(input: { url: string; titulo?: string }): Promise<DocumentoDaBase> {
  requireCan("conhecimento.write");
  const link = lerLinkDoGoogle(input.url ?? "");
  if (!link) throw new ConhecimentoInvalido("Esse não parece um link do Google Docs, Planilhas, Apresentações ou Drive. Copie o link de compartilhamento.");
  const lido = await lerDocumentoDoGoogle(link);
  return criar({
    titulo: tituloValido(input.titulo, "Documento do Google"),
    fonte: "google",
    conteudo: lido.texto,
    nomeArquivo: lido.nomeArquivo,
    linkOrigem: input.url.trim().slice(0, 500),
  });
}

/** Lê o link do Google de novo (o documento mudou). */
export async function atualizarDoGoogle(id: string): Promise<DocumentoDaBase> {
  requireCan("conhecimento.write");
  const prisma = db();
  const atual = await prisma.knowledgeDoc.findFirst({ where: { id }, select: { fonte: true, linkOrigem: true, caracteres: true } });
  if (!atual) throw new ConhecimentoInvalido("Não achei este documento.");
  if (atual.fonte !== "google" || !atual.linkOrigem) throw new ConhecimentoInvalido("Este documento não veio de um link do Google.");
  const link = lerLinkDoGoogle(atual.linkOrigem);
  if (!link) throw new ConhecimentoInvalido("O link deste documento não vale mais. Exclua e adicione de novo.");
  const lido = await lerDocumentoDoGoogle(link);
  await exigirEspaco(lido.texto.length, atual.caracteres);
  const row = await prisma.knowledgeDoc.update({
    where: { id },
    data: { conteudo: lido.texto, caracteres: lido.texto.length },
    select: SELECT_DTO,
  });
  invalidar(getCurrentTeamId());
  return paraDto(row);
}

/** Muda título, liga/desliga ou (só para "texto") troca o conteúdo. */
export async function atualizarDocumento(id: string, input: { titulo?: string; ativo?: boolean; conteudo?: string }): Promise<DocumentoDaBase> {
  requireCan("conhecimento.write");
  const prisma = db();
  const atual = await prisma.knowledgeDoc.findFirst({ where: { id }, select: { fonte: true, caracteres: true } });
  if (!atual) throw new ConhecimentoInvalido("Não achei este documento.");
  const data: Prisma.KnowledgeDocUpdateInput = {};
  if (input.titulo !== undefined) {
    if (!input.titulo.trim()) throw new ConhecimentoInvalido("O título não pode ficar vazio.");
    data.titulo = tituloValido(input.titulo, "Documento");
  }
  if (input.ativo !== undefined) data.ativo = input.ativo;
  if (input.conteudo !== undefined) {
    if (atual.fonte !== "texto") throw new ConhecimentoInvalido("Só dá para editar o conteúdo de um texto. Para arquivo ou link, envie de novo.");
    const conteudo = conferirTextoExtraido(input.conteudo, "texto");
    await exigirEspaco(conteudo.length, atual.caracteres);
    data.conteudo = conteudo;
    data.caracteres = conteudo.length;
  }
  const row = await prisma.knowledgeDoc.update({ where: { id }, data, select: SELECT_DTO });
  invalidar(getCurrentTeamId());
  return paraDto(row);
}

export async function excluirDocumento(id: string): Promise<void> {
  requireCan("conhecimento.write");
  // `db()` já limita ao time: id de outro time apaga zero linhas.
  const { count } = await db().knowledgeDoc.deleteMany({ where: { id } });
  if (count === 0) throw new ConhecimentoInvalido("Não achei este documento.");
  invalidar(getCurrentTeamId());
}

// ─── Consulta pela IA ───────────────────────────────────────────────────────

async function documentosAtivos(): Promise<DocumentoParaBusca[]> {
  const teamId = getCurrentTeamId();
  if (!teamId) return []; // sem time no contexto: nada (fail-closed)
  const c = cache.get(teamId);
  if (c && Date.now() - c.em < CACHE_MS) return c.docs;
  const rows = await db().knowledgeDoc.findMany({ where: { ativo: true }, orderBy: { createdAt: "asc" }, select: { id: true, titulo: true, conteudo: true } });
  cache.set(teamId, { em: Date.now(), docs: rows });
  return rows;
}

export type ConsultaDaBase = { texto: string; documentos: string[]; completa: boolean };

/**
 * Os trechos da base que servem à `consulta`, prontos para o prompt. Vazio se a empresa não cadastrou nada.
 * Nunca lança: a base é um reforço, e a IA segue sem ela se a leitura falhar.
 */
export async function consultarBase(consulta: string, orcamento = ORCAMENTO_PADRAO): Promise<ConsultaDaBase> {
  try {
    const docs = await documentosAtivos();
    if (docs.length === 0) return { texto: "", documentos: [], completa: true };
    const r = escolherTrechos(docs, consulta, orcamento);
    return { texto: r.texto, documentos: r.usados.map((u) => u.titulo), completa: r.completa };
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[conhecimento] não deu para ler a base, a IA segue sem ela");
    return { texto: "", documentos: [], completa: true };
  }
}

export { ArquivoNaoLido, CARACTERES_MAX_DOC };
