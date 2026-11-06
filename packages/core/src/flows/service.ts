import { Prisma } from "@prisma/client";
import { db, tenantData, basePrisma, runAsSystem } from "@crmagro/db";
import { applyCursor, buildResult, type CursorPaginationResult } from "../shared/pagination";
import {
  ContatoJaNoFluxo,
  EnrollmentChanged,
  EnrollmentNotFound,
  FlowNotActive,
  FlowNotFound,
  FluxoForaDoTipo,
  InvalidGraphError,
  JanelaDeEnvioInvalida,
  NodeNotFound,
  TipoDoFluxoIndisponivel,
  TipoDoFluxoNaoMuda,
} from "./errors";
import { TIPOS_DISPONIVEIS, faltaParaAtivar, problemasDoTipo, type FlowTipoDoFluxo } from "./tipos";
import { janelaEnvioSchema } from "./janela";
import { SNAPSHOT_VERSION, referenciasPendentes } from "./snapshot";
import { snapshotDaInscricao, snapshotsDasInscricoes, snapshotsDasVersoes, versaoDoFluxo } from "./versao";
import { lerEscolha, textoDaEscolha, type TextoDaEscolha } from "./escolha";
import { assertOwned } from "../tenancy/assert-owned";
import {
  type FluxoSemSegredo,
  dadosDoTokenNovo,
  gerarWebhookToken,
  hashDoWebhookToken,
  hashesDoWebhookIguais,
  tirarSegredosDoFluxo,
  tokenDeUrlValido,
  triggerConfigSemToken,
} from "./webhook-token";
import { PROFUNDIDADE_MAX, MOTIVO_OPT_OUT } from "./limites";
import { MARCA_FLUXO_PAUSADO, retomarInscricoesSeguradas, segurarInscricoesDoFluxo } from "./controle";
import { logger } from "../logger/index";
import { scheduleStep } from "./queue";
import { findStartNode } from "./triggers";
import { findOrCreateContact } from "../contacts/service";
import { primaryEmail, primaryTelefone } from "../contacts/identifiers";
import type { FlowCreate, FlowUpdate, SnapshotNode } from "./schema";
import { can, requireCan } from "../auth/authz";

import { donoPadrao } from "../tenancy/escopo";
import { escopoFluxo, escopoInscricao } from "./escopo";
import { inscreverQuemJaTemATag } from "./lista-da-tag";
import { escopoDoContato } from "../contacts/escopo";
/**
 * Serviços de fluxo (CRUD + inscrição). Puros (só @crmagro/db + @crmagro/channels
 * via queue). Chamam `db()` no início de cada função (leitura eager do teamId).
 *
 * Nós são criados SEQUENCIALMENTE (não createMany) pra garantir `createdAt`
 * distintos — o nó inicial é o primeiro por `createdAt` (convenção do motor).
 * Snapshot no Enrollment desacopla a execução de edições posteriores.
 */

type FlowWithNodes = Prisma.FlowGetPayload<{ include: { nodes: { orderBy: { createdAt: "asc" } } } }>;

/** Serializa os nós vivos num snapshot (array ordenado) p/ o Enrollment. */
function toSnapshot(flow: FlowWithNodes): SnapshotNode[] {
  return flow.nodes.map((n) => {
    const base = { id: n.id, config: n.config };
    if (n.tipo === "condition" || n.tipo === "ab_split") {
      return { ...base, tipo: n.tipo, branches: (n.branches ?? undefined) as never } as SnapshotNode;
    }
    return { ...base, tipo: n.tipo, nextNodeId: n.nextNodeId } as SnapshotNode;
  });
}

/**
 * `triggerConfig` que vai para o banco. O token do webhook é só do SERVIDOR: qualquer `webhookToken` que o
 * cliente mande aqui é descartado (antes virava "proposta" do primeiro token). Para o gatilho Webhook o
 * texto puro é espelhado em `triggerConfig.webhookToken` enquanto a coluna `webhookToken` o guardar, para
 * a versão anterior do app continuar exibindo a URL. Sem texto puro (o hash é o único registro), não há
 * espelho. Ver webhook-token.ts.
 */
function configDoGatilho(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
  tokenPuro: string | null,
): Record<string, unknown> | null | undefined {
  const base = triggerConfig ? triggerConfigSemToken(triggerConfig) : triggerConfig;
  if (triggerType !== "webhook" || !tokenPuro) return base;
  return { ...(base ?? {}), webhookToken: tokenPuro };
}

/**
 * Nó `http_request` chama URL arbitrária a partir do servidor (S6). Mesmo com o
 * safeFetch, montar essa integração é de admin; e só `https:`. Checado ao
 * SALVAR (o snapshot de inscrições antigas não é revalidado aqui).
 */
function exigirHttpRequestSeguro(nodes: FlowCreate["nodes"] | undefined): void {
  const http = (nodes ?? []).filter((n) => n.tipo === "http_request");
  if (http.length === 0) return;
  requireCan("flows.activate");
  for (const n of http) {
    const url = (n.config as { url?: string } | undefined)?.url ?? "";
    if (!url.startsWith("https://")) {
      throw new InvalidGraphError(`o nó de requisição HTTP só aceita endereço https:// (${n.id})`);
    }
  }
}

