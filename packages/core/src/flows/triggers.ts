import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { scheduleStep } from "./queue";
import { MOTIVO_OPT_OUT, PROFUNDIDADE_MAX, podeReinscrever, politicaDeReentrada } from "./limites";
import { SNAPSHOT_VERSION } from "./snapshot";
import { AGENDAR_EM_PARALELO, LOTE_INSCRICAO, criarFreioDeInscricao } from "./pressao";
import { versaoDoFluxo } from "./versao";
import { logger } from "../logger/index";
import type { SnapshotNode, TriggerType } from "./schema";

/**
 * Gatilhos — inscreve contatos em fluxos ativos a partir de eventos de domínio.
 *
 * Roda DENTRO de `runWithTeam(teamId)` (o caller — receiveInbound, contacts.create,
 * moveDeal — já abriu o contexto). Para cada fluxo `active` com o `triggerType`
 * dado, cria um Enrollment (com snapshot) e agenda o primeiro passo.
 *
 * Importado pelos serviços de outros domínios via caminho específico
 * ("../flows/triggers") — não pelo barrel — pra evitar ciclo de módulos
 * (o executor importa de volta de conversations/contacts/funnels).
 */

type FlowWithNodes = Prisma.FlowGetPayload<{ include: { nodes: { orderBy: { createdAt: "asc" } } } }>;

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
 * Nó de entrada do fluxo = o que NINGUÉM aponta (sem edge de entrada).
 *
 * Antes o início era `nodes[0]` por createdAt — a ordem em que os blocos foram
 * ADICIONADOS no builder, não a ordem das conexões. Se o usuário arrastasse
 * "digitando → mensagem" mas tivesse criado a mensagem primeiro, o fluxo começava
 * na mensagem e ignorava o "digitando" ("mandava direto"). Agora derivamos do
 * grafo. Empate/ciclo sem entrada → cai no primeiro por createdAt (nodes[0]).
 */
export function findStartNode<T extends { id: string }>(
  nodes: SnapshotNode[],
  ordered: T[],
  explicitStartId?: string | null,
): T | undefined {
  if (ordered.length === 0) return undefined;
  // Início EXPLÍCITO (o usuário ligou o gatilho a um passo específico no editor,
  // gravado em triggerConfig.startNodeId). Se o nó ainda existe, vence a
  // heurística de topologia. Se sumiu (foi excluído), cai na heurística.
  if (explicitStartId) {
    const explicit = ordered.find((n) => n.id === explicitStartId);
    if (explicit) return explicit;
  }
  const referenced = new Set<string>();
  for (const n of nodes) {
    if (n.tipo === "condition") {
      const br = (n.branches ?? { branches: [], default: null }) as {
        branches?: Array<{ nextNodeId?: string | null; maisDestinos?: string[] }>;
        default?: string | null;
        defaultMais?: string[];
      };
      for (const b of br.branches ?? []) {
        if (b.nextNodeId) referenced.add(b.nextNodeId);
        for (const m of b.maisDestinos ?? []) referenced.add(m);
      }
      if (br.default) referenced.add(br.default);
      for (const m of br.defaultMais ?? []) referenced.add(m);
    } else if (n.tipo === "ab_split") {
      const br = (n.branches ?? { variants: [] }) as { variants?: Array<{ nextNodeId?: string | null }> };
      for (const v of br.variants ?? []) if (v.nextNodeId) referenced.add(v.nextNodeId);
    } else if (n.nextNodeId) {
      referenced.add(n.nextNodeId);
    }
  }
  // Primeiro (na ordem de criação) que não é destino de ninguém.
  return ordered.find((n) => !referenced.has(n.id)) ?? ordered[0];
}

/**
 * Inscreve o contato em todos os fluxos ativos do trigger dado.
 * `payload` carrega contexto extra (conversationId, fromStageId/toStageId...)
 * guardado no triggerConfig no futuro; hoje só usamos contactId.
 */
/**
 * Atraso de jitter (ms) a partir do triggerConfig do fluxo. `jitterMin`/
 * `jitterMax` em MINUTOS. Sorteia um valor em [min, max]; sem config válida → 0.
 */
/** Jitter padrão para inscrição EM LOTE sem jitter configurado (item 1.3). */
export const JITTER_LOTE_PADRAO_MIN = 30;

