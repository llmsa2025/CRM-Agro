"use server";

import { acaoDaTela } from "@/lib/tenant";
import { mensagemParaTela } from "@/lib/erros";
import { revalidatePath } from "next/cache";
import {
  createManualCall,
  finishManualCall,
  listDealOptionsForContact,
  listPendingCalls,
  listContactsForCalls,
  listCallActivities,
  type CallContactListItem,
  ligarPelaVoopi,
  desligarPelaVoopi,
  statusVoopi,
  type FinalizacaoDaLigacao,
  type FinishManualCallInput,
  type LigarPelaVoopiInput,
  type LigacaoVoopi,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "ligacoes". */
const runAsUserAction = acaoDaTela("ligacoes");
export type ActionState = { error?: string; ok?: boolean };

/**
 * Cria uma ligação manual (discador pop-up). Retorna o callId + contactId
 * resolvido (auto-vincula pelo número, ou cria um contato mínimo se for avulso).
 */
export async function createManualCallAction(
  phoneNumber: string,
  contactId?: string,
): Promise<ActionState & { callId?: string; contactId?: string | null; contactNome?: string | null }> {
  try {
    const res = await runAsUserAction(async () =>
      createManualCall({ phoneNumber, contactId }),
    );
    revalidatePath("/ligacoes");
    return { ok: true, ...res };
  } catch (e) {
    // Número de um contato de outro responsável: "já cadastrado com o responsável X".
    return { error: mensagemParaTela(e) };
  }
}

/**
 * Finaliza a ligação manual: outcome + duração + anotações + vínculo a
 * negócio/etapa (opcional). Grava no histórico do contato (Activity call).
 * Caixa postal devolve o retorno marcado na Agenda; número errado, quantos
 * números do contato ficaram inválidos (produto §D).
 */
export async function finishManualCallAction(
  callId: string,
  input: FinishManualCallInput,
): Promise<ActionState & Partial<FinalizacaoDaLigacao>> {
  try {
    const res = await runAsUserAction(async () => finishManualCall(callId, input));
    revalidatePath("/ligacoes");
    return { ok: true, ...res };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * "Ligar pela Voopi" (click-to-call): `{ contactId, phoneNumber? }` ou
 * `{ callId }` (a ligação do discador). `codigo: "voopi_nao_configurada"` →
 * a tela abre o discador manual (`createManualCallAction`) no lugar;
 * `"pediu_para_sair"` → pedir confirmação e repetir com `confirmarOptOut: true`.
 */
export async function ligarPelaVoopiAction(
  input: LigarPelaVoopiInput,
): Promise<
  ActionState &
    Partial<LigacaoVoopi> & { codigo?: "voopi_nao_configurada" | "sem_telefone" | "voopi_falhou" | "pediu_para_sair" }
> {
  try {
    const res = await runAsUserAction(async () => ligarPelaVoopi(input));
    revalidatePath("/ligacoes");
    return { ok: true, ...res };
  } catch (e) {
    const nome = e instanceof Error ? e.name : "";
    const codigo =
      nome === "VoopiNaoConfigurada"
        ? "voopi_nao_configurada"
        : nome === "ContatoSemTelefoneValido"
          ? "sem_telefone"
          : nome === "VoopiFalhou"
            ? "voopi_falhou"
            : nome === "ContatoPediuParaSair"
              ? "pediu_para_sair"
              : undefined;
    return { error: mensagemParaTela(e), ...(codigo ? { codigo } : {}) };
  }
}

/** Desliga uma ligação da Voopi em curso. */
export async function desligarPelaVoopiAction(callId: string): Promise<ActionState> {
  try {
    await runAsUserAction(async () => desligarPelaVoopi(callId));
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** A Voopi está pronta? (mostrar "Ligar pela Voopi" ou só o discador manual). */
export async function voopiProntaAction(): Promise<{ pronta: boolean; falta: string[] }> {
  const s = await runAsUserAction(async () => statusVoopi());
  return { pronta: s.pronta, falta: s.falta };
}

/** Negócios abertos do contato + funis/etapas do time (seletor do pop-up). */
export async function loadDealOptionsAction(
  contactId: string,
): Promise<ActionState & { deals?: Awaited<ReturnType<typeof listDealOptionsForContact>>["deals"]; funnels?: Awaited<ReturnType<typeof listDealOptionsForContact>>["funnels"] }> {
  try {
    const res = await runAsUserAction(async () => listDealOptionsForContact(contactId));
    return { ok: true, deals: res.deals, funnels: res.funnels };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Pendências da aba Atividades (calls scheduled + manual_call pendentes). */
export async function loadPendingCallsAction() {
  return runAsUserAction(async () => listPendingCalls());
}

/** Contatos com telefone (aba Contatos) com busca. */
export async function loadCallContactsAction(
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ items: CallContactListItem[]; total: number }> {
  return runAsUserAction(async () => listContactsForCalls(opts));
}

/** Histórico de ligações (aba Ligações). */
export async function loadCallActivitiesAction(
  opts: { from?: Date; to?: Date; cursor?: string; limit?: number } = {},
) {
  return runAsUserAction(async () => listCallActivities(opts));
}
