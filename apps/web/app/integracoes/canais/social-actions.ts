"use server";

import { mensagemParaTela } from "@/lib/erros";
import { acaoDaTela } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import { connectSocialAccount, type ConnectSocialInput } from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". */
const runAsUserAction = acaoDaTela("integracoes");
export type SocialState = { ok?: boolean; connected?: boolean; error?: string };

/** Conecta uma conta social (Instagram/LinkedIn) via cookie de sessão + proxy. */
export async function connectSocialAction(input: ConnectSocialInput): Promise<SocialState> {
  if (!input.cookie?.trim()) return { error: "cole o cookie de sessão" };
  try {
    const res = await runAsUserAction(async () => connectSocialAccount(input));
    revalidatePath("/integracoes/canais");
    return { ok: true, connected: res.connected, error: res.connected ? undefined : res.error };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
