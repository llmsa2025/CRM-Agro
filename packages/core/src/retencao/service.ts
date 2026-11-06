import { basePrisma } from "@crmagro/db";
import { logger } from "../logger/index";
import { limparCadastrosPendentesVencidos } from "../auth/cadastro-com-senha";

/**
 * Retenção (limpeza periódica, worker primário). Começou pelo que o produto
 * pediu no item H.1: a fila da Captação deixou de ser apagada ao abrir a tela —
 * agora persiste —, então rascunho PENDENTE esquecido precisa de prazo. O job
 * geral (item 2.7, DP-15; decisão do dono: 90 dias de detalhe) entra aqui:
 *  - `FlowStepExecution` de inscrição encerrada (`done`/`failed`) há mais de
 *    90 dias — a inscrição fica como resumo;
 *  - `ProspectDraft` já tratado (importado/descartado) com mais de 30 dias;
 *  - `EnrichmentFact` nunca aplicado com mais de 180 dias;
 *  - `DailyTaskState` (tarefa do dia marcada como feita, produto §F) com mais
 *    de 30 dias — a marca só vale no dia dela.
 * E, a cada 6 h com a fila da Captação, o `CadastroPendente` (criar empresa
 * com e-mail e senha) que não foi confirmado: mais de 24 h e o link vencido.
 *
 * Cross-team por natureza (manutenção do sistema, sem contexto de time), por
 * isso `basePrisma`. Apaga em lotes de 5.000 ids (cursor por `id`) para não
 * segurar a tabela, e o `deleteMany` repete o filtro: o que mudou entre a busca
 * e a remoção (ex.: inscrição falhada que voltou ao fluxo) não é apagado.
 * `teamId` opcional restringe a um time (testes na base compartilhada, ou uma
 * limpeza pontual da operação).
 */

export const RASCUNHO_PENDENTE_DIAS = 30;
export const RASCUNHO_TRATADO_DIAS = 30;
export const PASSOS_ENCERRADOS_DIAS = 90;
export const FATO_NAO_APLICADO_DIAS = 180;
export const TAREFA_FEITA_DIAS = 30;
/** O job geral roda 1× por dia, embora o worker chame a retenção a cada 6 h. */
export const RETENCAO_GERAL_INTERVALO_MS = 24 * 60 * 60_000;
const LOTE = 5000;
const DIA_MS = 86_400_000;

type OpcoesRetencao = {
  agora?: Date;
  dias?: number;
  teamId?: string;
  /** Tamanho do lote (padrão 5.000; o teste usa lote pequeno para cobrir o cursor). */
  lote?: number;
};

function limiteDe(opts: OpcoesRetencao, padraoDias: number): Date {
  return new Date((opts.agora ?? new Date()).getTime() - (opts.dias ?? padraoDias) * DIA_MS);
}

/**
 * Laço de lotes por `id` (ordem crescente, cursor no último visto): busca até
 * 5.000 candidatos, escolhe os que podem sair e apaga. O cursor garante que
 * uma linha preservada (não apagada) não trave o laço.
 */
async function apagarEmLotes<T extends { id: string }>(
  tamanho: number,
  buscar: (depoisDe: string | undefined) => Promise<T[]>,
  apagar: (ids: string[]) => Promise<number>,
  podeApagar: (linha: T) => boolean = () => true,
): Promise<number> {
  let apagados = 0;
  let cursor: string | undefined;
  for (;;) {
    const lote = await buscar(cursor);
    if (lote.length === 0) break;
    cursor = lote[lote.length - 1]!.id;
    const ids = lote.filter(podeApagar).map((l) => l.id);
    if (ids.length) apagados += await apagar(ids);
    if (lote.length < tamanho) break;
  }
  return apagados;
}

const aposCursor = (cursor: string | undefined) => (cursor ? { id: { gt: cursor } } : {});

