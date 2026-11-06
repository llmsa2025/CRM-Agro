import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { safeEnrollByTrigger } from "../flows/triggers";
import { applyCursor, buildResult, type CursorPaginationResult } from "../shared/pagination";
import { DealNotFound, FunnelNotFound, StageNotFound, StageNotEmpty, FunnelNotEmpty } from "./errors";
import { gerarCodigo } from "./codigo";
import { assertOwned, OwnedNotFound } from "../tenancy/assert-owned";
import type { DealCreate, FunnelCreate, FunnelUpdate, StageCreate, StageUpdate } from "./schema";
import { requireCan } from "../auth/authz";
import { dealsAbertosPorEtapa } from "./stats";

import { donoPadrao } from "../tenancy/escopo";
import { escopoNegocio } from "./escopo";
/**
 * Serviços de funis/deals. Puros (só @crmagro/db). Chamam `db()` no início de
 * cada função (leitura eager do teamId — ver @crmagro/db/client).
 *
 * `moveDeal` é o coração do funil: ao trocar de etapa, atualiza o deal e cria
 * uma Activity de stage_change com { de, para } no meta (§12). Em Fase 2 o
 * evento é só a Activity (bus cross-processo é Fase 3).
 */

type FunnelWithStages = Prisma.FunnelGetPayload<{ include: { stages: true } }>;

/**
 * Lista funis do time (com etapas ordenadas) com paginação cursor-based
 * (§paginação). `cursor` precede `offset`; sem ambos, primeira página. `orderBy`
 * termina em `id` (desempate estável do cursor).
 */
export async function listFunnels(
  opts: { cursor?: string; limit?: number; offset?: number } = {},
): Promise<CursorPaginationResult<FunnelWithStages>> {
  const prisma = db();
  const { cursor, limit = 50, offset = 0 } = opts;
  const rows = await prisma.funnel.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { stages: { orderBy: { ordem: "asc" } } },
    ...(cursor ? applyCursor({ cursor, limit }) : { take: limit + 1, skip: offset }),
  });
  return buildResult(rows, limit);
}

/**
 * Funis com deals (para a tabela de funis: count + valor total por funil).
 *
 * @deprecated Traz TODOS os deals abertos só para a tela contar e somar (DP-07).
 * Use `listFunnelsResumo()` (count/valor já agregados no banco). Fica até o
 * front trocar a chamada (funis/page.tsx, ligacoes/page.tsx).
 */
export async function listFunnelsWithStats() {
  const prisma = db();
  return prisma.funnel.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      stages: {
        orderBy: { ordem: "asc" },
        // F3: só os negócios do escopo de quem pede.
        include: { deals: { where: { AND: [{ status: "open" }, escopoNegocio()] }, select: { valor: true } } },
      },
    },
  });
}

export type FunnelResumo = Awaited<ReturnType<typeof listFunnelsResumo>>[number];

/**
 * Funis do time com as etapas e os deals ABERTOS já agregados no banco
 * (`groupBy` por etapa — item 2.3, DP-07): `count`/`valor` por etapa e
 * `total`/`valor` por funil. Substitui `listFunnelsWithStats`.
 */
export async function listFunnelsResumo() {
  const prisma = db();
  const [funis, porEtapa] = await Promise.all([
    prisma.funnel.findMany({
      orderBy: { createdAt: "asc" },
      include: { stages: { orderBy: { ordem: "asc" } } },
    }),
    dealsAbertosPorEtapa(prisma),
  ]);
  return funis.map((f) => {
    const stages = f.stages.map((s) => ({ ...s, ...(porEtapa.get(s.id) ?? { count: 0, valor: 0 }) }));
    return {
      ...f,
      stages,
      total: stages.reduce((acc, s) => acc + s.count, 0),
      valor: stages.reduce((acc, s) => acc + s.valor, 0),
    };
  });
}

