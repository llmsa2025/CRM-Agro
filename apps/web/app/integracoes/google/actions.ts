"use server";

import { mensagemParaTela } from "@/lib/erros";
import { revalidatePath } from "next/cache";
import { desconectarGoogle, pedirSincronizacaoGoogle } from "@crmagro/core";
import { acaoDaTela } from "@/lib/tenant";

/**
 * "Minha Agenda Google" na tela Integrações. A conexão é da PRÓPRIA pessoa
 * (decisão 3): o core exige papel de membro e a tela Agenda OU Integrações —
 * quem abre esta tela tem Integrações.
 */
const runAsUserAction = acaoDaTela("integracoes");

export type AcaoGoogleState = { ok?: boolean; error?: string };

export async function desconectarGoogleAction(): Promise<AcaoGoogleState> {
  try {
    await runAsUserAction(async () => desconectarGoogle());
    revalidatePath("/integracoes");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function sincronizarGoogleAction(): Promise<AcaoGoogleState> {
  try {
    const r = await runAsUserAction(async () => pedirSincronizacaoGoogle());
    return r.pedido ? { ok: true } : { error: "A agenda não está conectada." };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
