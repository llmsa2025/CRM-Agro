import type { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, getCurrentUserId, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import {
  ehFinalidade,
  FINALIDADES,
  LIMITES_DA_METODOLOGIA,
  MODELO_PADRAO,
  MODELOS_PRONTOS,
  type FinalidadeDaMetodologia,
} from "./modelos";

/**
 * Metodologias de abordagem (Integrações → IA → Metodologias). Cada uma tem uma FINALIDADE e há no máximo UMA
 * padrão por finalidade (índice único parcial no banco). O nó Agente IA usa a que escolher (ou a padrão da
 * empresa) e o Assistente usa a padrão da finalidade dele.
 *
 * Os modelos prontos (SPIN Selling, BANT, Consultiva) são criados uma vez por time, na primeira vez que alguém
 * precisa deles (a tela ou o agente), e dali em diante são do time: editáveis e excluíveis. `Team.metodologiasIniciadas`
 * evita que voltem depois de excluídos.
 *
 * A leitura do agente tem cache de 60 s por time, como a base de conhecimento: o agente tem que ser rápido.
 */

/** Erro com frase escrita para a pessoa (a tela mostra como está). */
export class MetodologiaInvalida extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "MetodologiaInvalida";
  }
}

export type MetodologiaDTO = {
  id: string;
  nome: string;
  finalidade: FinalidadeDaMetodologia;
  descricao: string | null;
  conteudo: string;
  padrao: boolean;
  modelo: string | null;
  updatedAt: string;
};

type Linha = {
  id: string;
  nome: string;
  finalidade: string;
  descricao: string | null;
  conteudo: string;
  padrao: boolean;
  modelo: string | null;
  updatedAt: Date;
};

const SELECT = { id: true, nome: true, finalidade: true, descricao: true, conteudo: true, padrao: true, modelo: true, updatedAt: true } as const;

const paraDto = (m: Linha): MetodologiaDTO => ({
  id: m.id,
  nome: m.nome,
  finalidade: m.finalidade as FinalidadeDaMetodologia,
  descricao: m.descricao,
  conteudo: m.conteudo,
  padrao: m.padrao,
  modelo: m.modelo,
  updatedAt: m.updatedAt.toISOString(),
});

// ─── Cache ──────────────────────────────────────────────────────────────────

const CACHE_MS = 60_000;
const cache = new Map<string, { em: number; lista: MetodologiaDTO[] }>();
const invalidar = () => {
  const t = getCurrentTeamId();
  if (t) cache.delete(t);
};

/** Esvazia o cache de todos os times. Só para teste (os testes mexem direto no banco). */
export function limparCacheDeMetodologias(): void {
  cache.clear();
}

// ─── Modelos iniciais ───────────────────────────────────────────────────────

/** Cria os modelos prontos do time uma única vez. Idempotente e seguro com chamadas ao mesmo tempo. */
export async function garantirModelosIniciais(): Promise<void> {
  const teamId = getCurrentTeamId();
  if (!teamId) return;
  const prisma = db();
  // Só UMA chamada leva a marca: as outras seguem sem semear.
  const { count } = await prisma.team.updateMany({ where: { id: teamId, metodologiasIniciadas: false }, data: { metodologiasIniciadas: true } });
  if (count === 0) return;
  try {
    // Time que já criou as próprias antes dos modelos existirem: não mexe no que é dele.
    if ((await prisma.methodology.count()) > 0) return;
    await prisma.methodology.createMany({
      data: MODELOS_PRONTOS.map((m) =>
        tenantData<Prisma.MethodologyUncheckedCreateInput>({
          nome: m.nome,
          finalidade: m.finalidade,
          descricao: m.descricao,
          conteudo: m.conteudo,
          modelo: m.slug,
          padrao: MODELO_PADRAO[m.finalidade] === m.slug,
        }),
      ),
    });
    invalidar();
    logger.info({ modelos: MODELOS_PRONTOS.length }, "[metodologias] modelos prontos criados para o time");
  } catch (e) {
    // Não deixa a marca sem os modelos: a próxima chamada tenta de novo.
    await prisma.team.updateMany({ where: { id: teamId }, data: { metodologiasIniciadas: false } }).catch(() => undefined);
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[metodologias] não deu para criar os modelos prontos");
  }
}

// ─── Leitura ────────────────────────────────────────────────────────────────

/** Todas as metodologias do time (a tela). Não semeia: quem semeia é a tela do administrador ou o agente. */
export async function listarMetodologias(finalidade?: FinalidadeDaMetodologia): Promise<MetodologiaDTO[]> {
  const rows = await db().methodology.findMany({
    where: finalidade ? { finalidade } : {},
    orderBy: [{ finalidade: "asc" }, { padrao: "desc" }, { createdAt: "asc" }],
    select: SELECT,
  });
  return rows.map(paraDto);
}

async function carregarComCache(): Promise<MetodologiaDTO[]> {
  const teamId = getCurrentTeamId();
  if (!teamId) return []; // sem time no contexto: nada (fail-closed)
  const c = cache.get(teamId);
  if (c && Date.now() - c.em < CACHE_MS) return c.lista;
  await garantirModelosIniciais();
  const lista = await listarMetodologias();
  cache.set(teamId, { em: Date.now(), lista });
  return lista;
}

export type MetodologiaParaIa = { id: string; nome: string; conteudo: string };

/** Valor de `metodologiaId` no nó para "sem metodologia". Ausente = a padrão da empresa. */
export const SEM_METODOLOGIA = "nenhuma";

/**
 * A metodologia que a IA deve seguir: a escolhida (`id`), a padrão da finalidade (`id` ausente ou que não existe
 * mais) ou nenhuma (`SEM_METODOLOGIA`, ou time sem padrão). Nunca lança: sem metodologia a IA segue como antes.
 */
