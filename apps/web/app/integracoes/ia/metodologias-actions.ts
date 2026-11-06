"use server";

import { revalidatePath } from "next/cache";
import { acaoDaTela } from "@/lib/tenant";
import { atualizarMetodologia, criarMetodologia, definirPadrao, excluirMetodologia } from "@crmagro/core";

/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". O papel (admin) o core confere. */
const runAsUserAction = acaoDaTela("integracoes");

export type RespostaMetodologia = { ok: true; id?: string } | { ok: false; error: string };

/** Erros com frase escrita para a pessoa (`MetodologiaInvalida`, sem permissão). */
function texto(e: unknown): string {
  if (e instanceof Error && e.name === "MetodologiaInvalida") return e.message;
  if (e instanceof Error && e.name === "ForbiddenError") return "Só administrador mexe nas metodologias.";
  return "Não consegui agora. Tente de novo em instantes.";
}

async function executar(fn: () => Promise<{ id?: string } | void>): Promise<RespostaMetodologia> {
  try {
    const r = await runAsUserAction(fn);
    revalidatePath("/integracoes/ia");
    return { ok: true, ...(r ?? {}) };
  } catch (e) {
    return { ok: false, error: texto(e) };
  }
}

export async function criarMetodologiaAction(input: { nome: string; finalidade: string; descricao?: string; conteudo: string; modelo?: string }): Promise<RespostaMetodologia> {
  return executar(async () => ({ id: (await criarMetodologia(input)).id }));
}

export async function atualizarMetodologiaAction(id: string, input: { nome?: string; descricao?: string | null; conteudo?: string }): Promise<RespostaMetodologia> {
  return executar(async () => {
    await atualizarMetodologia(id, input);
  });
}

export async function definirPadraoAction(id: string): Promise<RespostaMetodologia> {
  return executar(async () => {
    await definirPadrao(id);
  });
}

export async function excluirMetodologiaAction(id: string): Promise<RespostaMetodologia> {
  return executar(async () => {
    await excluirMetodologia(id);
  });
}
