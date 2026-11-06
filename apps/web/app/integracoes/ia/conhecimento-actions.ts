"use server";

import { revalidatePath } from "next/cache";
import { acaoDaTela } from "@/lib/tenant";
import {
  adicionarArquivo,
  adicionarLinkDoGoogle,
  adicionarTexto,
  atualizarDoGoogle,
  atualizarDocumento,
  excluirDocumento,
  lerDocumento,
  TAMANHO_MAX_ARQUIVO,
} from "@crmagro/core";

/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". O papel (admin) o core confere. */
const runAsUserAction = acaoDaTela("integracoes");

export type RespostaBase = { ok: true; id?: string; conteudo?: string } | { ok: false; error: string };

/** Erros com frase escrita para a pessoa (`ConhecimentoInvalido`, `ArquivoNaoLido`, sem permissão). */
const NOMES_LEGIVEIS = new Set(["ConhecimentoInvalido", "ArquivoNaoLido", "ForbiddenError"]);

function texto(e: unknown): string {
  if (e instanceof Error && NOMES_LEGIVEIS.has(e.name)) return e.name === "ForbiddenError" ? "Só administrador mexe na base de conhecimento." : e.message;
  return "Não consegui agora. Tente de novo em instantes.";
}

async function executar(fn: () => Promise<{ id?: string; conteudo?: string } | void>): Promise<RespostaBase> {
  try {
    const r = await runAsUserAction(fn);
    revalidatePath("/integracoes/ia");
    return { ok: true, ...(r ?? {}) };
  } catch (e) {
    return { ok: false, error: texto(e) };
  }
}

export async function adicionarTextoAction(input: { titulo: string; conteudo: string }): Promise<RespostaBase> {
  return executar(async () => ({ id: (await adicionarTexto(input)).id }));
}

/** `formData`: `arquivo` (File) e, opcional, `titulo`. */
export async function adicionarArquivoAction(formData: FormData): Promise<RespostaBase> {
  const arquivo = formData.get("arquivo");
  if (!(arquivo instanceof File)) return { ok: false, error: "Escolha um arquivo." };
  if (arquivo.size > TAMANHO_MAX_ARQUIVO) return { ok: false, error: `O arquivo tem mais de ${TAMANHO_MAX_ARQUIVO / 1024 / 1024} MB. Envie uma versão menor.` };
  const titulo = formData.get("titulo");
  return executar(async () => ({
    id: (await adicionarArquivo({ nome: arquivo.name, bytes: new Uint8Array(await arquivo.arrayBuffer()), titulo: typeof titulo === "string" ? titulo : undefined })).id,
  }));
}

export async function adicionarLinkAction(input: { url: string; titulo?: string }): Promise<RespostaBase> {
  return executar(async () => ({ id: (await adicionarLinkDoGoogle(input)).id }));
}

export async function atualizarDocumentoAction(id: string, input: { titulo?: string; ativo?: boolean; conteudo?: string }): Promise<RespostaBase> {
  return executar(async () => {
    await atualizarDocumento(id, input);
  });
}

export async function atualizarDoGoogleAction(id: string): Promise<RespostaBase> {
  return executar(async () => {
    await atualizarDoGoogle(id);
  });
}

export async function excluirDocumentoAction(id: string): Promise<RespostaBase> {
  return executar(async () => {
    await excluirDocumento(id);
  });
}

/** Texto de um documento "texto" para a tela de edição. */
export async function lerDocumentoAction(id: string): Promise<RespostaBase> {
  try {
    const d = await runAsUserAction(() => lerDocumento(id));
    return { ok: true, id: d.id, conteudo: d.conteudo };
  } catch (e) {
    return { ok: false, error: texto(e) };
  }
}
