"use server";

import { mensagemParaTela } from "@/lib/erros";
import { acaoDaTela } from "@/lib/tenant";
import { revalidatePath } from "next/cache";

import {
  addDealNote,
  addStageToEnd,
  assertMediaAllowed,
  assertOwned,
  createDeal,
  createFunnelWithStages,
  deleteDeal,
  deleteFunnel,
  deleteStage,
  duplicateDeal,
  duplicateStage,
  getDealDetail,
  getFunnelBoard,
  listFunnelDeals,
  listFunnelDealsInputSchema,
  moveDeal,
  reorderStages,
  updateStage,
  updateFunnel,
  list as listContacts,
  primaryEmail,
  primaryTelefone,
  signedMediaUrls,
  storageEnabled,
  updateDealValor,
  uploadMedia,
  type DealCardPage,
  type FunnelBoard,
  type ListFunnelDealsInput,
  transferirNegocios,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "funis". */
const runAsUserAction = acaoDaTela("funis");
export type ActionState = { error?: string; ok?: boolean };

/** Exclui um funil (trava se tiver negócios). */
export async function deleteFunnelAction(id: string): Promise<ActionState> {
  try {
    await runAsUserAction(async () => deleteFunnel(id));
    revalidatePath("/funis");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export type DealDetailDTO = {
  id: string;
  valor: string;
  status: string;
  enteredStageAt: string;
  contato: {
    id: string;
    nome: string;
    empresa: string | null;
    telefone: string | null;
    email: string | null;
    status: string;
    interesse: string;
  };
  funil: { id: string; nome: string; codigo: string | null };
  etapa: string;
  historico: {
    id: string;
    tipo: string;
    direcao: string | null;
    conteudo: string | null;
    mediaUrl: string | null;
    mediaMime: string | null;
    at: string;
  }[];
};

/** Detalhe do negócio para o modal do card (serializado p/ o client). */
export async function dealDetailAction(dealId: string): Promise<DealDetailDTO | null> {
  try {
    // Mídias assinadas num request só, dentro do contexto do time (cache por time).
    const { deal, activities, urls } = await runAsUserAction(async () => {
      const detalhe = await getDealDetail(dealId);
      const paths = detalhe.activities.map((a) => a.mediaPath).filter((p): p is string => !!p);
      return { ...detalhe, urls: await signedMediaUrls(paths) };
    });
    return {
      id: deal.id,
      valor: deal.valor.toString(),
      status: deal.status,
      enteredStageAt: deal.enteredStageAt.toISOString(),
      contato: {
        id: deal.contact.id,
        nome: deal.contact.nome,
        empresa: deal.contact.empresa,
        telefone: primaryTelefone(deal.contact.identifiers),
        email: primaryEmail(deal.contact.identifiers),
        status: deal.contact.relacionamentoStatus,
        interesse: deal.contact.interesse,
      },
      funil: { id: deal.stage.funnel.id, nome: deal.stage.funnel.nome, codigo: deal.stage.funnel.codigo },
      etapa: deal.stage.nome,
      historico: activities.map((a) => ({
        id: a.id,
        tipo: a.tipo,
        direcao: a.direcao,
        conteudo: a.conteudo,
        mediaUrl: a.mediaPath ? (urls.get(a.mediaPath) ?? null) : null,
        mediaMime: a.mediaMime,
        at: a.createdAt.toISOString(),
      })),
    };
  } catch {
    return null;
  }
}

/** Cria um funil com etapas padrão OU customizadas (nomes na ordem desejada). */
export async function createFunnelAction(input: {
  nome: string;
  tipo: "pre_vendas" | "vendas" | "follow_up";
  stages?: string[];
}): Promise<ActionState & { id?: string }> {
  const nome = input.nome?.trim();
  if (!nome) return { error: "nome obrigatório" };
  try {
    const funnel = await runAsUserAction(async () =>
      createFunnelWithStages({ nome, tipo: input.tipo, stages: input.stages }),
    );
    revalidatePath("/funis");
    return { ok: true, id: funnel.id };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

// --- Etapas (colunas do kanban) ---------------------------------------------

export async function addStageAction(input: { funnelId: string; nome: string }): Promise<ActionState> {
  const nome = input.nome?.trim();
  if (!nome) return { error: "nome da etapa obrigatório" };
  try {
    await runAsUserAction(async () => addStageToEnd(input.funnelId, nome));
    revalidatePath(`/funis/${input.funnelId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function renameStageAction(input: {
  funnelId: string;
  stageId: string;
  nome: string;
}): Promise<ActionState> {
  const nome = input.nome?.trim();
  if (!nome) return { error: "nome obrigatório" };
  try {
    await runAsUserAction(async () => updateStage(input.stageId, { nome }));
    revalidatePath(`/funis/${input.funnelId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function duplicateStageAction(input: {
  funnelId: string;
  stageId: string;
}): Promise<ActionState> {
  try {
    await runAsUserAction(async () => duplicateStage(input.stageId));
    revalidatePath(`/funis/${input.funnelId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function deleteStageAction(input: {
  funnelId: string;
  stageId: string;
}): Promise<ActionState> {
  try {
    await runAsUserAction(async () => deleteStage(input.stageId));
    revalidatePath(`/funis/${input.funnelId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function reorderStagesAction(input: {
  funnelId: string;
  orderedIds: string[];
}): Promise<ActionState> {
  try {
    await runAsUserAction(async () => reorderStages(input.funnelId, input.orderedIds));
    revalidatePath(`/funis/${input.funnelId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function duplicateDealAction(input: {
  funnelId: string;
  dealId: string;
}): Promise<ActionState> {
  try {
    await runAsUserAction(async () => duplicateDeal(input.dealId));
    revalidatePath(`/funis/${input.funnelId}`);
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function createDealAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  const funnelId = String(formData.get("funnelId"));
  const stageId = String(formData.get("stageId"));
  const contactId = String(formData.get("contactId"));
  const valorStr = formData.get("valor");
  const valor = valorStr ? Number(valorStr) : 0;
  if (!funnelId || !stageId || !contactId) {
    return { error: "selecione contato e etapa" };
  }
  if (Number.isNaN(valor) || valor < 0) {
    return { error: "valor inválido" };
  }
  await runAsUserAction(async () => await createDeal({ funnelId, stageId, contactId, valor }));
  revalidatePath(`/funis/${funnelId}`);
  return { ok: true };
}

/** Chamado do client (onDragEnd). Server action aceita args plain. */
export async function moveDealAction(dealId: string, toStageId: string): Promise<ActionState> {
  await runAsUserAction(async () => await moveDeal(dealId, toStageId));
  revalidatePath("/funis/[id]", "page");
  return { ok: true };
}

/** Edita o card: valor e/ou etapa. Ambos registram no histórico do contato. */
export async function updateDealAction(
  dealId: string,
  input: { valor?: number; stageId?: string },
): Promise<ActionState> {
  if (input.valor !== undefined && (Number.isNaN(input.valor) || input.valor < 0)) {
    return { error: "valor inválido" };
  }
  try {
    await runAsUserAction(async () => {
      if (input.stageId) await moveDeal(dealId, input.stageId);
      if (input.valor !== undefined) await updateDealValor(dealId, input.valor);
    });
    revalidatePath("/funis/[id]", "page");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function deleteDealAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  const dealId = String(formData.get("dealId"));
  const funnelId = String(formData.get("funnelId"));
  try {
    await runAsUserAction(async () => await deleteDeal(dealId));
  } catch (e) {
    // F3: o negócio de outro vendedor não é encontrado (e não some).
    return { error: e instanceof Error && e.name === "OwnedNotFound" ? "Negócio não encontrado." : mensagemParaTela(e) };
  }
  revalidatePath(`/funis/${funnelId}`);
  return { ok: true };
}

/** Transfere um negócio para outra pessoa ativa da equipe (F3d — só o administrador). */
export async function transferirNegocioAction(funnelId: string, dealId: string, para: string): Promise<ActionState> {
  try {
    await runAsUserAction(() => transferirNegocios([dealId], para));
    revalidatePath(`/funis/${funnelId}`);
    return { ok: true };
  } catch (e) {
    const nome = e instanceof Error ? e.name : "";
    if (nome === "ForbiddenError") return { error: "Só o administrador transfere negócios." };
    if (nome === "DestinoDaTransferenciaInvalido") return { error: "Escolha uma pessoa ativa da equipe." };
    return { error: mensagemParaTela(e) };
  }
}

/** Busca contatos (match PARCIAL no nome) pro seletor de "novo negócio". */
export type DealContactItem = { id: string; nome: string; email: string | null; telefone: string | null };

export async function searchDealContactsAction(search: string): Promise<DealContactItem[]> {
  return runAsUserAction(async () => {
    const { items } = await listContacts({ search: search.trim() || undefined, limit: 20 });
    return items.map((c) => ({
      id: c.id,
      nome: c.nome,
      email: primaryEmail(c.identifiers),
      telefone: primaryTelefone(c.identifiers),
    }));
  });
}

/** Renomeia um funil (edição do funil na listagem). */
export async function renameFunnelAction(id: string, nome: string): Promise<ActionState> {
  const n = nome.trim();
  if (!n) return { error: "nome obrigatório" };
  try {
    await runAsUserAction(async () => updateFunnel(id, { nome: n }));
    revalidatePath("/funis");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Adiciona uma nota de texto no feedback do negócio (entra no histórico do contato). */
export async function addDealNoteAction(dealId: string, conteudo: string): Promise<ActionState> {
  if (!conteudo.trim()) return { error: "nota vazia" };
  try {
    await runAsUserAction(async () => addDealNote(dealId, { conteudo }));
    revalidatePath("/funis");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * Anexa mídia (imagem/áudio/documento) no feedback do negócio.
 *
 * Ordem importa (S10): sessão → posse do negócio → tipo/tamanho → só então sobe
 * pro Storage. Antes o upload vinha ANTES da sessão: dava para subir arquivo
 * anônimo com a service-role e em pasta de negócio de qualquer time.
 */
export async function sendDealMediaAction(formData: FormData): Promise<ActionState> {
  const dealId = String(formData.get("dealId") ?? "");
  const conteudo = String(formData.get("conteudo") ?? "");
  const file = formData.get("file");
  if (!dealId) return { error: "negócio inválido" };
  if (!(file instanceof File) || file.size === 0) return { error: "arquivo vazio" };
  if (!storageEnabled()) return { error: "armazenamento de mídia não configurado" };
  try {
    await runAsUserAction(async () => {
      await assertOwned("deal", dealId);
      const mime = file.type || "application/octet-stream";
      assertMediaAllowed(mime, file.size);
      const ext = (file.name.includes(".") ? file.name.split(".").pop()! : mime.split("/")[1] || "bin")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 5) || "bin";
      const path = `deals/${dealId}/${crypto.randomUUID()}.${ext}`;
      await uploadMedia(path, new Uint8Array(await file.arrayBuffer()), mime);
      await addDealNote(dealId, { conteudo, mediaPath: path, mediaMime: mime });
    });
    revalidatePath("/funis");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * Kanban paginado (item 2.4, DP-12): etapas com os primeiros 50 deals ABERTOS,
 * `total`/`valor` por etapa e o resumo de ganhos/perdidos. Já serializado.
 */
export async function funnelBoardAction(funnelId: string): Promise<FunnelBoard> {
  return runAsUserAction(async () => getFunnelBoard(funnelId));
}

/**
 * "Carregar mais" de uma etapa (`stageId` + `cursor` = `nextCursor` da etapa)
 * ou a coluna recolhida de ganhos/perdidos (`status: "won" | "lost"`).
 */
export async function listFunnelDealsAction(funnelId: string, input: ListFunnelDealsInput = {}): Promise<DealCardPage> {
  const filtros = listFunnelDealsInputSchema.parse(input);
  return runAsUserAction(async () => listFunnelDeals(funnelId, filtros));
}