/** Deals de um contato (aba Negócios no detalhe do contato). */
export async function listDealsByContact(contactId: string) {
  const prisma = db();
  return prisma.deal.findMany({
    where: { AND: [{ contactId }, escopoNegocio()] },
    orderBy: { enteredStageAt: "desc" },
    include: { stage: { include: { funnel: { select: { nome: true } } } } },
  });
}

/**
 * Funil com TODAS as etapas e TODOS os deals (qualquer status).
 *
 * @deprecated Use `getFunnelBoard()` (abertos, 50 por etapa, contagem por
 * `groupBy`) + `listFunnelDeals()` para "carregar mais" (item 2.4, DP-12). Fica
 * até o front trocar a chamada (funis/[id]/page.tsx). Já não traz a linha
 * inteira do contato (com o Json `enrichment`): só `id`, `nome` e `empresa`,
 * que é o que o cartão usa.
 */
export async function getFunnel(id: string) {
  const prisma = db();
  const funnel = await prisma.funnel.findUnique({
    where: { id },
    include: {
      stages: {
        orderBy: { ordem: "asc" },
        // F3: só os negócios do escopo de quem pede.
        include: { deals: { where: escopoNegocio(), include: { contact: { select: { id: true, nome: true, empresa: true } } } } },
      },
    },
  });
  if (!funnel) throw new FunnelNotFound(id);
  return funnel;
}

export async function createFunnel(data: FunnelCreate) {
  requireCan("funnels.write");
  const prisma = db();
  return prisma.funnel.create({
    data: tenantData<Prisma.FunnelUncheckedCreateInput>({
      ...data,
      codigo: data.codigo ?? gerarCodigo(data.nome, "funil"),
    }),
  });
}

/**
 * Cria um funil já com as etapas informadas (tela "novo funil" com colunas
 * customizadas). `stages` na ordem desejada; cada uma ganha `ordem` e `codigo`.
 * Sem `stages`, cai nas etapas padrão.
 */
export async function createFunnelWithStages(data: FunnelCreate & { stages?: string[] }) {
  requireCan("funnels.write");
  const prisma = db();
  const nomes = (data.stages ?? ["Novo", "Em contato", "Proposta", "Fechado"])
    .map((s) => s.trim())
    .filter(Boolean);
  const funnel = await createFunnel({ nome: data.nome, tipo: data.tipo });
  if (nomes.length) {
    await prisma.stage.createMany({
      data: nomes.map((nome, i) =>
        tenantData<Prisma.StageCreateManyInput>({
          funnelId: funnel.id,
          nome,
          ordem: i,
          codigo: gerarCodigo(nome),
        }),
      ),
    });
  }
  return funnel;
}

/** Atualiza campos do funil (nome/tipo). Escopo do time via `db()`. */
export async function updateFunnel(id: string, data: FunnelUpdate) {
  requireCan("funnels.write");
  const prisma = db();
  const existing = await prisma.funnel.findUnique({ where: { id } });
  if (!existing) throw new FunnelNotFound(id);
  return prisma.funnel.update({ where: { id }, data });
}

export async function createStage(data: StageCreate) {
  requireCan("funnels.write");
  const prisma = db();
  // S1: funnelId vem do cliente — prova que o funil é do time antes de gravar.
  await assertOwned("funnel", data.funnelId);
  return prisma.stage.create({
    data: tenantData<Prisma.StageUncheckedCreateInput>({
      ...data,
      codigo: data.codigo ?? gerarCodigo(data.nome),
    }),
  });
}

/**
 * Adiciona uma etapa no FIM do funil (botão "+ etapa" do kanban). Calcula a
 * próxima `ordem` a partir do maior existente (o @@unique([funnelId, ordem])
 * proíbe colisão).
 */
export async function addStageToEnd(funnelId: string, nome: string) {
  requireCan("funnels.write");
  const prisma = db();
  const last = await prisma.stage.findFirst({
    where: { funnelId },
    orderBy: { ordem: "desc" },
    select: { ordem: true },
  });
  return createStage({ funnelId, nome, ordem: (last?.ordem ?? -1) + 1 });
}

