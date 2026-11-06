"use server";

import { mensagemParaTela } from "@/lib/erros";
import { requireRoleAction, acaoDaTela } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import {
  saveAiIntegration,
  deleteAiIntegration,
  setAiMode,
  type AiProvider,
  type AiMode,
  type MotivoDaChave,
} from "@crmagro/core";

/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". */
const runAsUserAction = acaoDaTela("integracoes");
export type ActionState = { error?: string; ok?: boolean; connected?: boolean; motivo?: MotivoDaChave };

/** Conecta/atualiza a chave de um provedor de IA (testa + cifra no serviço). */
export async function saveAiIntegrationAction(
  provider: AiProvider,
  apiKey: string,
): Promise<ActionState> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    const res = await runAsUserAction(async () => saveAiIntegration({ provider, apiKey }));
    revalidatePath("/integracoes/ia");
    return { ok: true, connected: res.connected, motivo: res.motivo };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Remove a integração de IA de um provedor. */
export async function deleteAiIntegrationAction(provider: AiProvider): Promise<ActionState> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    await runAsUserAction(async () => deleteAiIntegration(provider));
    revalidatePath("/integracoes/ia");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Define o modo de governança da IA (off / read_only / read_write). */
export async function setAiModeAction(mode: AiMode): Promise<ActionState> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    await runAsUserAction(async () => setAiMode(mode));
    revalidatePath("/integracoes/ia");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
