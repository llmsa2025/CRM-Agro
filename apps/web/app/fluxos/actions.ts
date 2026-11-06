"use server";

import { acaoDaTela } from "@/lib/tenant";
import { mensagemParaTela } from "@/lib/erros";
import { revalidatePath } from "next/cache";

import {
  activateFlow,
  archiveFlow,
  completeManualCall,
  createFlow,
  enroll,
  flowCreateSchema,
  flowUpdateSchema,
  garantirTagPorNome,
  listFlows,
  listTags,
  pauseFlow,
  andamentoDoFluxo,
  retomarSeguradasDoFluxo,
  type AndamentoDoFluxo,
  redirectEnrollment,
  regenerateWebhookToken,
  encerrarInscricoesDoFluxo,
  updateFlow,
  updateFlowSettings,
  deleteFlow,
  definirCompartilhado,
  listSignatures,
  type JanelaEnvio,
  type SignatureDTO,
  type TagWithCount,
} from "@crmagro/core";


/**
 * Texto do erro para a tela. Erro nomeado do core vem como "Nome: frase" (às vezes com "Error: " na frente):
 * a pessoa lê só a frase.
 */
function textoDoErro(e: unknown): string {
  const bruto = e instanceof Error ? (e.message.startsWith(`${e.name}: `) ? e.message.slice(e.name.length + 2) : e.message) : String(e);
  return bruto.replace(/^Error: /, "").replace(/^[A-Z][A-Za-z]+: /, "");
}

/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "fluxos". */
const runAsUserAction = acaoDaTela("fluxos");
export type ActionState = { error?: string; ok?: boolean; id?: string };

