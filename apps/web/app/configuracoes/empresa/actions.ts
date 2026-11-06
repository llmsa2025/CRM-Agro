"use server";

import { revalidatePath } from "next/cache";
import { atualizarEmpresa, type EmpresaDTO } from "@crmagro/core";
import { acaoDaTela } from "@/lib/tenant";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "configuracoes". */
const runAsUserAction = acaoDaTela("configuracoes");
export type EmpresaState = { ok: true; empresa: EmpresaDTO } | { ok: false; error: string };

/** Configurações → Empresa: nome, CNPJ, cidade e UF (dono e administradores; o core confere). */
export async function atualizarEmpresaAction(input: { nome: string; cnpj: string; cidade: string; estado: string }): Promise<EmpresaState> {
  try {
    const empresa = await runAsUserAction(() => atualizarEmpresa(input));
    revalidatePath("/configuracoes");
    return { ok: true, empresa };
  } catch (e) {
    if (e instanceof Error && e.name === "ZodError") return { ok: false, error: "Confira os dados: nome com 2+ letras, CNPJ com 14 dígitos e UF com 2 letras." };
    if (e instanceof Error && e.name === "ForbiddenError") return { ok: false, error: "Só o master e os administradores alteram os dados da empresa." };
    // Erro inesperado: mensagem genérica (auditoria do #148, S6 — nada interno vai ao navegador).
    return { ok: false, error: "Não foi possível salvar agora. Tente de novo." };
  }
}
