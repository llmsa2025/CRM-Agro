"use server";

import { mensagemParaTela } from "@/lib/erros";
import { requireRoleAction, acaoDaTela } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { mensagemDoErroDeDesligarGmail } from "../canais/gmail";
import {
  connectEmailAccount,
  deleteEmailAccount,
  desligarEnvioPeloGmail,
  getEmailAccountConfig,
  testEmailConnection,
  listSignatures,
  createSignature,
  updateSignature,
  deleteSignature,
  type ConnectEmailInput,
  type EmailAccountConfigDTO,
  type TestEmailResult,
  type SignatureDTO,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". */
const runAsUserAction = acaoDaTela("integracoes");
export type ActionState = { error?: string; ok?: boolean; connected?: boolean };

/** Conecta/atualiza a conta SMTP de e-mail (verifica + cifra no serviço). */
export async function connectEmailAction(input: ConnectEmailInput): Promise<ActionState> {
  // Em edição (input.id), a senha pode vir vazia = manter a atual.
  if (!input.host?.trim() || !input.user?.trim() || (!input.id && !input.pass)) {
    return { error: "preencha host, usuário e senha" };
  }
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    const res = await runAsUserAction(async () => connectEmailAccount(input));
    revalidatePath("/integracoes/canais");
    return { ok: true, connected: res.connected, error: res.connected ? undefined : res.error };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Testa a conexão (SMTP + IMAP) SEM salvar, devolvendo o motivo de cada falha. */
export async function testEmailAction(input: ConnectEmailInput): Promise<{ result?: TestEmailResult; error?: string }> {
  if (!input.host?.trim() || !input.user?.trim()) {
    return { error: "preencha host e usuário" };
  }
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    const result = await runAsUserAction(async () => testEmailConnection(input));
    return { result };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Carrega a config de uma conta de e-mail para edição (sem a senha). */
export async function getEmailAccountConfigAction(
  id: string,
): Promise<{ config?: EmailAccountConfigDTO; error?: string }> {
  try {
    const config = await runAsUserAction(async () => getEmailAccountConfig(id));
    if (!config) return { error: "conta não encontrada" };
    return { config };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Remove uma conta de e-mail. */
export async function deleteEmailAction(id: string): Promise<ActionState> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    await runAsUserAction(async () => deleteEmailAccount(id));
    revalidatePath("/integracoes/canais");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/**
 * "Desligar o envio pelo Gmail": apaga a caixa `gmail_api`. SEM `requireRoleAction("admin")`
 * de propósito: o dono da caixa (membro) também pode, e o core confere (dono ou administrador).
 * A Agenda Google continua conectada. O erro nunca sobe cru (a mensagem do core traz o id da
 * caixa): só o NOME do erro vira um texto fixo.
 */
export async function desligarEnvioGmailAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const caixa = z.string().uuid().safeParse(id);
  if (!caixa.success) return { error: mensagemDoErroDeDesligarGmail("") };
  try {
    await runAsUserAction(async () => desligarEnvioPeloGmail(caixa.data));
    revalidatePath("/integracoes/canais");
    return { ok: true };
  } catch (e) {
    return { error: mensagemDoErroDeDesligarGmail(e instanceof Error ? e.name : "") };
  }
}

// ─── Assinaturas de e-mail ──────────────────────────────────────────────────

/** Assinaturas de UMA caixa de e-mail (por caixa, 28/09) — Canais → E-mail. */
export async function listSignaturesAction(channelAccountId: string): Promise<SignatureDTO[]> {
  if (!channelAccountId) return [];
  return runAsUserAction(async () => listSignatures({ channelAccountId }));
}

export async function createSignatureAction(input: {
  channelAccountId: string;
  nome: string;
  html: string;
  isDefault?: boolean;
}): Promise<{ ok?: boolean; error?: string; signature?: SignatureDTO }> {
  if (!input.nome?.trim()) return { error: "informe um nome" };
  if (!input.channelAccountId) return { error: "escolha a caixa de e-mail" };
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    const signature = await runAsUserAction(async () => createSignature(input));
    revalidatePath("/integracoes/canais");
    return { ok: true, signature };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function updateSignatureAction(
  id: string,
  input: { nome?: string; html?: string; isDefault?: boolean },
): Promise<{ ok?: boolean; error?: string }> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    await runAsUserAction(async () => updateSignature(id, input));
    revalidatePath("/integracoes/canais");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

export async function deleteSignatureAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    await runAsUserAction(async () => deleteSignature(id));
    revalidatePath("/integracoes/canais");
    return { ok: true };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}