/** Renomeia / recolore uma etapa (mantém código estável — automações não quebram). */
export async function updateStage(id: string, data: StageUpdate) {
  requireCan("funnels.write");
  const prisma = db();
  const existing = await prisma.stage.findUnique({ where: { id } });
  if (!existing) throw new StageNotFound(id);
  return prisma.stage.update({
    where: { id },
    data: { nome: data.nome, cor: data.cor },
  });
}

/**
 * Duplica uma etapa (sem os deals): mesmo nome + "(cópia)", novo código, no fim
 * do funil.
 */
export async function duplicateStage(id: string) {
  requireCan("funnels.write");
  const prisma = db();
  const stage = await prisma.stage.findUnique({ where: { id } });
  if (!stage) throw new StageNotFound(id);
  return addStageToEnd(stage.funnelId, `${stage.nome} (cópia)`);
}

/**
 * Exclui uma etapa. Bloqueia se houver deals nela (Deal.stage é onDelete:
 * Restrict) — o operador precisa mover/excluir os cards antes. Erro nomeado.
 */
export async function deleteStage(id: string) {
  requireCan("funnels.write");
  const prisma = db();
  const stage = await prisma.stage.findUnique({
    where: { id },
    include: { _count: { select: { deals: true } } },
  });
  if (!stage) throw new StageNotFound(id);
  if (stage._count.deals > 0) {
    throw new StageNotEmpty(id, stage._count.deals);
  }
  await prisma.stage.delete({ where: { id } });
}

/**
 * Reordena as etapas de um funil conforme a sequência de ids. Faz em duas
 * passadas para não colidir com o @@unique([funnelId, ordem]): primeiro joga
 * todas para ordens temporárias (negativas), depois grava a ordem final.
 */
export async function reorderStages(funnelId: string, orderedIds: string[]) {
  requireCan("funnels.write");
  const prisma = db();
  await prisma.$transaction([
    ...orderedIds.map((id, i) =>
      prisma.stage.updateMany({ where: { id, funnelId }, data: { ordem: -(i + 1) } }),
    ),
    ...orderedIds.map((id, i) =>
      prisma.stage.updateMany({ where: { id, funnelId }, data: { ordem: i } }),
    ),
  ]);
}

/**
 * Detalhe de um negócio para o MODAL do card (dados + histórico). Clicar no card
 * abre o negócio, não o contato. Traz o negócio, o contato, etapa/funil (com
 * código), e a timeline de Activities do contato (feedback/histórico). No futuro
 * entram atividades executadas/agendadas.
 */
export async function getDealDetail(dealId: string) {
  const prisma = db();
  const deal = await prisma.deal.findFirst({
    where: { AND: [{ id: dealId }, escopoNegocio()] },
    include: {
      contact: {
        select: {
          id: true,
          nome: true,
          empresa: true,
          relacionamentoStatus: true,
          interesse: true,
          identifiers: true,
        },
      },
      stage: { include: { funnel: { select: { id: true, nome: true, codigo: true } } } },
    },
  });
  if (!deal) throw new DealNotFound(dealId);
  const activities = await prisma.activity.findMany({
    where: { dealId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      tipo: true,
      direcao: true,
      conteudo: true,
      mediaPath: true,
      mediaMime: true,
      meta: true,
      createdAt: true,
    },
  });
  return { deal, activities };
}

/**
 * Exclui um funil. Trava se houver negócios nele (a FK Deal.stage é
 * onDelete:Restrict — apagar cascataria nas etapas e quebraria). O operador
 * move/exclui os negócios antes. Erro nomeado.
 */
export async function deleteFunnel(id: string) {
  requireCan("funnels.write");
  const prisma = db();
  const funnel = await prisma.funnel.findUnique({ where: { id } });
  if (!funnel) throw new FunnelNotFound(id);
  const deals = await prisma.deal.count({ where: { funnelId: id } });
  if (deals > 0) throw new FunnelNotEmpty(id, deals);
  await prisma.funnel.delete({ where: { id } });
}

