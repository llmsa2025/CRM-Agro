"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { desconectarLinkedin } from "@crmagro/core";
import { acaoDaTela } from "@/lib/tenant";
import { mensagemDoErroDoLinkedin } from "./linkedin";

/**
 * Desconectar o LinkedIn oficial. Sem `requireRoleAction("admin")` de propósito: o dono da conta (membro)
 * também pode, e quem decide é o core (`desconectarLinkedin`: dono da conta ou administrador). A tela
 * "integracoes" é conferida aqui, como nas outras actions de Integrações.
 *
 * O erro nunca sobe cru para a tela: só o NOME do erro vira um texto fixo.
 */
const runAsUserAction = acaoDaTela("integracoes");
const IdDaConta = z.string().uuid();

export async function desconectarLinkedinAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const conta = IdDaConta.safeParse(id);
  if (!conta.success) return { ok: false, error: mensagemDoErroDoLinkedin("") };
  try {
    await runAsUserAction(async () => desconectarLinkedin(conta.data));
    revalidatePath("/integracoes");
    revalidatePath("/integracoes/canais");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: mensagemDoErroDoLinkedin(e instanceof Error ? e.name : "") };
  }
}
