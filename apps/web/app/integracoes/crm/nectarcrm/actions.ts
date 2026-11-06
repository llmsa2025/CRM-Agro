"use server";

import { revalidatePath } from "next/cache";
import {
  removerNectar,
  salvarTokenNectar,
  statusNectar,
  testarConexaoNectar,
  type DiagnosticoConexao,
  type NectarStatusDTO,
} from "@crmagro/core";
import { mensagemDoErroNectar } from "@/lib/nectar/conexao";
import { acaoDaTela, requireRoleAction } from "@/lib/tenant";

/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". */
const runAsUserAction = acaoDaTela("integracoes");

/** O que cada action devolve à tela. A mensagem de erro vem de `mensagemDoErroNectar` (nunca o erro cru). */
export type ResultadoNectar = { ok?: boolean; error?: string; status?: NectarStatusDTO; diagnostico?: DiagnosticoConexao };

/** Estado da conexão (sem o token). Só admin. */
export async function statusNectarAction(): Promise<ResultadoNectar> {
  try {
    await requireRoleAction("admin");
    const status = await runAsUserAction(async () => statusNectar());
    return { ok: true, status };
  } catch (e) {
    return { error: mensagemDoErroNectar(e) };
  }
}

/** Guarda o token (cifrado no serviço) e já testa. O token nunca volta na resposta. */
export async function salvarTokenNectarAction(token: string): Promise<ResultadoNectar> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    const r = await runAsUserAction(async () => salvarTokenNectar({ token }));
    revalidatePath("/integracoes");
    return { ok: true, ...r };
  } catch (e) {
    return { error: mensagemDoErroNectar(e) };
  }
}

/** "Testar de novo": lê os catálogos do Nectar com o token já salvo. */
export async function testarNectarAction(): Promise<ResultadoNectar> {
  try {
    await requireRoleAction("admin");
    const r = await runAsUserAction(async () => testarConexaoNectar());
    revalidatePath("/integracoes");
    return { ok: true, ...r };
  } catch (e) {
    return { error: mensagemDoErroNectar(e) };
  }
}

/** Remove a conexão: o token é apagado do CRM Agro e nada é apagado no Nectar. */
export async function removerNectarAction(): Promise<ResultadoNectar> {
  try {
    await requireRoleAction("admin");
    await runAsUserAction(async () => removerNectar());
    revalidatePath("/integracoes");
    return { ok: true };
  } catch (e) {
    return { error: mensagemDoErroNectar(e) };
  }
}
