import { randomUUID } from "node:crypto";
import { db, getCurrentTeamId } from "@crmagro/db";
import { can, requireCan } from "../auth/authz";
import { escopoDoContato } from "../contacts/escopo";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { enfileirarBlocosAgro, type BlocoAgro, type FaseDoLoteAgro } from "./fila";
import { verificarContatoAgro } from "./service";

/**
 * Verificação do agro da base toda em segundo plano (fila `agro`, ver `fila.ts`).
 *
 * O andamento mora no Redis, num hash por time (`crmagro:agro:lote:<time>`), sem tabela nova: um lote por time por vez.
 * Cada bloco conta UMA vez (conjunto de blocos feitos por fase), então o job que roda de novo (tentativa, processo
 * que caiu) não soma duas vezes. O lote termina quando as duas rodadas chegam ao total, ou quando a pessoa cancela.
 * Quem não pode alterar um contato (escopo por dono) nunca o põe no lote: os ids passam por `escopoDoContato`.
 */

export class AgroLoteEmAndamento extends Error {
  constructor() {
    super("AgroLoteEmAndamento: já tem uma verificação do agro em andamento. Espere terminar ou cancele.");
    this.name = "AgroLoteEmAndamento";
  }
}

export class AgroLoteVazio extends Error {
  constructor() {
    super("AgroLoteVazio: não há contatos que você possa alterar nesta seleção.");
    this.name = "AgroLoteVazio";
  }
}

export class AgroLoteGrandeDemais extends Error {
  constructor(max: number) {
    super(`AgroLoteGrandeDemais: a verificação em segundo plano vai até ${max.toLocaleString("pt-BR")} contatos por vez. Refine o filtro.`);
    this.name = "AgroLoteGrandeDemais";
  }
}

/** Contatos por bloco (um job da fila). */
export const AGRO_BLOCO = 200;
/** Teto de um lote. */
export const AGRO_LOTE_MAX_CONTATOS = 50_000;
/** Respiro entre uma consulta de foto e outra à Evolution (ela não gosta de rajada), sorteado em [mín, máx]. */
const RESPIRO_DA_FOTO_MS: [number, number] = [400, 900];
/** O lote some do Redis se ficar parado este tempo (worker fora). Cada bloco que termina renova. */
const VALIDADE_S = 12 * 3600;
/** Depois de concluído ou cancelado o resultado fica visível por este tempo. */
const RESULTADO_S = 15 * 60;

const chave = (teamId: string) => `crmagro:agro:lote:${teamId}`;
const chaveDosBlocos = (teamId: string, fase: FaseDoLoteAgro) => `${chave(teamId)}:blocos:${fase}`;
const chaveDoInicio = (teamId: string) => `${chave(teamId)}:inicio`;

export type AndamentoAgro = {
  loteId: string;
  estado: "andando" | "concluido" | "cancelado";
  total: number;
  /** Contatos já passados pela rodada do cadastro (nome e empresas). */
  cadastro: number;
  /** Contatos já passados pela rodada das fotos. */
  fotos: number;
  falhas: number;
  /** Ajustados à mão, que a verificação automática respeita. */
  manuais: number;
  /** Fotos que esperam a leitura do Claude (MCP) ao fim. */
  naFila: number;
  iniciadoEm: string;
};

function lerAndamento(h: Record<string, string>): AndamentoAgro | null {
  if (!h.id) return null;
  const n = (k: string) => Number(h[k] ?? 0) || 0;
  const estado = h.estado === "concluido" || h.estado === "cancelado" ? h.estado : "andando";
  return { loteId: h.id, estado, total: n("total"), cadastro: n("cadastro"), fotos: n("fotos"), falhas: n("falhas"), manuais: n("manuais"), naFila: n("naFila"), iniciadoEm: h.iniciadoEm ?? "" };
}

async function andamentoDoTime(teamId: string): Promise<AndamentoAgro | null> {
  return lerAndamento(await redisEstado().hgetall(chave(teamId)));
}