export function jitterDelayMs(triggerConfig: unknown, emLote = false): number {
  const c = triggerConfig as { jitterMin?: number; jitterMax?: number } | null;
  // Lote (tag em massa, importação) sem jitter configurado: 0–30 min. Antes
  // eram 0 — 500 contatos entravam no mesmo segundo e o 1º envio saía em rajada.
  if (emLote && c?.jitterMin === undefined && c?.jitterMax === undefined) {
    return Math.round(Math.random() * JITTER_LOTE_PADRAO_MIN * 60_000);
  }
  const min = Math.max(0, c?.jitterMin ?? 0);
  const max = Math.max(0, c?.jitterMax ?? 0);
  if (max <= 0) return min > 0 ? min * 60_000 : 0;
  const lo = Math.min(min, max);
  const minutos = lo + Math.random() * (max - lo);
  return Math.round(minutos * 60_000);
}

export async function enrollByTrigger(
  triggerType: TriggerType,
  payload: { contactId: string; [k: string]: unknown },
): Promise<void> {
  const prisma = db();
  // Cascata do próprio motor (item 1.4): acima do limite não inscreve — corta
  // ciclos entre fluxos (mover etapa → outro fluxo move de volta → …).
  const profundidade = Number(payload.profundidade ?? 0);
  if (profundidade > PROFUNDIDADE_MAX) {
    logger.warn({ triggerType, contactId: payload.contactId, profundidade }, "[flows] cascata de gatilhos cortada");
    return;
  }
  const flows = await prisma.flow.findMany({
    where: { triggerType, status: "active" },
    include: { nodes: { orderBy: { createdAt: "asc" } } },
  });
  if (flows.length === 0) return;
  // Opt-out (N12) lido UMA vez (auditoria do #114): antes o `podeReinscrever`
  // relia o contato a cada fluxo casado e repetia o log "reentrada barrada".
  const contato = await prisma.contact.findUnique({
    where: { id: payload.contactId },
    select: { relacionamentoStatus: true },
  });
  if (contato?.relacionamentoStatus === "opt_out") {
    logger.info({ contactId: payload.contactId, triggerType, motivo: MOTIVO_OPT_OUT }, "[flows] gatilho ignorado");
    return;
  }
  for (const flow of flows) {
    if (flow.nodes.length === 0) continue;

    // Gatilho de TAG: só inscreve se a tag configurada no fluxo (triggerConfig
    // .tagId) for a mesma que foi adicionada ao contato. Sem tag configurada, o
    // fluxo não dispara por tag (a trava de ativação impede ativar sem tag).
    if (triggerType === "tag_added") {
      const cfgTag = (flow.triggerConfig as { tagId?: string } | null)?.tagId;
      if (!cfgTag) continue;
      if (payload.tagId && cfgTag !== payload.tagId) continue;
    }

    // Gatilho de ETAPA (item 1.5, MF-09): só a mudança configurada (funil,
    // "entrou em", "saiu de"). Fluxo antigo sem etapa segue sem filtro — mas não
    // é mais possível ATIVAR assim (activateFlow).
    if (triggerType === "stage_changed") {
      const cfg = flow.triggerConfig as { funnelId?: string; toStageId?: string; fromStageId?: string } | null;
      if (cfg?.toStageId && payload.toStageId !== cfg.toStageId) continue;
      if (cfg?.fromStageId && payload.fromStageId !== cfg.fromStageId) continue;
      if (cfg?.funnelId && payload.funnelId !== cfg.funnelId) continue;
    }

    // Trava de duplicidade: não reinscrever quem já está percorrendo este fluxo.
    // Sem isso o gatilho `message_received` vira amplificação — cada resposta
    // cria uma inscrição nova, que envia, que provoca outra resposta. Para um
    // canal de WhatsApp isso é mensagem repetida no cliente e risco de ban.
    const emCurso = await prisma.enrollment.findFirst({
      where: { flowId: flow.id, contactId: payload.contactId, status: { in: ["active", "waiting"] } },
      select: { id: true },
    });
    if (emCurso) {
      logger.debug({ contactId: payload.contactId, flowId: flow.id, enrollmentId: emCurso.id }, "[flows] já está no fluxo — reinscrição ignorada");
      continue;
    }

    // Reentrada e exclusividade (item 1.4, MF-21): cooldown (padrão 24 h no
    // message_received — evita pingue-pongue com resposta automática do outro
    // lado) e "um fluxo exclusivo por vez" por contato.
    const permitido = await podeReinscrever({
      flowId: flow.id,
      contactId: payload.contactId,
      triggerType,
      triggerConfig: flow.triggerConfig,
      relacionamentoStatus: contato?.relacionamentoStatus ?? null,
    });
    if (!permitido.ok) {
      logger.info({ contactId: payload.contactId, flowId: flow.id, motivo: permitido.motivo }, "[flows] reentrada barrada");
      continue;
    }

    const snapshot = toSnapshot(flow);
    const startId = (flow.triggerConfig as { startNodeId?: string } | null)?.startNodeId ?? null;
    const first = findStartNode(snapshot, flow.nodes, startId);
    if (!first) continue;
    // JITTER inicial (controle de ritmo): quando muitos contatos entram de uma vez (ex.:
    // tag aplicada em 500 de uma vez), disparar todos juntos é a rajada que mais
    // denuncia robô. Se o fluxo configurou jitter (mín/máx em minutos), cada
    // inscrição espera um tempo ALEATÓRIO nesse intervalo antes do 1º passo,
    // espalhando o lote. Só no gatilho (não no "Testar" manual).
    const delay = jitterDelayMs(flow.triggerConfig, payload.emLote === true);
    // Grafo congelado numa FlowVersion deduplicada (item 2.7, DP-14): 5 mil
    // inscrições no mesmo grafo apontam para a MESMA linha, sem 5 mil cópias.
    const flowVersionId = await versaoDoFluxo(flow.id, snapshot);
    let enr;
    try {
      enr = await prisma.enrollment.create({
        data: tenantData<Prisma.EnrollmentUncheckedCreateInput>({
          flowId: flow.id,
          contactId: payload.contactId,
          currentNodeId: first.id,
          // Ponteiro completo desde o nascimento (item 0.9): nextRunAt nunca
          // null aqui — senão a varredura não enxergaria a órfã.
          currentRound: 1,
          profundidade,
          status: delay > 0 ? "waiting" : "active",
          nextRunAt: new Date(Date.now() + delay),
          flowVersionId,
          snapshotVersion: SNAPSHOT_VERSION,
        }),
      });
    } catch (e) {
      // Corrida (MF-04): duas mensagens simultâneas do contato passaram juntas
      // pela trava acima. O índice único parcial barra a segunda inscrição.
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") continue;
      throw e;
    }
    await scheduleStep(enr.id, first.id, 1, delay || undefined);
  }
}