export async function createDeal(data: DealCreate) {
  requireCan("deals.write");
  const prisma = db();
  // S1: contactId/funnelId/stageId vêm do cliente e viram FK. Sem esta prova, um
  // Deal do meu time apontava para o contato de outro time e o `include` do
  // kanban/detalhe devolvia os dados dele. A etapa também tem de ser DO funil.
  const [, , etapa] = await Promise.all([
    assertOwned("contact", data.contactId),
    assertOwned("funnel", data.funnelId),
    prisma.stage.findFirst({ where: { id: data.stageId, funnelId: data.funnelId }, select: { id: true } }),
  ]);
  if (!etapa) throw new OwnedNotFound("stage", [data.stageId]);
  // Escopo por dono (F3): o negócio é do dono do contato (ou de quem cria).
  const donoDoContato = (await prisma.contact.findUnique({ where: { id: data.contactId }, select: { ownerId: true } }))?.ownerId;
  const deal = await prisma.deal.create({
    data: tenantData<Prisma.DealUncheckedCreateInput>({ ...data, valor: data.valor ?? 0, ownerId: donoDoContato ?? donoPadrao() }),
  });
  // Primeira linha do feedback do card (também entra no histórico do contato).
  await prisma.activity.create({
    data: tenantData<Prisma.ActivityUncheckedCreateInput>({
      contactId: data.contactId,
      dealId: deal.id,
      tipo: "note",
      direcao: "out",
      conteudo: "Negócio criado",
    }),
  });
  return deal;
}

/**
 * Garante que o contato tenha UM negócio ABERTO no funil (deduplicação: 1 negócio
 * aberto por contato+funil). Base do nó "criar card": se já existe, não cria
 * outro (retorna o existente); senão cria na etapa informada.
 */
export async function ensureDeal(
  funnelId: string,
  stageId: string,
  contactId: string,
): Promise<{ deal: Awaited<ReturnType<typeof createDeal>>; created: boolean }> {
  requireCan("deals.write");
  const prisma = db();
  const existing = await prisma.deal.findFirst({ where: { contactId, funnelId, status: "open" } });
  if (existing) return { deal: existing, created: false };
  const deal = await createDeal({ funnelId, stageId, contactId });
  return { deal, created: true };
}

/**
 * Move o negócio ABERTO do contato NO funil para a etapa dada. Só MOVE (não cria)
 * — base do nó "mover etapa" separado do "criar card". Sem negócio no funil,
 * retorna null (o passo é pulado).
 */
export async function moveDealInFunnel(
  contactId: string,
  funnelId: string,
  stageId: string,
  opts: { profundidade?: number } = {},
): Promise<{ moved: boolean }> {
  requireCan("deals.write");
  const prisma = db();
  const deal = await prisma.deal.findFirst({ where: { contactId, funnelId, status: "open" } });
  if (!deal) return { moved: false };
  if (deal.stageId !== stageId) await moveDeal(deal.id, stageId, opts);
  return { moved: true };
}

/**
 * `opts.profundidade` (item 1.4): quando quem move é o MOTOR (nó "mover etapa"),
 * o gatilho stage_changed herda a profundidade da inscrição + 1.
 */
export async function moveDeal(dealId: string, toStageId: string, opts: { profundidade?: number } = {}) {
  requireCan("deals.write");
  const prisma = db();
  const deal = await prisma.deal.findFirst({ where: { AND: [{ id: dealId }, escopoNegocio()] } });
  if (!deal) throw new DealNotFound(dealId);
  await assertOwned("deal", dealId); // escrita: com "Ver de todos" em Funis, lê o do colega mas não altera
  if (deal.stageId === toStageId) return deal; // no-op

  const fromStage = await prisma.stage.findUnique({ where: { id: deal.stageId } });
  const toStage = await prisma.stage.findUnique({ where: { id: toStageId } });
  if (!toStage) throw new StageNotFound(toStageId);

  const [updated] = await prisma.$transaction([
    prisma.deal.update({
      where: { id: dealId },
      data: { stageId: toStageId, enteredStageAt: new Date() },
    }),
    prisma.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId: deal.contactId,
        dealId,
        tipo: "stage_change",
        direcao: "out",
        conteudo: `Etapa: ${fromStage?.nome ?? "?"} → ${toStage.nome}`,
        meta: {
          de: fromStage?.nome ?? null,
          para: toStage.nome,
          dealId,
          fromStageId: deal.stageId,
          toStageId,
        },
      }),
    }),
  ]);

  // Gatilho do motor: mudança de etapa dispara fluxos stage_changed (não-fatal).
  await safeEnrollByTrigger("stage_changed", {
    contactId: deal.contactId,
    dealId,
    funnelId: deal.funnelId,
    fromStageId: deal.stageId,
    toStageId,
    ...(opts.profundidade ? { profundidade: opts.profundidade } : {}),
  });
  return updated;
}