function timeAtual(): string {
  const teamId = getCurrentTeamId();
  if (!teamId) throw new Error("AgroLote: sem time no contexto.");
  return teamId;
}

/** O andamento do lote do time (null = nenhum). Quem não pode alterar contato não vê. Redis fora = null. */
export async function andamentoDaVerificacaoAgro(): Promise<AndamentoAgro | null> {
  if (!can("contacts.write")) return null;
  const teamId = getCurrentTeamId();
  if (!teamId) return null;
  try {
    return await andamentoDoTime(teamId);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[agro] não consegui ler o andamento");
    return null;
  }
}

/**
 * Começa a verificação de uma lista de contatos em segundo plano. Só entram os que a pessoa pode alterar.
 * Um lote por time por vez (`AgroLoteEmAndamento`). Devolve quantos entraram.
 */
export async function iniciarVerificacaoAgro(ids: readonly string[]): Promise<{ total: number }> {
  requireCan("contacts.write");
  const teamId = timeAtual();
  const prisma = db(); // antes de qualquer await (AGENTS.md §12)

  const unicos = [...new Set(ids)];
  if (unicos.length > AGRO_LOTE_MAX_CONTATOS) throw new AgroLoteGrandeDemais(AGRO_LOTE_MAX_CONTATOS);
  const podem = new Set<string>();
  for (let i = 0; i < unicos.length; i += 1000) {
    const linhas = await prisma.contact.findMany({
      where: { AND: [{ id: { in: unicos.slice(i, i + 1000) } }, escopoDoContato({ escrita: true })] },
      select: { id: true },
    });
    for (const l of linhas) podem.add(l.id);
  }
  // Na ordem em que a pessoa mandou (a da lista na tela).
  const alteraveis = unicos.filter((id) => podem.has(id));
  if (!alteraveis.length) throw new AgroLoteVazio();

  const r = redisEstado();
  // Duas pessoas clicando juntas: só uma passa pelo portão.
  if ((await r.set(chaveDoInicio(teamId), "1", "EX", 30, "NX")) !== "OK") throw new AgroLoteEmAndamento();
  try {
    const atual = await andamentoDoTime(teamId);
    if (atual?.estado === "andando") throw new AgroLoteEmAndamento();

    const loteId = randomUUID();
    await r.del(chave(teamId), chaveDosBlocos(teamId, "cadastro"), chaveDosBlocos(teamId, "foto"));
    await r.hset(chave(teamId), { id: loteId, estado: "andando", total: alteraveis.length, cadastro: 0, fotos: 0, falhas: 0, manuais: 0, naFila: 0, iniciadoEm: new Date().toISOString() });
    await r.expire(chave(teamId), VALIDADE_S);

    const blocos: BlocoAgro[] = [];
    for (const fase of ["cadastro", "foto"] as const) {
      for (let i = 0, indice = 0; i < alteraveis.length; i += AGRO_BLOCO, indice++) {
        blocos.push({ teamId, loteId, fase, indice, ids: alteraveis.slice(i, i + AGRO_BLOCO) });
      }
    }
    try {
      await enfileirarBlocosAgro(blocos);
    } catch (e) {
      await r.del(chave(teamId)); // sem fila não há lote: não deixa um "andando" que nunca anda
      throw e;
    }
    logger.info({ teamId, total: alteraveis.length, blocos: blocos.length }, "[agro] verificação em segundo plano começou");
    return { total: alteraveis.length };
  } finally {
    await r.del(chaveDoInicio(teamId));
  }
}