export async function metodologiaParaIa(finalidade: FinalidadeDaMetodologia, id?: string | null): Promise<MetodologiaParaIa | null> {
  try {
    if (id === SEM_METODOLOGIA) return null;
    const lista = (await carregarComCache()).filter((m) => m.finalidade === finalidade);
    const escolhida = id ? lista.find((m) => m.id === id) : undefined;
    const m = escolhida ?? lista.find((x) => x.padrao);
    return m ? { id: m.id, nome: m.nome, conteudo: m.conteudo } : null;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[metodologias] não deu para ler, a IA segue sem metodologia");
    return null;
  }
}

// ─── Escrita ────────────────────────────────────────────────────────────────

function validar(input: { nome?: string; descricao?: string | null; conteudo?: string }, parcial: boolean) {
  const out: { nome?: string; descricao?: string | null; conteudo?: string } = {};
  if (!parcial || input.nome !== undefined) {
    const nome = (input.nome ?? "").replace(/\s+/g, " ").trim();
    if (!nome) throw new MetodologiaInvalida("Dê um nome à metodologia.");
    if (nome.length > LIMITES_DA_METODOLOGIA.nome) throw new MetodologiaInvalida(`O nome pode ter até ${LIMITES_DA_METODOLOGIA.nome} caracteres.`);
    out.nome = nome;
  }
  if (input.descricao !== undefined) {
    const d = (input.descricao ?? "").replace(/\s+/g, " ").trim();
    if (d.length > LIMITES_DA_METODOLOGIA.descricao) throw new MetodologiaInvalida(`A descrição pode ter até ${LIMITES_DA_METODOLOGIA.descricao} caracteres.`);
    out.descricao = d || null;
  }
  if (!parcial || input.conteudo !== undefined) {
    const c = (input.conteudo ?? "").replace(/\r\n?/g, "\n").trim();
    if (!c) throw new MetodologiaInvalida("Escreva como o agente deve conduzir a abordagem.");
    if (c.length > LIMITES_DA_METODOLOGIA.conteudo) {
      throw new MetodologiaInvalida(`O texto pode ter até ${LIMITES_DA_METODOLOGIA.conteudo} caracteres (tem ${c.length}). Encurte para o agente seguir melhor.`);
    }
    out.conteudo = c;
  }
  return out;
}

/** Nova metodologia. A finalidade é escolhida aqui e não muda depois. A primeira de uma finalidade já nasce como padrão. */
export async function criarMetodologia(input: { nome: string; finalidade: string; descricao?: string; conteudo: string; modelo?: string }): Promise<MetodologiaDTO> {
  requireCan("metodologias.write");
  if (!ehFinalidade(input.finalidade)) throw new MetodologiaInvalida(`Escolha para que serve: ${FINALIDADES.join(" ou ")}.`);
  const v = validar(input, false);
  const prisma = db();
  if ((await prisma.methodology.count()) >= LIMITES_DA_METODOLOGIA.porTime) {
    throw new MetodologiaInvalida(`O limite é de ${LIMITES_DA_METODOLOGIA.porTime} metodologias. Exclua alguma para criar outra.`);
  }
  const jaTemPadrao = (await prisma.methodology.count({ where: { finalidade: input.finalidade, padrao: true } })) > 0;
  const row = await prisma.methodology.create({
    data: tenantData<Prisma.MethodologyUncheckedCreateInput>({
      nome: v.nome!,
      finalidade: input.finalidade,
      descricao: v.descricao ?? null,
      conteudo: v.conteudo!,
      modelo: MODELOS_PRONTOS.some((m) => m.slug === input.modelo) ? input.modelo! : null,
      padrao: !jaTemPadrao,
      criadoPorId: getCurrentUserId(),
    }),
    select: SELECT,
  });
  invalidar();
  return paraDto(row);
}

export async function atualizarMetodologia(id: string, input: { nome?: string; descricao?: string | null; conteudo?: string }): Promise<MetodologiaDTO> {
  requireCan("metodologias.write");
  const prisma = db();
  if (!(await prisma.methodology.findFirst({ where: { id }, select: { id: true } }))) throw new MetodologiaInvalida("Não achei esta metodologia.");
  const row = await prisma.methodology.update({ where: { id }, data: validar(input, true), select: SELECT });
  invalidar();
  return paraDto(row);
}

/** Torna esta a padrão da finalidade dela (a que estava deixa de ser, na mesma transação). */
export async function definirPadrao(id: string): Promise<MetodologiaDTO> {
  requireCan("metodologias.write");
  const prisma = db();
  const alvo = await prisma.methodology.findFirst({ where: { id }, select: { id: true, finalidade: true, padrao: true } });
  if (!alvo) throw new MetodologiaInvalida("Não achei esta metodologia.");
  if (!alvo.padrao) {
    await prisma.$transaction([
      prisma.methodology.updateMany({ where: { finalidade: alvo.finalidade, padrao: true }, data: { padrao: false } }),
      prisma.methodology.update({ where: { id }, data: { padrao: true } }),
    ]);
  }
  invalidar();
  const row = await prisma.methodology.findFirst({ where: { id }, select: SELECT });
  return paraDto(row!);
}

/**
 * Exclui. Se era a padrão, a finalidade fica sem padrão (os nós que a usavam passam a rodar sem metodologia até
 * alguém escolher outra). O aviso da tela diz isso.
 */
export async function excluirMetodologia(id: string): Promise<void> {
  requireCan("metodologias.write");
  // `db()` já limita ao time: id de outro time apaga zero linhas.
  const { count } = await db().methodology.deleteMany({ where: { id } });
  if (count === 0) throw new MetodologiaInvalida("Não achei esta metodologia.");
  invalidar();
}