/** Cria um fluxo (rascunho) com nome, gatilho e horário de envio (sem nós ainda). */
export async function createFlowAction(input: {
  nome: string;
  /** Tipo do fluxo (prospecção ou marketing). Ausente = prospecção. */
  tipo?: string;
  triggerType: string;
  /** Horário de envio escolhido na criação. Ausente = o fluxo segue a empresa. */
  janelaEnvio?: JanelaEnvio;
}): Promise<ActionState> {
  const parsed = flowCreateSchema.safeParse({
    nome: input.nome,
    tipo: input.tipo,
    triggerType: input.triggerType,
    triggerConfig: input.janelaEnvio ? { janelaEnvio: input.janelaEnvio } : undefined,
    nodes: [],
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "input inválido" };
  try {
    const flow = await runAsUserAction(async () => await createFlow(parsed.data));
    revalidatePath("/fluxos");
    return { ok: true, id: flow.id };
  } catch (e) {
    return { error: textoDoErro(e) };
  }
}

/** Salva o grafo (nós) de um fluxo. Recebe os nós serializados pelo builder. */
export async function updateFlowAction(
  flowId: string,
  input: {
    nome?: string;
    triggerType?: string;
    triggerConfig?: Record<string, unknown>;
    nodes: unknown[];
    positions?: Record<string, { x: number; y: number }>;
  },
): Promise<ActionState & { inscritas?: number }> {
  const parsed = flowUpdateSchema.safeParse({
    nome: input.nome,
    triggerType: input.triggerType,
    triggerConfig: input.triggerConfig,
    nodes: input.nodes,
    positions: input.positions,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "grafo inválido" };
  try {
    const salvo = (await runAsUserAction(async () => await updateFlow(flowId, parsed.data))) as { inscritas?: number };
    revalidatePath(`/fluxos/${flowId}`);
    revalidatePath("/fluxos");
    return { ok: true, inscritas: salvo.inscritas };
  } catch (e) {
    return { error: textoDoErro(e) };
  }
}

/** Menu ⋯ da lista: edita o nome e o horário de envio, sem mexer nos passos. */
export async function editarFluxoAction(flowId: string, input: { nome: string; janelaEnvio: JanelaEnvio }): Promise<ActionState> {
  try {
    await runAsUserAction(async () => await updateFlowSettings(flowId, { nome: input.nome, janelaEnvio: input.janelaEnvio }));
  } catch (e) {
    return { error: textoDoErro(e) };
  }
  revalidatePath(`/fluxos/${flowId}`);
  revalidatePath("/fluxos");
  return { ok: true };
}

/** Menu ⋯ da lista: exclui o fluxo (e as inscrições e o histórico dele). */
export async function excluirFluxoAction(flowId: string): Promise<ActionState> {
  try {
    await runAsUserAction(async () => await deleteFlow(flowId));
  } catch (e) {
    return { error: textoDoErro(e) };
  }
  revalidatePath("/fluxos");
  return { ok: true };
}

export async function activateFlowAction(flowId: string): Promise<ActionState & { retomadas?: number; inscritas?: number }> {
  let retomadas = 0;
  let inscritas = 0;
  try {
    const r = await runAsUserAction(async () => await activateFlow(flowId));
    retomadas = r.retomadas;
    inscritas = r.inscritas;
  } catch (e) {
    return { error: textoDoErro(e) };
  }
  revalidatePath(`/fluxos/${flowId}`);
  revalidatePath("/fluxos");
  return { ok: true, retomadas, inscritas };
}

/** Pausar: cada inscrição em andamento fica parada no passo em que está e continua dali quando o fluxo for ativado. */
export async function pauseFlowAction(flowId: string): Promise<ActionState & { seguradas?: number }> {
  let seguradas = 0;
  try {
    seguradas = (await runAsUserAction(async () => await pauseFlow(flowId))).seguradas;
  } catch (e) {
    return { error: textoDoErro(e) };
  }
  revalidatePath(`/fluxos/${flowId}`);
  revalidatePath("/fluxos");
  return { ok: true, seguradas };
}

/**
 * Botão "Retomar as seguradas" do andamento do fluxo: devolve ao passo em que pararam as inscrições seguradas pela
 * pausa (o fluxo precisa estar no ar). Lotes, ordem de entrada e idempotência no core.
 */
export async function retomarSeguradasAction(flowId: string): Promise<ActionState & { retomadas?: number }> {
  try {
    const r = await runAsUserAction(async () => await retomarSeguradasDoFluxo(flowId));
    revalidatePath(`/fluxos/${flowId}`);
    return { ok: true, retomadas: r.retomadas };
  } catch (e) {
    if (e instanceof Error && e.name === "FlowNotActive") return { error: "Ative o fluxo antes de retomar as seguradas." };
    return { error: textoDoErro(e) };
  }
}

/** Andamento por estado, lido de novo pela tela enquanto o fluxo anda (só leitura). */
export async function andamentoDoFluxoAction(flowId: string): Promise<ActionState & { andamento?: AndamentoDoFluxo }> {
  try {
    return { ok: true, andamento: await runAsUserAction(async () => await andamentoDoFluxo(flowId)) };
  } catch (e) {
    return { error: textoDoErro(e) };
  }
}

export async function archiveFlowAction(flowId: string): Promise<ActionState> {
  try {
    await runAsUserAction(async () => await archiveFlow(flowId));
  } catch (e) {
    return { error: String(e) };
  }
  revalidatePath("/fluxos");
  return { ok: true };
}

/**
 * Gera a URL do webhook do fluxo (a primeira vez) ou uma NOVA (S5): a anterior para de funcionar na hora e
 * quem integrou precisa atualizar. É a única vez que o token sai do servidor: o banco guarda só o hash
 * (com a chave FLOW_WEBHOOK_TOKEN_HASH ligada), então a tela mostra o token agora e não consegue mostrar
 * de novo. O token não vai para log nem para `revalidatePath`.
 */
export async function regenerateWebhookTokenAction(
  flowId: string,
): Promise<ActionState & { webhookToken?: string; geradoEm?: string }> {
  try {
    const { webhookToken, geradoEm } = await runAsUserAction(async () => regenerateWebhookToken(flowId));
    revalidatePath(`/fluxos/${flowId}`);
    return { ok: true, webhookToken, geradoEm: geradoEm.toISOString() };
  } catch (e) {
    return { error: textoDoErro(e) };
  }
}

/**
 * Botão "parar tudo" (item 1.5): encerra todas as inscrições em curso do fluxo.
 * Pausar só segura; isto encerra de vez.
 */
export async function encerrarInscricoesAction(flowId: string): Promise<ActionState & { encerradas?: number }> {
  try {
    const { encerradas } = await runAsUserAction(async () => encerrarInscricoesDoFluxo(flowId));
    revalidatePath(`/fluxos/${flowId}`);
    return { ok: true, encerradas };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Inscrição manual / teste: enrrola um contato num fluxo ativo. */
export async function enrollTestContactAction(
  flowId: string,
  contactId: string,
): Promise<ActionState> {
  if (!contactId) return { error: "selecione um contato" };
  try {
    await runAsUserAction(async () => await enroll(contactId, flowId));
  } catch (e) {
    // Contato que já está no fluxo (um teste anterior parado): o caminho é pausar e ativar, que continua de onde parou.
    if (e instanceof Error && e.name === "ContatoJaNoFluxo") {
      return { error: "Este contato já está percorrendo o fluxo. Se ele ficou parado, clique em Pausar e depois em Ativar: o fluxo continua de onde parou." };
    }
    return { error: textoDoErro(e) };
  }
  revalidatePath(`/fluxos/${flowId}`);
  return { ok: true };
}

/** Lista fluxos (server component helper). */
export async function loadFlows() {
  return runAsUserAction(async () => await listFlows());
}

/** Devolve um enrollment travado/falhado ao fluxo a partir de um nó ("definir destino"). */
export async function redirectEnrollmentAction(
  flowId: string,
  enrollmentId: string,
  toNodeId: string | null,
): Promise<ActionState> {
  try {
    await runAsUserAction(async () => await redirectEnrollment(enrollmentId, toNodeId));
    revalidatePath(`/fluxos/${flowId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Marca a ligação manual pendente como feita (resumo + observação) e avança o fluxo. */
export async function completeManualCallAction(
  flowId: string,
  enrollmentId: string,
  input: { resumo?: string; observacao?: string },
): Promise<ActionState> {
  try {
    await runAsUserAction(async () => await completeManualCall(enrollmentId, input));
    revalidatePath(`/fluxos/${flowId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Lista fluxos (id + nome) para o seletor do passo "Mudar de fluxo". */
export async function listFlowsForSwitchAction(): Promise<{ id: string; nome: string }[]> {
  return runAsUserAction(async () => {
    // Trocar de fluxo leva o CONTATO para outro fluxo: só os de prospecção recebem contato.
    const { items } = await listFlows({ limit: 100, tipo: "prospeccao" });
    return items.map((f) => ({ id: f.id, nome: f.nome }));
  });
}

/** "Compartilhar com o time" / "Só o dono" de um fluxo (F4): o dono ou o administrador. */
export async function compartilharFluxoAction(id: string, compartilhado: boolean): Promise<{ ok?: boolean; error?: string }> {
  try {
    await runAsUserAction(() => definirCompartilhado("flow", id, compartilhado));
    revalidatePath("/fluxos");
    return { ok: true };
  } catch (e) {
    const n = e instanceof Error ? e.name : "";
    if (n === "SoODonoCompartilha") return { error: "Só quem criou (ou o administrador) muda o compartilhamento." };
    if (n === "ForbiddenError") return { error: "Acesso negado" };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Assinaturas para o passo "Enviar e-mail" (por caixa, 28/09): as de todas as
 * caixas que a pessoa vê, com o nome da caixa. No envio vale a da caixa que
 * enviar (a escolhida, se for dela; senão a padrão dela).
 */
export async function listAssinaturasParaFluxoAction(): Promise<SignatureDTO[]> {
  return runAsUserAction(async () => listSignatures());
}

/**
 * Seletor de tag do editor (gatilho "Tag adicionada", passo "Adicionar tag" e condição "Tem tag"). É o MESMO catálogo
 * de Contatos: listar mostra as tags do time e criar põe a tag nova lá, onde todas as telas a enxergam. Escrever tag é da
 * tela Contatos (`tags.write`), então quem tem a tela Fluxos recebe esse acesso só nestas duas actions.
 */
const runAsUserActionTags = acaoDaTela("fluxos", { tambem: ["contatos"] });

/** As tags do time, com quantos contatos têm cada uma. */
export async function tagsDoCatalogoAction(): Promise<TagWithCount[]> {
  return runAsUserActionTags(async () => listTags());
}

/** Cria a tag no catálogo do time ou devolve a que já tem esse nome (sem olhar acento nem maiúscula). */
export async function garantirTagDoCatalogoAction(nome: string): Promise<{ error?: string; tag?: { id: string; nome: string } }> {
  try {
    const tag = await runAsUserActionTags(async () => garantirTagPorNome(nome));
    revalidatePath("/contatos");
    return { tag: { id: tag.id, nome: tag.nome } };
  } catch (e) {
    return { error: mensagemParaTela(e, { semPrefixo: true }) };
  }
}
