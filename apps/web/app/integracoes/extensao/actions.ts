"use server";

import { mensagemParaTela } from "@/lib/erros";
import { acaoDaTela } from "@/lib/tenant";
import { currentUser } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import {
  createRelayToken,
  listRelayTokens,
  revokeRelayToken,
  type RelayTokenDTO,
  type CreatedRelayToken,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". */
const runAsUserAction = acaoDaTela("integracoes");
export type ActionState = { error?: string; ok?: boolean };

/** Gera um novo token de relay. Retorna o TEXTO PURO p/ exibir UMA vez. */
export async function createRelayTokenAction(
  label: string,
): Promise<ActionState & { token?: CreatedRelayToken }> {
  try {
    const user = await currentUser();
    const token = await runAsUserAction(async () =>
      createRelayToken({ label, ...(user?.id ? { userId: user.id } : {}) }),
    );
    revalidatePath("/integracoes/extensao");
    return { ok: true, token };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Lista mascarada dos tokens do time. */
export async function listRelayTokensAction(): Promise<RelayTokenDTO[]> {
  try {
    return await runAsUserAction(async () => listRelayTokens());
  } catch {
    return [];
  }
}

/** Revoga um token pelo id. */
export async function revokeRelayTokenAction(id: string): Promise<ActionState> {
  try {
    await runAsUserAction(async () => revokeRelayToken(id));
    revalidatePath("/integracoes/extensao");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
