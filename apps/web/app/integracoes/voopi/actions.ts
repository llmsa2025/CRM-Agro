"use server";

import { mensagemParaTela } from "@/lib/erros";
import { requireRoleAction, acaoDaTela } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import { salvarVoopi, removerVoopi, statusVoopi, type SalvarVoopiInput, type VoopiStatusDTO } from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". */
const runAsUserAction = acaoDaTela("integracoes");
export type ActionState = { error?: string; ok?: boolean };

/**
 * Estado da integração Voopi (sem a senha) — tela de Integrações, só admin.
 * Os outros papéis usam `voopiProntaAction` (ligacoes/actions.ts): `{ pronta, falta }`.
 */
export async function statusVoopiAction(): Promise<VoopiStatusDTO> {
  await requireRoleAction("admin");
  return runAsUserAction(async () => statusVoopi());
}

/**
 * Cadastra/atualiza a conta SIP da Voopi do time (cifrada no serviço). Senha
 * vazia ao editar mantém a salva. Não liga para testar.
 */
export async function salvarVoopiAction(input: SalvarVoopiInput): Promise<ActionState & { status?: VoopiStatusDTO }> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    const status = await runAsUserAction(async () => salvarVoopi(input));
    revalidatePath("/integracoes");
    return { ok: true, status };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Remove a conta da Voopi (as ligações voltam a ser só manuais). */
export async function removerVoopiAction(): Promise<ActionState> {
  try {
    await requireRoleAction("admin");
    await runAsUserAction(async () => removerVoopi());
    revalidatePath("/integracoes");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