/** Apaga rascunhos de captação PENDENTES criados há mais de `dias` (item H.1). */
export async function limparRascunhosPendentesAntigos(opts: OpcoesRetencao = {}): Promise<{ apagados: number }> {
  const where = {
    status: "pendente",
    createdAt: { lt: limiteDe(opts, RASCUNHO_PENDENTE_DIAS) },
    ...(opts.teamId ? { teamId: opts.teamId } : {}),
  };
  const tam = opts.lote ?? LOTE;
  const apagados = await apagarEmLotes(
    tam,
    (c) => basePrisma.prospectDraft.findMany({ where: { ...where, ...aposCursor(c) }, select: { id: true }, orderBy: { id: "asc" }, take: tam }),
    async (ids) => (await basePrisma.prospectDraft.deleteMany({ where: { ...where, id: { in: ids } } })).count,
  );
  if (apagados) logger.info({ apagados, dias: opts.dias ?? RASCUNHO_PENDENTE_DIAS }, "[retencao] rascunhos pendentes antigos apagados");
  return { apagados };
}

/**
 * Rascunho JÁ TRATADO (importado ou descartado) com mais de `dias`: o contato
 * (se importado) já existe; a linha de staging não serve mais para nada.
 */
export async function limparRascunhosTratados(opts: OpcoesRetencao = {}): Promise<{ apagados: number }> {
  const where = {
    status: { not: "pendente" },
    createdAt: { lt: limiteDe(opts, RASCUNHO_TRATADO_DIAS) },
    ...(opts.teamId ? { teamId: opts.teamId } : {}),
  };
  const tam = opts.lote ?? LOTE;
  const apagados = await apagarEmLotes(
    tam,
    (c) => basePrisma.prospectDraft.findMany({ where: { ...where, ...aposCursor(c) }, select: { id: true }, orderBy: { id: "asc" }, take: tam }),
    async (ids) => (await basePrisma.prospectDraft.deleteMany({ where: { ...where, id: { in: ids } } })).count,
  );
  if (apagados) logger.info({ apagados }, "[retencao] rascunhos já tratados apagados");
  return { apagados };
}

/**
 * Passos (`FlowStepExecution`) de inscrições ENCERRADAS há mais de `dias`:
 * `done`, ou `failed` sem ninguém mexer (o `updatedAt` da inscrição é a última
 * vez que ela andou). A inscrição fica — é o resumo; some o detalhe passo a
 * passo.
 *
 * Nunca toca inscrição `active`/`waiting` (inclui a segurada para revisão, que
 * é `waiting` sem `nextRunAt`). Da `failed` — que também aparece na revisão e
 * pode voltar ao fluxo por "definir destino" — preserva TODOS os passos do nó
 * corrente: é de lá que a revisão tira o erro, e o round do próximo passo
 * nesse nó é contado pelo histórico dele (apagar parte das rodadas faria o
 * round novo colidir com uma rodada que ficou). Dos outros nós sai o histórico
 * inteiro, então a contagem recomeça do zero sem colisão.
 */
export async function limparPassosDeInscricoesEncerradas(opts: OpcoesRetencao = {}): Promise<{ apagados: number }> {
  const encerrada = {
    status: { in: ["done" as const, "failed" as const] },
    updatedAt: { lt: limiteDe(opts, PASSOS_ENCERRADOS_DIAS) },
    ...(opts.teamId ? { teamId: opts.teamId } : {}),
  };
  const tam = opts.lote ?? LOTE;
  const apagados = await apagarEmLotes(
    tam,
    (c) =>
      basePrisma.flowStepExecution.findMany({
        where: { enrollment: encerrada, ...aposCursor(c) },
        select: { id: true, nodeId: true, enrollment: { select: { status: true, currentNodeId: true } } },
        orderBy: { id: "asc" },
        take: tam,
      }),
    async (ids) =>
      (await basePrisma.flowStepExecution.deleteMany({ where: { id: { in: ids }, enrollment: encerrada } })).count,
    (p) => !(p.enrollment.status === "failed" && p.nodeId === p.enrollment.currentNodeId),
  );
  if (apagados) logger.info({ apagados, dias: opts.dias ?? PASSOS_ENCERRADOS_DIAS }, "[retencao] passos de inscrições encerradas apagados");
  return { apagados };
}

/**
 * Fato de enriquecimento que NUNCA foi promovido à coluna (`appliedAt` nulo) e
 * tem mais de `dias`: é só histórico de proveniência vencido. Fato de fonte
 * humana fica sempre (é a trava "never-override-human" do reconcile).
 */
