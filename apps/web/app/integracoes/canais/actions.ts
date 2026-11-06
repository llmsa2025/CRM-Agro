"use server";

import { mensagemParaTela } from "@/lib/erros";
import { requireRoleAction, acaoDaTela } from "@/lib/tenant";
import { revalidatePath } from "next/cache";
import {
  reconectarContaWhatsApp,
  conferirReconexao,
  setAccountPaused,
  startWhatsAppOnboarding,
  checkWhatsAppOnboarding,
  cancelWhatsAppOnboarding,
  confirmWhatsAppOnboarding,
  transferirCanal,
  renomearContaDeCanal,
} from "@crmagro/core";


/** Telas por pessoa (F2b): toda action deste arquivo confere a tela "integracoes". */
const runAsUserAction = acaoDaTela("integracoes");
/**
 * Onboarding de WhatsApp via QR code (Evolution API). A regra mora no core
 * (`integrations/whatsapp-onboarding.ts`): a instância fica amarrada ao time que
 * a criou (auditoria S4/INT-18) — check/cancel/confirm de instância de outro
 * time são recusados. Aqui só abrimos o contexto da sessão e traduzimos o erro.
 */

function mensagem(e: unknown): string {
  if (e instanceof Error && e.name === "ForbiddenError") return "Acesso negado";
  return mensagemParaTela(e);
}

export async function renameChannelAccountAction(id: string, label: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await runAsUserAction(() => renomearContaDeCanal(id, label));
    revalidatePath("/integracoes/canais");
    revalidatePath("/integracoes");
    revalidatePath("/conversas");
    return { ok: true };
  } catch {
    return { ok: false, error: "Não foi possível alterar o nome. Use de 1 a 100 caracteres e confira sua permissão." };
  }
}

export type ConnectStartState = {
  ok?: boolean;
  error?: string;
  instance?: string;
  qrBase64?: string | null;
  alreadyConnected?: boolean;
};

export async function startWhatsAppConnectAction(input: {
  label: string;
  number?: string;
}): Promise<ConnectStartState> {
  try {
    const r = await runAsUserAction(() => startWhatsAppOnboarding({ label: input.label }));
    if (!r.ok) return { error: r.error };
    return { ok: true, instance: r.instance, qrBase64: r.qrBase64, alreadyConnected: r.alreadyConnected };
  } catch (e) {
    return { error: mensagem(e) };
  }
}

export type ConnectCheckState = {
  ok?: boolean;
  error?: string;
  state?: string | null;
  connected?: boolean;
};

export async function checkWhatsAppConnectAction(instance: string): Promise<ConnectCheckState> {
  try {
    return await runAsUserAction(() => checkWhatsAppOnboarding(instance));
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

/**
 * Cancela um onboarding abandonado: remove a instância criada na Evolution
 * quando o usuário fecha o modal do QR sem escanear. Só a do próprio time.
 */
export async function cancelWhatsAppConnectAction(instance: string): Promise<{ ok: boolean; error?: string }> {
  if (!instance) return { ok: true };
  try {
    return await runAsUserAction(() => cancelWhatsAppOnboarding(instance));
  } catch (e) {
    return { ok: false, error: mensagem(e) };
  }
}

export type ConnectConfirmState = { ok?: boolean; error?: string; id?: string };

export async function confirmWhatsAppConnectAction(input: {
  label: string;
  number?: string;
  instance: string;
}): Promise<ConnectConfirmState> {
  try {
    const r = await runAsUserAction(() => confirmWhatsAppOnboarding(input));
    if (!r.ok) return { error: r.error };
    revalidatePath("/integracoes/canais");
    revalidatePath("/conversas");
    return { ok: true, id: r.id };
  } catch (e) {
    return { error: mensagem(e) };
  }
}

/**
 * "Reconectar" um número que caiu (item 1.6, INT-19) — na MESMA instância e na
 * MESMA conta (antes era preciso criar tudo de novo). Devolve o QR; os QRs
 * seguintes chegam pelo socket (`channel:qr`).
 */
export async function reconnectWhatsAppAccountAction(
  accountId: string,
): Promise<{ ok?: boolean; conectado?: boolean; qrBase64?: string | null; error?: string }> {
  try {
    const r = await runAsUserAction(() => reconectarContaWhatsApp(accountId));
    if (r.conectado) {
      revalidatePath("/integracoes/canais");
      return { ok: true, conectado: true };
    }
    return r.error ? { error: r.error } : { ok: true, conectado: false, qrBase64: r.qrBase64 };
  } catch (e) {
    return { error: mensagem(e) };
  }
}

/** O modal de reconexão consulta até o QR ser lido. */
export async function checkReconnectAction(
  accountId: string,
): Promise<{ ok?: boolean; conectado?: boolean; state?: string | null; error?: string }> {
  try {
    const r = await runAsUserAction(() => conferirReconexao(accountId));
    if (r.conectado) revalidatePath("/integracoes/canais");
    return { ok: true, ...r };
  } catch (e) {
    return { error: mensagem(e) };
  }
}

/**
 * Passa o número para outra pessoa da equipe (F3d): ela passa a ver as
 * conversas dele. Só o administrador (o core confere).
 */
export async function transferirCanalAction(id: string, para: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await runAsUserAction(() => transferirCanal(id, para));
    revalidatePath("/integracoes/canais");
    revalidatePath("/conversas");
    return { ok: true };
  } catch (e) {
    if (e instanceof Error && e.name === "DestinoDaTransferenciaInvalido") return { ok: false, error: "Escolha uma pessoa ativa da equipe." };
    return { ok: false, error: mensagem(e) };
  }
}

/** Pausa/retoma manualmente uma conta (controle de ritmo Fase B). */
export async function toggleAccountPausedAction(
  id: string,
  paused: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireRoleAction("admin"); // RBAC: gerir integrações exige admin+.
    await runAsUserAction(async () => setAccountPaused(id, paused));
    revalidatePath("/integracoes/canais");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: mensagemParaTela(e) };
  }
}