/** Cancela o lote em andamento: os blocos que faltam são pulados (o que já foi verificado fica). */
export async function cancelarVerificacaoAgro(): Promise<void> {
  requireCan("contacts.write");
  const teamId = timeAtual();
  const r = redisEstado();
  const atual = await andamentoDoTime(teamId);
  if (atual?.estado !== "andando") return;
  await r.hset(chave(teamId), "estado", "cancelado");
  await r.expire(chave(teamId), RESULTADO_S);
  logger.info({ teamId }, "[agro] verificação em segundo plano cancelada");
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

type Contagem = { feitos: number; falhas: number; manuais: number; naFila: number };

/** Soma o resultado de um bloco ao lote, uma vez só por bloco. Fecha o lote quando as duas rodadas terminam. */
async function somarBloco(bloco: BlocoAgro, c: Contagem): Promise<void> {
  const r = redisEstado();
  const k = chave(bloco.teamId);
  const atual = await andamentoDoTime(bloco.teamId);
  if (!atual || atual.loteId !== bloco.loteId) return;
  // O mesmo bloco, rodado de novo, não conta de novo.
  if ((await r.sadd(chaveDosBlocos(bloco.teamId, bloco.fase), String(bloco.indice))) === 0) return;
  await r
    .multi()
    .hincrby(k, bloco.fase === "cadastro" ? "cadastro" : "fotos", c.feitos)
    .hincrby(k, "falhas", c.falhas)
    .hincrby(k, "manuais", c.manuais)
    .hincrby(k, "naFila", c.naFila)
    .expire(k, VALIDADE_S)
    .expire(chaveDosBlocos(bloco.teamId, bloco.fase), VALIDADE_S)
    .exec();
  const depois = await andamentoDoTime(bloco.teamId);
  if (depois && depois.estado === "andando" && depois.cadastro >= depois.total && depois.fotos >= depois.total) {
    await r.hset(k, "estado", "concluido");
    await r.expire(k, RESULTADO_S);
    logger.info({ teamId: bloco.teamId, total: depois.total, falhas: depois.falhas }, "[agro] verificação em segundo plano concluída");
  }
}

const dormir = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const respiro = () => RESPIRO_DA_FOTO_MS[0] + Math.round(Math.random() * (RESPIRO_DA_FOTO_MS[1] - RESPIRO_DA_FOTO_MS[0]));

/**
 * Processa um bloco. Roda dentro de `runAsSystem(teamId, ...)` (o worker abre o contexto). Bloco de lote velho ou
 * cancelado é pulado. Um contato que falha (apagado no meio, por exemplo) entra na conta de falhas e o bloco segue.
 */
export async function processarBlocoAgro(bloco: BlocoAgro, opts: { dormir?: (ms: number) => Promise<void> } = {}): Promise<"feito" | "obsoleto" | "parado"> {
  const espera = opts.dormir ?? dormir;
  const inicio = await andamentoDoTime(bloco.teamId);
  if (!inicio || inicio.loteId !== bloco.loteId) return "obsoleto";
  if (inicio.estado !== "andando") return "parado";

  const c: Contagem = { feitos: 0, falhas: 0, manuais: 0, naFila: 0 };
  for (const [i, id] of bloco.ids.entries()) {
    // Cancelar vale no meio do bloco também (confere a cada 25 contatos).
    if (i > 0 && i % 25 === 0 && (await andamentoDoTime(bloco.teamId))?.estado !== "andando") break;
    try {
      const r = await verificarContatoAgro(id, bloco.fase === "cadastro" ? { semFoto: true } : { apenasFotoNova: true });
      if (r.ajusteManualMantido) c.manuais++;
      if (r.foto === "na_fila" && r.consultouWhatsapp) c.naFila++;
      if (r.consultouWhatsapp) await espera(respiro());
    } catch (e) {
      c.falhas++;
      logger.warn({ teamId: bloco.teamId, contactId: id, err: e instanceof Error ? e.message : String(e) }, "[agro] contato não verificado no lote");
    }
    c.feitos++;
  }
  await somarBloco(bloco, c);
  return "feito";
}

/** Bloco que esgotou as tentativas: conta todos os contatos dele como falha, para o lote poder terminar. */
export async function fecharBlocoAgroComFalha(bloco: BlocoAgro): Promise<void> {
  const inicio = await andamentoDoTime(bloco.teamId);
  if (!inicio || inicio.loteId !== bloco.loteId || inicio.estado !== "andando") return;
  await somarBloco(bloco, { feitos: bloco.ids.length, falhas: bloco.ids.length, manuais: 0, naFila: 0 });
}