/** Atualiza o valor do negócio (edição do card). Registra no histórico se mudar. */
export async function updateDealValor(dealId: string, valor: number) {
  requireCan("deals.write");
  const prisma = db();
  const deal = await prisma.deal.findFirst({ where: { AND: [{ id: dealId }, escopoNegocio()] } });
  if (!deal) throw new DealNotFound(dealId);
  await assertOwned("deal", dealId); // escrita: com "Ver de todos" em Funis, lê o do colega mas não altera
  const anterior = Number(deal.valor);
  if (anterior === valor) return deal;
  const [updated] = await prisma.$transaction([
    prisma.deal.update({ where: { id: dealId }, data: { valor } }),
    prisma.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId: deal.contactId,
        dealId,
        tipo: "note",
        direcao: "out",
        conteudo: `Valor: ${anterior.toLocaleString("pt-BR")} → ${valor.toLocaleString("pt-BR")}`,
      }),
    }),
  ]);
  return updated;
}

export async function deleteDeal(dealId: string) {
  requireCan("deals.write");
  const prisma = db();
  await assertOwned("deal", dealId); // F3: só o negócio do escopo (o de outro vendedor, não)
  await prisma.deal.delete({ where: { id: dealId } });
}

/** Duplica um card/negócio na mesma etapa (mesmo contato e valor). */
export async function duplicateDeal(dealId: string) {
  requireCan("deals.write");
  const prisma = db();
  const deal = await prisma.deal.findFirst({ where: { AND: [{ id: dealId }, escopoNegocio()] } });
  if (!deal) throw new DealNotFound(dealId);
  await assertOwned("deal", dealId); // escrita: com "Ver de todos" em Funis, lê o do colega mas não altera
  return prisma.deal.create({
    data: tenantData<Prisma.DealUncheckedCreateInput>({
      funnelId: deal.funnelId,
      stageId: deal.stageId,
      contactId: deal.contactId,
      valor: deal.valor,
      ownerId: deal.ownerId ?? donoPadrao(),
    }),
  });
}

/**
 * Nota/anexo do FEEDBACK de um negócio. Grava uma Activity com dealId — aparece
 * no feedback do card E no histórico do contato (mesma espinha). Anexo vai em
 * mediaPath/mediaMime (URL assinada na leitura). tipo="note" (o enum de Activity
 * não tem image/audio/doc; o render decide pela mediaMime).
 */
export async function addDealNote(
  dealId: string,
  input: { conteudo?: string; mediaPath?: string; mediaMime?: string },
): Promise<void> {
  requireCan("deals.write");
  const prisma = db();
  const deal = await prisma.deal.findFirst({ where: { AND: [{ id: dealId }, escopoNegocio()] }, select: { contactId: true } });
  if (!deal) throw new DealNotFound(dealId);
  await assertOwned("deal", dealId); // escrita: com "Ver de todos" em Funis, lê o do colega mas não altera
  await prisma.activity.create({
    data: tenantData<Prisma.ActivityUncheckedCreateInput>({
      contactId: deal.contactId,
      dealId,
      tipo: "note",
      direcao: "out",
      conteudo: input.conteudo?.trim() || null,
      mediaPath: input.mediaPath,
      mediaMime: input.mediaMime,
    }),
  });
}
