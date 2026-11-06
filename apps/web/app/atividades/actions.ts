"use server";

import { mensagemParaTela } from "@/lib/erros";
import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@crmagro/db";
import { listaDoDia, markTaskDone, undoTaskDone, type ListaDoDiaComFeitas } from "@crmagro/core";
import { acaoDaTela } from "@/lib/tenant";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "painel". */
const runAsUserAction = acaoDaTela("painel");
/**
 * Tarefas do dia com estado "feita" (produto §F). O usuário vem SEMPRE da
 * sessão (`runAsUserAction` desce o `userId` ao contexto); o cliente só manda a
 * `chave` do item, que o core valida.
 */

/** Pendentes + feitas hoje do usuário da sessão. */
export async function listaDoDiaAction(): Promise<ListaDoDiaComFeitas> {
  return runAsUserAction(async () => listaDoDia({ userId: getCurrentUserId() ?? "" }));
}

export type TarefaState = { ok?: boolean; error?: string };

function revalidarTelas() {
  revalidatePath("/atividades");
  revalidatePath("/");
}

export async function markTaskDoneAction(chave: string): Promise<TarefaState> {
  try {
    await runAsUserAction(async () => markTaskDone(chave));
    revalidarTelas();
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function undoTaskDoneAction(chave: string): Promise<TarefaState> {
  try {
    await runAsUserAction(async () => undoTaskDone(chave));
    revalidarTelas();
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
