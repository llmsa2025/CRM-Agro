"use server";

import { ZodError } from "zod";
import { acaoDaTela } from "@/lib/tenant";
import { planilhaParaCsv } from "@/lib/planilha";
import { revalidatePath } from "next/cache";
import {
  cancelImport,
  commitImport,
  getImportJob,
  listImportJobs,
  previewImport,
  type ImportJobDTO,
  type PreviewImportacao,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "contatos". */
const runAsUserAction = acaoDaTela("contatos");
/**
 * Importação de contatos em 4 passos (produto §C). A tela manda o ARQUIVO a
 * cada chamada (o navegador guarda o File entre os passos); a conversão
 * Excel→CSV fica na borda e as regras no core.
 */

export type PreviewImportState = { ok: true; preview: PreviewImportacao } | { ok: false; error: string };

/** Mensagem de erro para a tela (erros nomeados do core e da borda). */
function mensagem(e: unknown): string {
  if (e instanceof SyntaxError || e instanceof ZodError) return "mapeamento inválido";
  if (e instanceof Error) return e.message.replace(/^[A-Za-z]+: /, "");
  return String(e);
}

/**
 * Passos 1–3: lê a planilha, sugere o mapeamento e classifica as linhas (novo,
 * já existe, repetido, inválido). Não grava nada. `formData`: `file` e,
 * opcional, `mapeamento` (JSON: um campo ou null por coluna) quando o usuário
 * troca para onde vai uma coluna.
 */
export async function previewImportAction(formData: FormData): Promise<PreviewImportState> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "nenhum arquivo enviado" };
  const bruto = formData.get("mapeamento");
  try {
    const texto = await planilhaParaCsv(file);
    const mapeamento: unknown = typeof bruto === "string" && bruto ? JSON.parse(bruto) : undefined;
    const preview = await runAsUserAction(async () => previewImport({ texto, mapeamento }));
    return { ok: true, preview };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

export type ImportJobState = { ok: true; job: ImportJobDTO } | { ok: false; error: string };

/** JSON opcional de um campo do form (mapeamento/opções). */
function jsonDoForm(formData: FormData, campo: string): unknown {
  const bruto = formData.get(campo);
  return typeof bruto === "string" && bruto ? JSON.parse(bruto) : undefined;
}

/**
 * Passo 4 ("Importar"): sobe a planilha para o Storage privado, cria o job e
 * enfileira — volta na hora; o andamento chega pelo evento `import:progress`
 * (ou por `getImportJobAction`). `formData`: `file`, `mapeamento` (JSON) e,
 * opcional, `opcoes` (JSON: `{ origem?, existentes?: "completar" | "pular" }`).
 */
export async function commitImportAction(formData: FormData): Promise<ImportJobState> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "nenhum arquivo enviado" };
  try {
    const texto = await planilhaParaCsv(file);
    const mapeamento = jsonDoForm(formData, "mapeamento");
    const opcoes = jsonDoForm(formData, "opcoes");
    const job = await runAsUserAction(async () => commitImport({ texto, nomeArquivo: file.name, mapeamento, opcoes }));
    return { ok: true, job };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

/** Situação de uma importação (polling de reserva, se o socket cair). */
export async function getImportJobAction(id: string): Promise<ImportJobState> {
  try {
    const job = await runAsUserAction(async () => getImportJob(id));
    if (job.status === "done") revalidatePath("/contatos");
    return { ok: true, job };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

/** Importações recentes do time (a tela acha a que está rodando depois de recarregar). */
export async function listImportJobsAction(): Promise<ImportJobDTO[]> {
  return runAsUserAction(async () => listImportJobs());
}

/** Cancela: para entre blocos; o que já entrou fica. */
export async function cancelImportAction(id: string): Promise<ImportJobState> {
  try {
    const job = await runAsUserAction(async () => cancelImport(id));
    return { ok: true, job };
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}