/** Violação do índice único "Enrollment_um_ativo" (inscrição ativa repetida). */
function isUniqueEnrollment(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** Cria um fluxo (rascunho) com seus nós. */
/**
 * O horário de envio do fluxo (`triggerConfig.janelaEnvio`), quando vem, tem de valer: modo conhecido, horas
 * "HH:mm", abertura antes do fechamento e ao menos um dia. Ausente = o fluxo segue a empresa.
 */
function exigirJanelaDeEnvioValida(triggerConfig: Record<string, unknown> | null | undefined): void {
  if (!triggerConfig || triggerConfig.janelaEnvio === undefined) return;
  const r = janelaEnvioSchema.safeParse(triggerConfig.janelaEnvio);
  if (!r.success) throw new JanelaDeEnvioInvalida(r.error.issues[0]?.message ?? "horário de envio inválido");
}

/** O fluxo (gatilho e passos) tem de caber no tipo dele (`tipos.ts`). */
function exigirFluxoDoTipo(tipo: FlowTipoDoFluxo, triggerType: string, nodes: ReadonlyArray<{ tipo: string }>): void {
  const problemas = problemasDoTipo({ tipo, triggerType, nodeTipos: nodes.map((n) => n.tipo) });
  if (problemas.length) throw new FluxoForaDoTipo(problemas);
}

export async function createFlow(input: FlowCreate) {
  requireCan("flows.write");
  exigirHttpRequestSeguro(input.nodes);
  exigirJanelaDeEnvioValida(input.triggerConfig);
  const tipo = input.tipo ?? "prospeccao";
  if (!TIPOS_DISPONIVEIS.includes(tipo)) throw new TipoDoFluxoIndisponivel(tipo);
  exigirFluxoDoTipo(tipo, input.triggerType, input.nodes);
  // O fluxo nasce SEM URL de webhook: quem gera é o `regenerateWebhookToken` (a tela mostra uma vez).
  // Um `webhookToken` no triggerConfig do cliente (cópia de outro fluxo, por exemplo) é descartado.
  const prisma = db();
  const cfg = input.triggerConfig ? configDoGatilho(input.triggerType, input.triggerConfig, null) : undefined;
  const criado = await prisma.$transaction(async (tx) => {
    const flow = await tx.flow.create({
      data: tenantData<Prisma.FlowUncheckedCreateInput>({
        nome: input.nome,
        createdById: donoPadrao(), // F3: quem criou
        triggerType: input.triggerType,
        tipo: input.tipo ?? "prospeccao",
        triggerConfig: (cfg && Object.keys(cfg).length ? cfg : input.triggerConfig ? {} : Prisma.JsonNull) as Prisma.InputJsonValue,
        status: "draft",
      }),
    });
    // Criação sequencial pra garantir ordem por createdAt. Preserva o `id` do
    // cliente — nextNodeId/branches referenciam esses ids (são a chave do grafo).
    for (const n of input.nodes) {
      const branches = n.tipo === "condition" || n.tipo === "ab_split" ? (n.branches ?? null) : null;
      const nextNodeId = n.tipo === "condition" || n.tipo === "ab_split" ? null : n.nextNodeId;
      const pos = input.positions?.[n.id];
      await tx.flowNode.create({
        data: tenantData<Prisma.FlowNodeUncheckedCreateInput>({
          id: n.id,
          flowId: flow.id,
          tipo: n.tipo,
          config: (n.config ?? null) as Prisma.InputJsonValue,
          nextNodeId: nextNodeId ?? null,
          branches: (branches as Prisma.InputJsonValue) ?? null,
          posX: pos?.x ?? null,
          posY: pos?.y ?? null,
        }),
      });
    }
    return tx.flow.findUniqueOrThrow({
      where: { id: flow.id },
      include: { nodes: { orderBy: { createdAt: "asc" } } },
    });
  });
  return tirarSegredosDoFluxo(criado);
}

/** Atualiza um fluxo (recria os nós). Snapshot protege enrollments em curso. */
export async function updateFlow(flowId: string, input: FlowUpdate) {
  requireCan("flows.write");
  exigirHttpRequestSeguro(input.nodes);
  exigirJanelaDeEnvioValida(input.triggerConfig);
  const prisma = db();
  const existing = await prisma.flow.findFirst({
    where: { AND: [{ id: flowId }, escopoFluxo()] },
    include: input.nodes === undefined ? { nodes: { select: { tipo: true } } } : undefined,
  });
  if (!existing) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  // O tipo é da criação. Gatilho e passos que vierem (ou os que já estão, se só um dos dois vier) têm de caber nele.
  if (input.tipo !== undefined && input.tipo !== existing.tipo) throw new TipoDoFluxoNaoMuda();
  if (input.triggerType !== undefined || input.nodes !== undefined) {
    const nosDoFluxo = input.nodes ?? (existing as { nodes?: Array<{ tipo: string }> }).nodes ?? [];
    exigirFluxoDoTipo(existing.tipo, input.triggerType ?? existing.triggerType, nosDoFluxo);
  }
  // Auditoria de isolamento 09/2026: `status: "active"` aqui era um atalho para
  // ATIVAR o fluxo só com `flows.write` (membro) — o PATCH /api/flows/:id
  // aceitava — pulando o `flows.activate` (administrador) e as travas do
  // `activateFlow` (gatilho sem tag/etapa pegava QUALQUER contato). Ativar é
  // sempre pelo `activateFlow`: o papel é conferido ANTES de gravar qualquer coisa.
  const ativando = input.status === "active" && existing.status !== "active";
  if (ativando) requireCan("flows.activate");
  const semStatus: FlowUpdate = { ...input };
  if (ativando) delete semStatus.status;
  // Fluxo no ar (ou indo ao ar) não aceita seta solta (item 1.9, MF-18): a
  // inscrição nova levaria o grafo com um "destino inexistente". Rascunho pode.
  if (input.nodes !== undefined && (input.status ?? existing.status) === "active") exigirSemSetaSolta(input.nodes);
  const salvo = await atualizarFluxo(prisma, flowId, existing, semStatus);
  if (!ativando) {
    // Fluxo de tag que já está no ar: salvar também joga no fluxo quem tem a tag e ainda não rodou.
    if (existing.status === "active" && (input.triggerType ?? existing.triggerType) === "tag_added") {
      return { ...salvo, inscritas: (await inscreverQuemJaTemATag(flowId)).inscritas };
    }
    return salvo;
  }
  await activateFlow(flowId);
  return getFlow(flowId);
}

async function atualizarFluxo(
  prisma: ReturnType<typeof db>,
  flowId: string,
  existing: { triggerType: string; triggerConfig: Prisma.JsonValue; webhookToken: string | null },
  input: FlowUpdate,
) {
  // Salvar NUNCA troca o token do webhook (só `regenerateWebhookToken` troca). O gatilho final (o que veio
  // ou o atual) só decide se o espelho do texto puro continua no triggerConfig.
  const tipoFinal = input.triggerType ?? existing.triggerType;
  const cfgBase =
    input.triggerConfig !== undefined
      ? input.triggerConfig
      : ((existing.triggerConfig as Record<string, unknown> | null) ?? undefined);
  const triggerConfig = configDoGatilho(tipoFinal, cfgBase, existing.webhookToken);
  const mudaGatilho = input.triggerType !== undefined || input.triggerConfig !== undefined;

  const salvo = await prisma.$transaction(async (tx) => {
    if (input.nome !== undefined || mudaGatilho || input.status !== undefined) {
      await tx.flow.update({
        where: { id: flowId },
        data: {
          ...(input.nome !== undefined ? { nome: input.nome } : {}),
          ...(input.triggerType !== undefined ? { triggerType: input.triggerType } : {}),
          ...(mudaGatilho ? { triggerConfig: (triggerConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });
    }
    if (input.nodes !== undefined) {
      await tx.flowNode.deleteMany({ where: { flowId } });
      for (const n of input.nodes) {
        const branches = n.tipo === "condition" || n.tipo === "ab_split" ? (n.branches ?? null) : null;
        const nextNodeId = n.tipo === "condition" || n.tipo === "ab_split" ? null : n.nextNodeId;
        const pos = input.positions?.[n.id];
        await tx.flowNode.create({
          data: tenantData<Prisma.FlowNodeUncheckedCreateInput>({
            id: n.id,
            flowId,
            tipo: n.tipo,
            config: (n.config ?? null) as Prisma.InputJsonValue,
            nextNodeId: nextNodeId ?? null,
            branches: (branches as Prisma.InputJsonValue) ?? null,
            posX: pos?.x ?? null,
            posY: pos?.y ?? null,
          }),
        });
      }
    }
    return tx.flow.findUniqueOrThrow({
      where: { id: flowId },
      include: { nodes: { orderBy: { createdAt: "asc" } } },
    });
  });
  return tirarSegredosDoFluxo(salvo);
}

/** Leitura interna, COM os campos do token do webhook (só o serviço enxerga; a que sai é `getFlow`). */
async function getFlowBruto(flowId: string): Promise<FlowWithNodes> {
  const prisma = db();
  // F3: os fluxos de quem pede + os compartilhados (o sistema vê todos).
  const flow = await prisma.flow.findFirst({
    where: { AND: [{ id: flowId }, escopoFluxo()] },
    include: { nodes: { orderBy: { createdAt: "asc" } } },
  });
  if (!flow) throw new FlowNotFound(flowId);
  return flow;
}

/**
 * O fluxo com os passos. Nunca traz o token do webhook (nem o hash, nem o espelho no `triggerConfig`): em
 * vez disso vêm `webhookTem` e `webhookGeradoEm`. Quem precisa mostrar a URL usa `lerWebhookDoFluxo`.
 */
export async function getFlow(flowId: string) {
  return tirarSegredosDoFluxo(await getFlowBruto(flowId));
}

/** Fluxo + contagem de inscrições (mesmo formato do `include: { _count }` de antes), sem o token do webhook. */
type FlowWithCount = FluxoSemSegredo<Prisma.FlowGetPayload<true>> & { _count: { enrollments: number } };

/**
 * Lista fluxos do time (com contagem de inscrições) com paginação cursor-based
 * (§paginação). `cursor` precede `offset`; sem ambos, primeira página. `orderBy`
 * termina em `id` (desempate estável do cursor).
 *
 * A contagem vem de um `groupBy` só dos fluxos da página, com o `teamId` da
 * extensão. O `include: { _count }` agregava o Enrollment de TODOS os times a
 * cada chamada (DP-11).
 */
export async function listFlows(
  opts: { cursor?: string; limit?: number; offset?: number; tipo?: FlowTipoDoFluxo } = {},
): Promise<CursorPaginationResult<FlowWithCount>> {
  const prisma = db();
  const { cursor, limit = 50, offset = 0, tipo } = opts;
  const rows = await prisma.flow.findMany({
    where: { AND: [escopoFluxo(), tipo ? { tipo } : {}] }, // F3
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(cursor ? applyCursor({ cursor, limit }) : { take: limit + 1, skip: offset }),
  });
  const pagina = buildResult(rows, limit);
  const contagens = pagina.items.length
    ? await prisma.enrollment.groupBy({
        by: ["flowId"],
        where: { flowId: { in: pagina.items.map((f) => f.id) }, paiId: null }, // contatos que entraram: ramos não contam
        _count: { _all: true },
      })
    : [];
  const porFluxo = new Map(contagens.map((g) => [g.flowId, g._count._all]));
  return {
    ...pagina,
    items: pagina.items.map((f) => ({ ...tirarSegredosDoFluxo(f), _count: { enrollments: porFluxo.get(f.id) ?? 0 } })),
  };
}

export type FlowMetrics = { total: number; emAndamento: number; concluidos: number; falhas: number };

/**
 * Fluxos com métricas de inscrição por status — "deu certo/errado" no nível do
 * fluxo, exato (vem do Enrollment). total = contatos que entraram; emAndamento =
 * active+waiting; concluidos = done; falhas = failed.
 */
export async function listFlowsWithMetrics() {
  const prisma = db();
  const [flows, grouped] = await Promise.all([
    prisma.flow.findMany({ where: escopoFluxo(), orderBy: [{ createdAt: "desc" }, { id: "desc" }] }), // F3
    prisma.enrollment.groupBy({ by: ["flowId", "status"], where: { paiId: null }, _count: { _all: true } }), // ramos paralelos não contam como contato
  ]);
  const byFlow = new Map<string, FlowMetrics>();
  for (const g of grouped) {
    const m = byFlow.get(g.flowId) ?? { total: 0, emAndamento: 0, concluidos: 0, falhas: 0 };
    const n = g._count._all;
    m.total += n;
    if (g.status === "active" || g.status === "waiting") m.emAndamento += n;
    else if (g.status === "done") m.concluidos += n;
    else if (g.status === "failed") m.falhas += n;
    byFlow.set(g.flowId, m);
  }
  return flows.map((f) => ({
    ...tirarSegredosDoFluxo(f),
    metrics: byFlow.get(f.id) ?? { total: 0, emAndamento: 0, concluidos: 0, falhas: 0 },
  }));
}

/** Ativa um fluxo. Bloqueia gatilho de tag sem tag. */
/** Recusa o grafo com seta apontando para nó que não existe. */
function exigirSemSetaSolta(nodes: Array<{ id: string; tipo: string; nextNodeId?: string | null; branches?: unknown }>) {
  const soltas = referenciasPendentes(nodes);
  if (soltas.length) {
    const lista = soltas.slice(0, 3).map((r) => `${r.de} → ${r.para}`).join(", ");
    throw new InvalidGraphError(`há setas apontando para passos que não existem mais (${lista}). Religue ou apague antes de ativar`);
  }
}

/** O agente em modo "conversa" sem orientação não sabe o que dizer: não deixa ativar. */
function exigirAgentesComOrientacao(nodes: Array<{ tipo: string; config?: unknown }>) {
  const semOrientacao = nodes.some((n) => {
    if (n.tipo !== "ai_agent") return false;
    const c = (n.config ?? {}) as { modo?: string; orientacao?: string };
    return c.modo === "conversa" && !(c.orientacao ?? "").trim();
  });
  if (semOrientacao) throw new InvalidGraphError("o agente em modo conversa precisa de uma orientação antes de ativar o fluxo");
}

export async function activateFlow(flowId: string) {
  requireCan("flows.activate");
  const flow = await getFlowBruto(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  exigirSemSetaSolta(flow.nodes);
  exigirAgentesComOrientacao(flow.nodes);
  exigirFluxoDoTipo(flow.tipo, flow.triggerType, flow.nodes);
  const falta = faltaParaAtivar({ tipo: flow.tipo, nodeTipos: flow.nodes.map((n) => n.tipo) });
  if (falta) throw new InvalidGraphError(falta);
  // Nó `ai_agent` agora está implementado (geração personalizada + envio com
  // fail-open e controle de ritmo) — deixou de bloquear a ativação.
  // Trava da "lista": um gatilho de tag sem tag selecionada nunca dispararia —
  // não deixa ativar (pedido do produto: "não pode ativar sem ter uma lista/tag").
  if (flow.triggerType === "tag_added") {
    const tagId = (flow.triggerConfig as { tagId?: string } | null)?.tagId;
    if (!tagId) {
      throw new InvalidGraphError("selecione a tag do gatilho antes de ativar o fluxo");
    }
  }
  // Mesma trava para "mudou de etapa" (item 1.5, MF-09): sem etapa escolhida o
  // fluxo pegava QUALQUER mudança de QUALQUER funil (inclusive "Perdido").
  if (flow.triggerType === "stage_changed") {
    const toStageId = (flow.triggerConfig as { toStageId?: string } | null)?.toStageId;
    if (!toStageId) {
      throw new InvalidGraphError("selecione a etapa do gatilho (\"entrou em…\") antes de ativar o fluxo");
    }
  }
  // Webhook sem URL gerada: o servidor não gera sozinho na ativação (ninguém veria o token, e só o hash
  // ficaria no banco). A tela tem o botão "Gerar URL do webhook".
  if (flow.triggerType === "webhook" && !flow.webhookTokenHash && !flow.webhookToken) {
    throw new InvalidGraphError("gere a URL do webhook antes de ativar o fluxo");
  }
  const prisma = db();
  const estavaPausado = flow.status === "paused";
  const atualizado = await prisma.flow.update({ where: { id: flowId }, data: { status: "active" } });
  // Reativar depois de pausar (item 1.5): as inscrições seguradas pela pausa
  // voltam ao passo exato em que pararam.
  const retomadas = estavaPausado ? await retomarInscricoesSeguradas(flowId) : 0;
  // Gatilho de tag: quem já tem a tag e ainda não rodou entra agora (antes só entrava quem recebia a tag depois).
  const inscritas = flow.triggerType === "tag_added" ? (await inscreverQuemJaTemATag(flowId)).inscritas : 0;
  return { ...tirarSegredosDoFluxo(atualizado), retomadas, inscritas };
}

/** Retomar um fluxo pausado = ativar (que reagenda as inscrições seguradas). */
export const resumeFlow = activateFlow;

/**
 * Gera a URL do webhook do fluxo (a primeira vez) ou troca por uma nova (o token antigo para de funcionar
 * na hora). Para quando o token vazou ou a campanha antiga não deve mais inscrever ninguém.
 *
 * É a ÚNICA porta que cria token. Devolve o texto UMA vez, para a tela mostrar na hora; no banco fica o
 * hash (e, com `FLOW_WEBHOOK_TOKEN_HASH` desligada, o texto também, para voltar a versão do app sem
 * derrubar URL). O token nunca vai para o log.
 */
export async function regenerateWebhookToken(flowId: string): Promise<{ webhookToken: string; geradoEm: Date }> {
  const ator = requireCan("flows.write");
  const prisma = db();
  const flow = await prisma.flow.findFirst({ where: { AND: [{ id: flowId }, escopoFluxo()] }, select: { triggerType: true, triggerConfig: true } });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  if (flow.triggerType !== "webhook") throw new InvalidGraphError("o gatilho deste fluxo não é Webhook");
  const webhookToken = gerarWebhookToken();
  const dados = dadosDoTokenNovo(webhookToken);
  await prisma.flow.update({
    where: { id: flowId },
    data: {
      ...dados,
      // O espelho acompanha o texto puro: com a chave ligada o texto vira NULL e o espelho antigo some.
      triggerConfig: (configDoGatilho("webhook", flow.triggerConfig as Record<string, unknown> | null, dados.webhookToken) ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
  logger.info({ flowId, userId: ator.userId }, "[flow] URL do webhook gerada");
  return { webhookToken, geradoEm: dados.webhookTokenGeradoEm };
}

/**
 * Estado da URL do webhook para a tela do editor. Nunca devolve o hash. O texto puro (`tokenLegado`) só
 * existe para fluxo criado antes do hash (ou com a chave desligada) e só vai para quem pode editar fluxos,
 * enquanto o script de limpeza não o apaga.
 */
export async function lerWebhookDoFluxo(flowId: string): Promise<{ temUrl: boolean; geradaEm: Date | null; tokenLegado: string | null }> {
  const prisma = db();
  const flow = await prisma.flow.findFirst({
    where: { AND: [{ id: flowId }, escopoFluxo()] },
    select: { webhookToken: true, webhookTokenHash: true, webhookTokenGeradoEm: true },
  });
  if (!flow) throw new FlowNotFound(flowId);
  return {
    temUrl: Boolean(flow.webhookTokenHash || flow.webhookToken),
    geradaEm: flow.webhookTokenGeradoEm,
    tokenLegado: flow.webhookToken && can("flows.write") ? flow.webhookToken : null,
  };
}

export async function pauseFlow(flowId: string) {
  requireCan("flows.write");
  const prisma = db();
  const flow = await prisma.flow.findFirst({ where: { AND: [{ id: flowId }, escopoFluxo()] } });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  const pausado = tirarSegredosDoFluxo(await prisma.flow.update({ where: { id: flowId }, data: { status: "paused" } }));
  // Pausar para de verdade: cada inscrição em andamento fica segurada no passo em que está (e volta dele ao ativar).
  const seguradas = await segurarInscricoesDoFluxo(flowId);
  return { ...pausado, seguradas };
}

export async function archiveFlow(flowId: string) {
  requireCan("flows.write");
  const prisma = db();
  const flow = await prisma.flow.findFirst({ where: { AND: [{ id: flowId }, escopoFluxo()] } });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  return tirarSegredosDoFluxo(await prisma.flow.update({ where: { id: flowId }, data: { status: "archived" } }));
}

/**
 * Edita o nome e o horário de envio do fluxo SEM mexer nos passos (menu ⋯ da lista de fluxos). O horário é
 * mesclado no `triggerConfig`: as outras chaves (reentrada, exclusivo, etapa do funil, tag, webhook) ficam como
 * estão. Vale na hora para o fluxo ativo (o horário é lido a cada passo).
 */
export async function updateFlowSettings(flowId: string, input: { nome?: string; janelaEnvio?: unknown }) {
  requireCan("flows.write");
  const prisma = db();
  const flow = await prisma.flow.findFirst({ where: { AND: [{ id: flowId }, escopoFluxo()] } });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  const nome = input.nome === undefined ? undefined : input.nome.trim();
  if (nome !== undefined && !nome) throw new InvalidGraphError("o nome do fluxo não pode ficar vazio");
  let triggerConfig: Prisma.InputJsonValue | undefined;
  if (input.janelaEnvio !== undefined) {
    exigirJanelaDeEnvioValida({ janelaEnvio: input.janelaEnvio });
    triggerConfig = { ...((flow.triggerConfig as Record<string, unknown> | null) ?? {}), janelaEnvio: input.janelaEnvio } as Prisma.InputJsonValue;
  }
  return tirarSegredosDoFluxo(
    await prisma.flow.update({
      where: { id: flowId },
      data: { ...(nome !== undefined ? { nome } : {}), ...(triggerConfig !== undefined ? { triggerConfig } : {}) },
    }),
  );
}

/**
 * Exclui o fluxo. As inscrições, o histórico e as versões dele saem junto (cascata do banco); campanha que usava
 * o fluxo fica sem fluxo. Job que ainda esteja na fila acha que a inscrição não existe e é descartado. Devolve
 * quantas inscrições estavam em andamento, para a tela dizer.
 */
export async function deleteFlow(flowId: string): Promise<{ inscricoesEmAndamento: number }> {
  requireCan("flows.write");
  const prisma = db();
  const flow = await prisma.flow.findFirst({ where: { AND: [{ id: flowId }, escopoFluxo()] }, select: { id: true } });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  const inscricoesEmAndamento = await prisma.enrollment.count({ where: { flowId, status: { in: ["active", "waiting"] } } });
  await prisma.flow.delete({ where: { id: flowId } });
  logger.warn({ flowId, inscricoesEmAndamento }, "[flow] fluxo excluído");
  return { inscricoesEmAndamento };
}

/**
 * Inscreve um contato num fluxo (gatilho manual ou teste). Cria o Enrollment
 * com o snapshot do grafo e agenda o primeiro passo. Roda em runWithTeam.
 */
export async function enroll(contactId: string, flowId: string, opts: { profundidade?: number } = {}) {
  requireCan("flows.write");
  const prisma = db();
  const flow = await prisma.flow.findFirst({
    where: { AND: [{ id: flowId }, escopoFluxo()] },
    include: { nodes: { orderBy: { createdAt: "asc" } } },
  });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não altera
  if (flow.status !== "active") throw new FlowNotActive(flowId);
  if (flow.nodes.length === 0) throw new InvalidGraphError("fluxo sem nós");
  // Fluxo de marketing não fala com contato: ninguém é inscrito nele por aqui (nem por "Testar" nem por "Trocar de fluxo").
  if (flow.tipo === "marketing") throw new InvalidGraphError("fluxo de Marketing não recebe contatos");
  // S1: o contactId vem do cliente ("Testar" fluxo). Sem esta prova, o worker
  // carregava o contato de outro time e disparava WhatsApp/e-mail para ele.
  await assertOwned("contact", contactId);
  // Opt-out (N12): nem o "Testar" inscreve quem pediu para sair.
  const optOut = await db().contact.findUnique({ where: { id: contactId }, select: { relacionamentoStatus: true } });
  if (optOut?.relacionamentoStatus === "opt_out") throw new InvalidGraphError(MOTIVO_OPT_OUT);
  // Nó "trocar de fluxo" (item 1.4): A→B→A em cascata para no limite.
  const profundidade = opts.profundidade ?? 0;
  if (profundidade > PROFUNDIDADE_MAX) {
    throw new InvalidGraphError("cascata de fluxos longa demais (troca de fluxo em ciclo?)");
  }

  // Mesma trava do enrollByTrigger: clicar "Testar" duas vezes mandava a
  // mensagem duas vezes para o mesmo contato (aconteceu em produção).
  const emCurso = await prisma.enrollment.findFirst({
    where: { flowId, contactId, status: { in: ["active", "waiting"] } },
    select: { id: true },
  });
  if (emCurso) {
    throw new ContatoJaNoFluxo();
  }

  const snapshot = toSnapshot(flow as FlowWithNodes);
  const startId = (flow.triggerConfig as { startNodeId?: string } | null)?.startNodeId ?? null;
  const first = findStartNode(snapshot, flow.nodes, startId);
  if (!first) throw new InvalidGraphError("fluxo sem nó inicial");
  // Grafo congelado na FlowVersion deduplicada (item 2.7, DP-14).
  const flowVersionId = await versaoDoFluxo(flowId, snapshot);
  let enr;
  try {
    enr = await prisma.enrollment.create({
      data: tenantData<Prisma.EnrollmentUncheckedCreateInput>({
        flowId,
        contactId,
        currentNodeId: first.id,
        // Ponteiro completo desde o nascimento (item 0.9): se o scheduleStep
        // abaixo falhar, a varredura acha e reagenda.
        currentRound: 1,
        nextRunAt: new Date(),
        profundidade,
        status: "active",
        flowVersionId,
        snapshotVersion: SNAPSHOT_VERSION,
      }),
    });
  } catch (e) {
    // Dois cliques em "Testar" ao mesmo tempo: o índice único parcial
    // (fluxo, contato, ativo) barra o segundo (MF-04).
    if (isUniqueEnrollment(e)) {
      throw new ContatoJaNoFluxo();
    }
    throw e;
  }
  await scheduleStep(enr.id, first.id, 1);
  return enr;
}

/**
 * Gatilho de WEBHOOK (recebimento HTTP): um lead "levanta a mão" numa campanha e
 * uma requisição externa chega com os dados. Resolve o fluxo pelo HASH do token
 * (`Flow.webhookTokenHash`), acha/cria o contato (dedup) e o inscreve NAQUELE fluxo.
 *
 * Não-autenticado por natureza (chamado por sistemas externos), então resolve o
 * time pelo token via `basePrisma` (cross-team) e abre `runWithTeam` — mesmo
 * padrão do webhook de WhatsApp. O token é o segredo: sem token válido, nada roda.
 * O token não entra em log nem em chave de limite (usa o hash, ver webhook-token.ts).
 */
export async function enrollByWebhook(
  token: string,
  data: {
    nome?: string;
    telefone?: string;
    email?: string;
    empresa?: string;
    cidade?: string;
    cargo?: string;
    origem?: string;
  },
): Promise<{ ok: boolean; contactId?: string; error?: string }> {
  if (!token || !tokenDeUrlValido(token)) return { ok: false, error: "token ausente ou inválido" };
  // Lookup pelo HASH, índice ÚNICO (S5): um token = um fluxo, sem ambiguidade entre times. O banco só
  // compara hashes; conferimos de novo em tempo constante o que voltou contra o hash do token apresentado.
  const hash = hashDoWebhookToken(token);
  const selecao = { id: true, teamId: true, status: true, triggerType: true, webhookTokenHash: true } as const;
  let achado = await basePrisma.flow.findUnique({ where: { webhookTokenHash: hash }, select: selecao });
  if (achado && !hashesDoWebhookIguais(achado.webhookTokenHash, hash)) achado = null;
  if (!achado) {
    // Fluxo criado entre a migration do hash e o deploy do código novo (ou antes do backfill): só tem o
    // texto. Vale SÓ para linha sem hash (a que tem hash só entra pelo hash) e já grava o hash, para a
    // próxima chamada achar pelo caminho normal.
    achado = await basePrisma.flow.findFirst({ where: { webhookToken: token, webhookTokenHash: null }, select: selecao });
    if (achado) {
      await basePrisma.flow.update({ where: { id: achado.id }, data: { webhookTokenHash: hash } }).catch(() => undefined);
    }
  }
  const flow = achado && achado.status === "active" && achado.triggerType === "webhook" ? achado : null;
  if (!flow) {
    return { ok: false, error: "nenhum fluxo ativo com gatilho Webhook para este token" };
  }
  return runAsSystem(flow.teamId, async () => {
    const { contactId } = await findOrCreateContact(data);
    try {
      await enroll(contactId, flow.id);
    } catch {
      // trava de reinscrição (já está no fluxo) não é erro para o chamador.
    }
    return { ok: true, contactId };
  });
}

export async function listEnrollments(flowId?: string) {
  const prisma = db();
  return prisma.enrollment.findMany({
    where: { AND: [flowId ? { flowId } : {}, escopoInscricao()] },
    orderBy: { createdAt: "desc" },
    include: { flow: { select: { nome: true } }, contact: { select: { nome: true } } },
    take: 100,
  });
}

/** Onde o agente de conversa está, para o log do fluxo. */
function descreverTurnoDoAgente(a: { acao?: string; enviadas?: number } | undefined): string | null {
  if (!a?.acao) return null;
  const n = a.enviadas ?? 0;
  const mensagens = `${n} ${n === 1 ? "mensagem enviada" : "mensagens enviadas"}`;
  switch (a.acao) {
    case "esperando":
      return `Agente: ${mensagens}, esperando o contato`;
    case "preparando":
      return "Agente: preparando a resposta";
    case "tentando_de_novo":
      return "Agente: a IA falhou, tenta de novo";
    default:
      return null;
  }
}

/**
 * Execuções recentes de um fluxo, com os passos de cada uma — o "log" que o
 * usuário abre para saber que o fluxo rodou e por onde passou. Achata para um
 * DTO simples, pronto para a UI.
 */
export async function listFlowRuns(flowId: string, take = 15) {
  const prisma = db();
  const runs = await prisma.enrollment.findMany({
    where: { AND: [{ flowId }, escopoInscricao()] },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      contact: { select: { id: true, nome: true } },
      stepExecutions: {
        orderBy: { startedAt: "asc" },
        select: { id: true, nodeId: true, round: true, status: true, result: true, error: true, startedAt: true },
      },
    },
  });
  // Grafo de cada inscrição: da versão (nova, uma consulta para todas) ou do
  // próprio flowSnapshot (antiga) — item 2.7.
  const snapDe = await snapshotsDasInscricoes(runs);
  return runs.map((r) => {
    // nodeId → tipo pelo snapshot da inscrição (o result do step não guarda tipo).
    const snap = (snapDe.get(r.id) ?? []) as Array<{ id: string; tipo: string }>;
    const tipoDe = new Map(snap.map((n) => [n.id, n.tipo]));
    // Colapsa execuções CONSECUTIVAS do mesmo nó (os re-checks de poll da
    // condition, que rodam a cada 30s enquanto a janela está aberta). Em vez de
    // dezenas de linhas "condição avaliada", uma linha com a contagem (repeat).
    type Step = {
      id: string;
      nodeId: string;
      nodeType: string | null;
      round: number;
      status: string;
      skipped: boolean;
      error: string | null;
      /** O que o passo fez, em uma frase (motivo do adiamento, onde o agente de conversa está). */
      detail: string | null;
      /** Qual saída um passo de decisão (condição, teste A/B) seguiu; `null` nos demais e enquanto a condição ainda espera. */
      escolha: TextoDaEscolha | null;
      at: string;
      repeat: number;
    };
    const steps: Step[] = [];
    for (const s of r.stepExecutions) {
      const res = (s.result ?? null) as { skipped?: boolean; motivo?: string; agente?: { acao?: string; enviadas?: number } } | null;
      const detail = res?.motivo ?? descreverTurnoDoAgente(res?.agente) ?? null;
      const lida = lerEscolha(s.result);
      const escolha = lida ? textoDaEscolha(lida) : null;
      const last = steps[steps.length - 1];
      if (last && last.nodeId === s.nodeId && last.error === (s.error ?? null)) {
        // mesmo nó em sequência → conta como re-check e atualiza o desfecho
        last.repeat += 1;
        last.round = s.round;
        last.status = s.status;
        last.detail = detail ?? last.detail;
        last.escolha = escolha ?? last.escolha;
        last.at = s.startedAt.toISOString();
        continue;
      }
      steps.push({
        id: s.id,
        nodeId: s.nodeId,
        nodeType: tipoDe.get(s.nodeId) ?? null,
        round: s.round,
        status: s.status,
        skipped: res?.skipped ?? false,
        error: s.error,
        detail,
        escolha,
        at: s.startedAt.toISOString(),
        repeat: 1,
      });
    }
    // O porquê da situação, em uma frase: o último passo que tem erro ou motivo (a tela mostra embaixo dos
    // passos, para a pessoa não ter que passar o mouse em cada um).
    const ultimoComTexto = [...steps].reverse().find((st) => st.error || st.detail);
    return {
      id: r.id,
      contactId: r.contact.id,
      contactNome: r.contact.nome,
      /** Caminho paralelo de uma saída com vários destinos (o contato aparece uma vez por ramo). */
      ramo: r.paiId !== null,
      status: r.status,
      resumo: ultimoComTexto ? (ultimoComTexto.error ?? ultimoComTexto.detail) : null,
      // Segurada pela pausa do fluxo: volta de onde parou quando o fluxo for ativado.
      pausada: r.waitingFor === "fluxo_pausado",
      stepNumber: r.stepNumber,
      nextRunAt: r.nextRunAt ? r.nextRunAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      steps,
    };
  });
}

export async function getEnrollment(id: string) {
  const prisma = db();
  const enr = await prisma.enrollment.findFirst({
    where: { AND: [{ id }, escopoInscricao()] },
    include: {
      flow: { select: { nome: true } },
      contact: { select: { id: true, nome: true, tags: true, ownerId: true } },
      stepExecutions: { orderBy: { startedAt: "asc" } },
    },
  });
  if (!enr) throw new FlowNotFound(id);
  return enr;
}

/**
 * Enrollments que PRECISAM de atenção humana — a aba "Histórico" do fluxo
 * (substitui o "revisar contato" das Atividades). Inclui:
 *  - TRAVADOS (waiting + nextRunAt null): revenda segurada por histórico, ou
 *    ligação manual pendente aguardando "feito";
 *  - FALHADOS (failed): um passo estourou e precisa de decisão.
 * Traz contato + nó atual (tipo) + último erro, agrupável na UI.
 *
 * Sem o snapshot (item 2.7, DP-14): antes o `include` trazia o grafo inteiro de
 * cada uma das 100 inscrições (textos, prompts de IA) só para ler o tipo do nó
 * corrente, e o `stepExecutions: { take: 1 }` com vários pais carregava TODAS
 * as execuções delas (o Prisma corta em memória). Agora: `select` enxuto, o
 * tipo vem da versão do fluxo (inscrição nova) ou do grafo atual (antiga; o
 * snapshot só é lido para o nó que saiu do fluxo) e o último erro vem de um
 * `groupBy`.
 */
export async function listReviewEnrollments(flowId: string) {
  const prisma = db();
  const rows = await prisma.enrollment.findMany({
    where: {
      flowId,
      // A segurada PELA PAUSA não é para revisar (volta ao ativar; o andamento do fluxo mostra e tem o botão de retomar):
      // sem esta exceção, pausar um fluxo grande enchia a aba Histórico e o contador "revisar" com gente que só está parada.
      OR: [
        { status: "waiting", nextRunAt: null, OR: [{ waitingFor: null }, { waitingFor: { not: MARCA_FLUXO_PAUSADO } }] },
        { status: "failed" },
      ],
      AND: [escopoInscricao()],
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      status: true,
      currentNodeId: true,
      flowVersionId: true,
      updatedAt: true,
      contact: {
        select: {
          id: true,
          nome: true,
          empresa: true,
          tags: true,
          identifiers: { select: { canal: true, valor: true, valorCifrado: true, isPrimary: true } },
        },
      },
    },
  });
  if (rows.length === 0) return [];
  const [tipoDe, erroDe] = await Promise.all([
    tiposDosNosCorrentes(prisma, flowId, rows),
    ultimoErroPorInscricao(prisma, rows.map((r) => r.id)),
  ]);
  return rows.map((r) => {
    const tipo = tipoDe.get(r.id) ?? null;
    return {
      id: r.id,
      contactId: r.contact.id,
      contactNome: r.contact.nome,
      contactEmpresa: r.contact.empresa,
      contactTelefone: primaryTelefone(r.contact.identifiers),
      contactEmail: primaryEmail(r.contact.identifiers),
      contactTags: r.contact.tags,
      status: r.status,
      motivo: tipo === "manual_call" ? "ligação pendente" : r.status === "failed" ? "falhou" : "segurado p/ revisão",
      currentNodeId: r.currentNodeId,
      currentNodeType: tipo,
      erro: erroDe.get(r.id) ?? null,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/** Tipo do nó `nodeId` num snapshot cru (array de nós). */
function tipoNoSnapshot(snapshot: unknown, nodeId: string): string | undefined {
  const nos = (Array.isArray(snapshot) ? snapshot : []) as Array<{ id?: string; tipo?: string } | null>;
  return nos.find((n) => n?.id === nodeId)?.tipo;
}

/**
 * Tipo do nó corrente de cada inscrição (enrollmentId → tipo).
 * - Inscrição NOVA (com versão): o tipo exato vem da versão congelada — poucas
 *   por fluxo, numa consulta só e em cache (item 2.7).
 * - Inscrição ANTIGA: o grafo atual do fluxo responde quase sempre (o id de um
 *   nó nasce no editor e o tipo não muda depois); só a parada num nó que foi
 *   APAGADO do fluxo lê o próprio snapshot.
 */
async function tiposDosNosCorrentes(
  prisma: ReturnType<typeof db>,
  flowId: string,
  rows: Array<{ id: string; currentNodeId: string; flowVersionId: string | null }>,
): Promise<Map<string, string>> {
  const tipos = new Map<string, string>();
  const versoes = await snapshotsDasVersoes(rows.flatMap((r) => (r.flowVersionId ? [r.flowVersionId] : [])));
  const antigas: typeof rows = [];
  for (const r of rows) {
    if (!r.flowVersionId) {
      antigas.push(r);
      continue;
    }
    const t = tipoNoSnapshot(versoes.get(r.flowVersionId), r.currentNodeId);
    if (t) tipos.set(r.id, t);
  }
  if (antigas.length === 0) return tipos;

  const nos = await prisma.flowNode.findMany({ where: { flowId }, select: { id: true, tipo: true } });
  const doGrafo = new Map<string, string>(nos.map((n) => [n.id, n.tipo]));
  const foraDoGrafo: string[] = [];
  for (const r of antigas) {
    const t = doGrafo.get(r.currentNodeId);
    if (t) tipos.set(r.id, t);
    else foraDoGrafo.push(r.id);
  }
  if (foraDoGrafo.length) {
    const snaps = await prisma.enrollment.findMany({
      where: { id: { in: foraDoGrafo } },
      select: { id: true, currentNodeId: true, flowSnapshot: true },
    });
    for (const s of snaps) {
      const t = tipoNoSnapshot(s.flowSnapshot, s.currentNodeId);
      if (t) tipos.set(s.id, t);
    }
  }
  return tipos;
}

/**
 * Erro do passo MAIS RECENTE de cada inscrição (enrollmentId → erro), sem
 * carregar o histórico: `groupBy` acha o último `startedAt` de cada uma e uma
 * consulta traz só esses passos. Empate no mesmo instante: vale o que tem erro.
 */
async function ultimoErroPorInscricao(prisma: ReturnType<typeof db>, ids: string[]): Promise<Map<string, string | null>> {
  const ultimos = await prisma.flowStepExecution.groupBy({
    by: ["enrollmentId"],
    where: { enrollmentId: { in: ids } },
    _max: { startedAt: true },
  });
  const pares = ultimos.flatMap((u) => (u._max.startedAt ? [{ enrollmentId: u.enrollmentId, startedAt: u._max.startedAt }] : []));
  const erros = new Map<string, string | null>();
  if (pares.length === 0) return erros;
  const passos = await prisma.flowStepExecution.findMany({ where: { OR: pares }, select: { enrollmentId: true, error: true } });
  for (const p of passos) if (!erros.get(p.enrollmentId)) erros.set(p.enrollmentId, p.error);
  return erros;
}

/** Nós do snapshot de um enrollment (para o seletor "definir destino" da revisão). */
export async function enrollmentNodes(enrollmentId: string) {
  const prisma = db();
  const enr = await prisma.enrollment.findFirst({
    where: { AND: [{ id: enrollmentId }, escopoInscricao()] },
    select: { flowSnapshot: true, flowVersionId: true },
  });
  const snap = ((enr ? await snapshotDaInscricao(enr) : null) ?? []) as Array<{ id: string; tipo: string }>;
  return snap.map((n) => ({ id: n.id, tipo: n.tipo }));
}

/**
 * Devolve um enrollment TRAVADO/falhado ao fluxo a partir de um nó escolhido
 * ("definir destino"). toNodeId null = encerra a inscrição (done). Reagenda o
 * passo no worker via BullMQ.
 */
export async function redirectEnrollment(
  enrollmentId: string,
  toNodeId: string | null,
  /** Ponteiro que a TELA mostrava (opcional): se mudou, recusa em vez de bifurcar. */
  esperado?: { nodeId: string; round?: number },
) {
  requireCan("flows.write");
  const prisma = db();
  const enr = await prisma.enrollment.findFirst({ where: { AND: [{ id: enrollmentId }, escopoInscricao({ escrita: true })] } });
  if (!enr) throw new EnrollmentNotFound(enrollmentId);
  if (esperado && (enr.currentNodeId !== esperado.nodeId || (esperado.round !== undefined && enr.currentRound !== esperado.round))) {
    throw new EnrollmentChanged(enrollmentId);
  }
  // Compare-and-set (item 1.9, MF-17): só redireciona a inscrição PARADA
  // (segurada/esperando/falhou) e no ponteiro que acabamos de ler. O 2º clique
  // de "definir destino" acha a inscrição já `active` (ou noutro nó) e é
  // recusado — antes, calculava outro round e duas linhas corriam juntas.
  const onde = {
    id: enrollmentId,
    status: { in: ["waiting" as const, "failed" as const] },
    currentNodeId: enr.currentNodeId,
    currentRound: enr.currentRound,
  };
  if (toNodeId === null) {
    const { count } = await prisma.enrollment.updateMany({
      where: onde,
      data: { status: "done", nextRunAt: null, waitingFor: null, waitingUntil: null },
    });
    if (count !== 1) throw new EnrollmentChanged(enrollmentId);
    return;
  }
  // O destino vem do cliente: tem de ser um nó DO snapshot desta inscrição
  // (o worker só executa o snapshot; nó de fora vira "destino inexistente").
  const snap = ((await snapshotDaInscricao(enr)) ?? []) as Array<{ id: string }>;
  if (!Array.isArray(snap) || !snap.some((n) => n.id === toNodeId)) throw new NodeNotFound(toNodeId);
  // Ponteiro completo ANTES de agendar (item 0.9): se o Redis falhar, a
  // varredura reagenda a partir dele.
  const round = (await prisma.flowStepExecution.count({ where: { enrollmentId, nodeId: toNodeId } })) + 1;
  const { count } = await prisma.enrollment.updateMany({
    where: onde,
    data: { status: "active", currentNodeId: toNodeId, currentRound: round, nextRunAt: new Date(), waitingFor: null, waitingUntil: null },
  });
  if (count !== 1) throw new EnrollmentChanged(enrollmentId);
  await scheduleStep(enrollmentId, toNodeId, round);
}

/**
 * Marca a ligação manual PENDENTE de um enrollment como FEITA (com resumo e
 * observação) e devolve o fluxo ao próximo nó. Registra o desfecho no histórico
 * do contato (data/hora automáticas via createdAt/meta.doneAt).
 */
export async function completeManualCall(
  enrollmentId: string,
  input: { resumo?: string; observacao?: string },
) {
  requireCan("flows.write");
  const prisma = db();
  // F3: a tarefa é de quem vê o CONTATO (não o fluxo) — o vendedor conclui a
  // ligação que o fluxo do admin pediu no contato dele.
  const enr = await prisma.enrollment.findFirst({ where: { AND: [{ id: enrollmentId }, { contact: escopoDoContato({ escrita: true }) }] } });
  if (!enr) throw new FlowNotFound(enrollmentId);
  const snap = ((await snapshotDaInscricao(enr)) ?? []) as Array<{ id: string; tipo: string; nextNodeId?: string | null }>;
  const node = snap.find((n) => n.id === enr.currentNodeId);
  // Só a ligação PENDENTE (inscrição segurada no nó manual_call). O 2º clique
  // em "ligação feita" acha a inscrição já adiante e para aqui (item 1.9).
  if (enr.status !== "waiting" || node?.tipo !== "manual_call") throw new EnrollmentChanged(enrollmentId);

  const pendente = await prisma.activity.findFirst({
    where: {
      contactId: enr.contactId,
      tipo: "call",
      meta: { path: ["enrollmentId"], equals: enrollmentId },
    },
    orderBy: { createdAt: "desc" },
  });
  const resumo = input.resumo?.trim();
  const obs = input.observacao?.trim();
  const conteudo = ["Ligação realizada", resumo, obs ? `Obs: ${obs}` : null].filter(Boolean).join(" · ");
  if (pendente) {
    await prisma.activity.update({
      where: { id: pendente.id },
      data: {
        conteudo,
        meta: {
          ...((pendente.meta as Record<string, unknown> | null) ?? {}),
          status: "done",
          doneAt: new Date().toISOString(),
          resumo: resumo ?? null,
          observacao: obs ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  } else {
    await prisma.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId: enr.contactId,
        tipo: "call",
        direcao: "out",
        conteudo,
        meta: { kind: "manual_call", status: "done", enrollmentId } as Prisma.InputJsonValue,
      }),
    });
  }

  // Avança o fluxo para o nó seguinte da ligação (ou encerra).
  await redirectEnrollment(enrollmentId, node?.nextNodeId ?? null, { nodeId: enr.currentNodeId, round: enr.currentRound });
}