/**
 * Wrapper não-fatal: uma falha no motor (Redis fora, fluxo inválido) NÃO deve
 * quebrar a operação de domínio que disparou o gatilho (criar contato, mover
 * deal, receber mensagem). Loga e segue.
 */
export async function safeEnrollByTrigger(
  triggerType: TriggerType,
  payload: { contactId: string; [k: string]: unknown },
): Promise<void> {
  try {
    await enrollByTrigger(triggerType, payload);
  } catch (err) {
    // Item 1.10 (MF-24): no logger estruturado (antes ia para o console, sem
    // contexto, e se perdia no pm2).
    logger.error(
      { triggerType, contactId: payload.contactId, err: err instanceof Error ? err.message : String(err) },
      "[flows] falha ao disparar gatilho — contato NÃO inscrito",
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Inscrição EM LOTE (MF-13)
// ────────────────────────────────────────────────────────────────────────────

// Lote, paralelismo e freio da inscrição em massa: ver `pressao.ts` (incidente de 02/10/2026).

/**
 * O mesmo que chamar `enrollByTrigger(triggerType, { ...payload, contactId })`
 * para cada contato, com as MESMAS travas, mas sem o N+1 (MF-13).
 *
 * Antes, aplicar tag em 10 mil contatos ou importar uma planilha fazia, POR
 * contato, `flow.findMany` (com os nós), `findFirst` de "em curso", as consultas
 * de reentrada, `create` e um `add` no Redis — ~40 mil idas ao banco em série,
 * dentro da requisição web. Aqui, por fluxo e por lote de 100 contatos:
 *   - os fluxos (com os nós) são lidos UMA vez e o snapshot/nó inicial também;
 *   - filtros do gatilho (tag, etapa), profundidade e jitter: iguais;
 *   - "já está no fluxo": 1 `findMany` com `contactId IN (...)`;
 *   - reentrada (`reentry`) e exclusividade (`exclusivo`): 1–2 consultas por
 *     lote, com a mesma regra de `podeReinscrever` (ver `barradosPorReentrada`);
 *   - `createManyAndReturn` com `skipDuplicates`: o índice único parcial
 *     (`Enrollment_um_ativo`) continua barrando a corrida, agora sem derrubar
 *     o lote; `snapshotVersion` igual e a MESMA `FlowVersion` (item 2.7);
 *   - agendamento do 1º passo em paralelo limitado. Falha no Redis não derruba
 *     o resto: a inscrição já tem `nextRunAt` e a varredura de órfãs agenda;
 *   - lotes de 100, com pausa curta entre eles e espera quando a fila `flow` está
 *     cheia (`pressao.ts`): mil contatos de uma vez não afogam o banco, o Redis nem os outros times.
 *
 * Os fluxos são processados um de cada vez, na mesma ordem do caminho unitário:
 * a exclusividade entre dois fluxos `exclusivo` do mesmo gatilho enxerga as
 * inscrições que o fluxo anterior acabou de criar.
 *
 * Roda no contexto do time (`db()`), como `enrollByTrigger`. Devolve quantas
 * inscrições criou.
 */
export async function enrollManyByTrigger(
  triggerType: TriggerType,
  contactIds: readonly string[],
  payload: { [k: string]: unknown } = {},
  /** `soFluxoId`: inscreve só neste fluxo (ao ativar/salvar um fluxo de tag, os outros da mesma tag não são tocados). */
  opts: { soFluxoId?: string } = {},
): Promise<{ inscritas: number }> {
  const prisma = db();
  const unicos = [...new Set(contactIds)];
  if (unicos.length === 0) return { inscritas: 0 };
  const profundidade = Number(payload.profundidade ?? 0);
  if (profundidade > PROFUNDIDADE_MAX) {
    logger.warn({ triggerType, contatos: unicos.length, profundidade }, "[flows] cascata de gatilhos cortada (lote)");
    return { inscritas: 0 };
  }
  const flows = await prisma.flow.findMany({
    where: { triggerType, status: "active", ...(opts.soFluxoId ? { id: opts.soFluxoId } : {}) },
    include: { nodes: { orderBy: { createdAt: "asc" } } },
  });

  let inscritas = 0;
  // Freio por chamada: pausa curta entre os lotes e espera a fila baixar quando está cheia (ver `pressao.ts`).
  const freio = criarFreioDeInscricao();
  for (const flow of flows) {
    if (flow.nodes.length === 0) continue;
    // Mesmos filtros do caminho unitário (o payload vale para o lote inteiro).
    if (triggerType === "tag_added") {
      const cfgTag = (flow.triggerConfig as { tagId?: string } | null)?.tagId;
      if (!cfgTag) continue;
      if (payload.tagId && cfgTag !== payload.tagId) continue;
    }
    if (triggerType === "stage_changed") {
      const cfg = flow.triggerConfig as { funnelId?: string; toStageId?: string; fromStageId?: string } | null;
      if (cfg?.toStageId && payload.toStageId !== cfg.toStageId) continue;
      if (cfg?.fromStageId && payload.fromStageId !== cfg.fromStageId) continue;
      if (cfg?.funnelId && payload.funnelId !== cfg.funnelId) continue;
    }
    const snapshot = toSnapshot(flow);
    const startId = (flow.triggerConfig as { startNodeId?: string } | null)?.startNodeId ?? null;
    const first = findStartNode(snapshot, flow.nodes, startId);
    if (!first) continue;
    // Versão do grafo (item 2.7, DP-14): resolvida UMA vez por fluxo, na 1ª
    // inscrição do lote — as N linhas apontam para ela, sem N cópias do grafo.
    let flowVersionId: string | undefined;

    for (let i = 0; i < unicos.length; i += LOTE_INSCRICAO) {
      if (i > 0) await freio.entreLotes();
      const lote = unicos.slice(i, i + LOTE_INSCRICAO);
      const emCurso = await prisma.enrollment.findMany({
        where: { flowId: flow.id, contactId: { in: lote }, status: { in: ["active", "waiting"] } },
        select: { contactId: true },
      });
      const fora = new Set(emCurso.map((e) => e.contactId));
      const candidatos = lote.filter((c) => !fora.has(c));
      const barrados = await barradosPorReentrada(prisma, flow, triggerType, candidatos);
      if (barrados.size) {
        logger.info({ flowId: flow.id, barrados: barrados.size }, "[flows] lote: reentrada/exclusividade barrou parte dos contatos");
      }
      const liberados = candidatos.filter((c) => !barrados.has(c));
      if (liberados.length === 0) continue;
      flowVersionId ??= await versaoDoFluxo(flow.id, snapshot);
      const versao = flowVersionId;

      const atraso = new Map<string, number>();
      const agora = Date.now();
      const linhas = liberados.map((contactId) => {
        const id = randomUUID();
        const delay = jitterDelayMs(flow.triggerConfig, payload.emLote === true);
        atraso.set(id, delay);
        return tenantData<Prisma.EnrollmentCreateManyInput>({
          id,
          flowId: flow.id,
          contactId,
          currentNodeId: first.id,
          currentRound: 1,
          profundidade,
          status: delay > 0 ? "waiting" : "active",
          nextRunAt: new Date(agora + delay),
          flowVersionId: versao,
          snapshotVersion: SNAPSHOT_VERSION,
        });
      });
      const criadas = await prisma.enrollment.createManyAndReturn({
        data: linhas,
        skipDuplicates: true,
        select: { id: true },
      });
      inscritas += criadas.length;

      let falhas = 0;
      for (let j = 0; j < criadas.length; j += AGENDAR_EM_PARALELO) {
        const r = await Promise.allSettled(
          criadas
            .slice(j, j + AGENDAR_EM_PARALELO)
            .map((e) => scheduleStep(e.id, first.id, 1, atraso.get(e.id) || undefined)),
        );
        falhas += r.filter((x) => x.status === "rejected").length;
      }
      if (falhas) {
        logger.warn(
          { flowId: flow.id, falhas, inscritas: criadas.length },
          "[flows] lote: 1º passo não agendado para parte das inscrições — a varredura de órfãs agenda",
        );
      }
    }
  }
  return { inscritas };
}

/**
 * `podeReinscrever` para um lote de contatos (mesma regra, consultas em lote):
 * política de reentrada pela ÚLTIMA inscrição do contato neste fluxo; fluxo
 * `exclusivo` barra quem está em curso em OUTRO fluxo exclusivo. Devolve os
 * barrados.
 */
async function barradosPorReentrada(
  prisma: ReturnType<typeof db>,
  flow: { id: string; triggerConfig: Prisma.JsonValue },
  triggerType: TriggerType,
  contactIds: string[],
): Promise<Set<string>> {
  const barrados = new Set<string>();
  if (contactIds.length === 0) return barrados;
  // Opt-out (N12): quem pediu para sair não entra em fluxo nenhum.
  for (const c of await prisma.contact.findMany({
    where: { id: { in: contactIds }, relacionamentoStatus: "opt_out" },
    select: { id: true },
  })) {
    barrados.add(c.id);
  }
  const politica = politicaDeReentrada(triggerType, flow.triggerConfig);
  if (politica) {
    const ultimas = await prisma.enrollment.groupBy({
      by: ["contactId"],
      where: { flowId: flow.id, contactId: { in: contactIds }, paiId: null }, // ramos não contam para a reentrada
      _max: { createdAt: true },
    });
    const agora = Date.now();
    for (const u of ultimas) {
      const em = u._max.createdAt;
      if (!em) continue;
      if (politica === "never" || agora - em.getTime() < politica.cooldownHours * 3_600_000) barrados.add(u.contactId);
    }
  }
  if ((flow.triggerConfig as { exclusivo?: unknown } | null)?.exclusivo === true) {
    const outras = await prisma.enrollment.findMany({
      where: {
        contactId: { in: contactIds.filter((c) => !barrados.has(c)) },
        flowId: { not: flow.id },
        status: { in: ["active", "waiting"] },
        flow: { triggerConfig: { path: ["exclusivo"], equals: true } },
      },
      select: { contactId: true },
    });
    for (const o of outras) barrados.add(o.contactId);
  }
  return barrados;
}

/** Versão não-fatal (como `safeEnrollByTrigger`): falha do motor não derruba a operação de domínio. */
export async function safeEnrollManyByTrigger(
  triggerType: TriggerType,
  contactIds: readonly string[],
  payload: { [k: string]: unknown } = {},
): Promise<{ inscritas: number }> {
  try {
    return await enrollManyByTrigger(triggerType, contactIds, payload);
  } catch (err) {
    logger.error(
      { triggerType, contatos: contactIds.length, err: err instanceof Error ? err.message : String(err) },
      "[flows] falha ao disparar gatilho em lote — contatos NÃO inscritos",
    );
    return { inscritas: 0 };
  }
}