export async function limparFatosNaoAplicados(opts: OpcoesRetencao = {}): Promise<{ apagados: number }> {
  const where = {
    appliedAt: null,
    source: { not: "human" },
    producedAt: { lt: limiteDe(opts, FATO_NAO_APLICADO_DIAS) },
    ...(opts.teamId ? { teamId: opts.teamId } : {}),
  };
  const tam = opts.lote ?? LOTE;
  const apagados = await apagarEmLotes(
    tam,
    (c) => basePrisma.enrichmentFact.findMany({ where: { ...where, ...aposCursor(c) }, select: { id: true }, orderBy: { id: "asc" }, take: tam }),
    async (ids) => (await basePrisma.enrichmentFact.deleteMany({ where: { ...where, id: { in: ids } } })).count,
  );
  if (apagados) logger.info({ apagados }, "[retencao] fatos de enriquecimento não aplicados apagados");
  return { apagados };
}

/**
 * Marca de "tarefa do dia feita" (produto §F) com mais de `dias`. A marca só
 * esconde a tarefa no dia da chave; guardar 30 dias é folga para consulta.
 */
export async function limparTarefasFeitasAntigas(opts: OpcoesRetencao = {}): Promise<{ apagados: number }> {
  const where = {
    feitoEm: { lt: limiteDe(opts, TAREFA_FEITA_DIAS) },
    ...(opts.teamId ? { teamId: opts.teamId } : {}),
  };
  const tam = opts.lote ?? LOTE;
  const apagados = await apagarEmLotes(
    tam,
    (c) => basePrisma.dailyTaskState.findMany({ where: { ...where, ...aposCursor(c) }, select: { id: true }, orderBy: { id: "asc" }, take: tam }),
    async (ids) => (await basePrisma.dailyTaskState.deleteMany({ where: { ...where, id: { in: ids } } })).count,
  );
  if (apagados) logger.info({ apagados }, "[retencao] marcas de tarefa do dia antigas apagadas");
  return { apagados };
}

export type ResumoRetencao = {
  rascunhosPendentes: number;
  /** Cadastros com senha nunca confirmados (sem time: não roda com `teamId`). */
  cadastrosPendentes: number;
  /** `null` = o job geral não rodou nesta chamada (rodou há menos de 24 h). */
  geral: { passos: number; rascunhosTratados: number; fatos: number; tarefasFeitas: number } | null;
};

// Última execução do job geral neste processo. Em memória de propósito: só o
// worker primário chama a retenção; depois de um restart roda de novo na
// primeira chamada, o que é inofensivo (as limpezas são idempotentes).
let ultimaGeralMs = 0;

/**
 * Ponto de entrada do worker (a cada 6 h): a fila pendente da Captação e os
 * cadastros com senha não confirmados sempre;
 * o job geral (passos, rascunhos tratados, fatos, tarefas feitas) no máximo 1×
 * a cada 24 h.
 * Cada parte isolada: uma falha não impede as outras.
 */
export async function executarRetencao(opts: { agora?: Date; teamId?: string } = {}): Promise<ResumoRetencao> {
  const agora = opts.agora ?? new Date();
  const base = { agora, teamId: opts.teamId };
  const seguro = async (nome: string, fn: () => Promise<{ apagados: number }>) => {
    try {
      return (await fn()).apagados;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), parte: nome }, "[retencao] falha numa limpeza");
      return 0;
    }
  };

  const rascunhosPendentes = await seguro("rascunhos-pendentes", () => limparRascunhosPendentesAntigos(base));
  // O pedido de cadastro ainda não tem time: com `teamId` (teste, limpeza de um
  // time) fica de fora.
  const cadastrosPendentes = opts.teamId ? 0 : await seguro("cadastros-pendentes", () => limparCadastrosPendentesVencidos({ agora }));
  if (agora.getTime() - ultimaGeralMs < RETENCAO_GERAL_INTERVALO_MS) return { rascunhosPendentes, cadastrosPendentes, geral: null };
  ultimaGeralMs = agora.getTime();
  const geral = {
    passos: await seguro("passos", () => limparPassosDeInscricoesEncerradas(base)),
    rascunhosTratados: await seguro("rascunhos-tratados", () => limparRascunhosTratados(base)),
    fatos: await seguro("fatos", () => limparFatosNaoAplicados(base)),
    tarefasFeitas: await seguro("tarefas-feitas", () => limparTarefasFeitasAntigas(base)),
  };
  return { rascunhosPendentes, cadastrosPendentes, geral };
}

/** Só para teste: esquece a última execução do job geral. */
export function _reiniciarRetencaoGeral(): void {
  ultimaGeralMs = 0;
}
