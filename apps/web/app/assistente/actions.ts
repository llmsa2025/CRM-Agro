"use server";

import { mensagemParaTela } from "@/lib/erros";
import { acaoDaTela } from "@/lib/tenant";
import {
  runAgent,
  listAiIntegrations,
  listAiConversations,
  getAiConversation,
  saveAiConversation,
  deleteAiConversation,
  type AgentMessage,
  type AgentToolCall,
  type AiMsg,
  type ConversaResumo,
  type ConversaFull,
} from "@crmagro/core";

/**
 * Actions do Assistente de IA (o widget aparece em TODA página). Saíram de
 * `integracoes/ia/actions` (revisão do #150): lá, quem não tem a tela
 * Integrações perdia o assistente. O Painel é de todos; o que o agente pode
 * ler/escrever já respeita as telas da pessoa (sem Contatos, sem tools de contato).
 */
const runAsUserAction = acaoDaTela("painel");

export type ActionState = { error?: string; ok?: boolean };

/** Provedores de IA conectados que o agente pode usar (só anthropic/glm hoje). */
export async function loadAiProvidersAction(): Promise<{ provider: "anthropic" | "glm"; label: string }[]> {
  const LABEL: Record<string, string> = { anthropic: "Claude (Anthropic)", glm: "GLM (z.ai)" };
  const rows = await runAsUserAction(async () => listAiIntegrations());
  return rows
    .filter((r) => r.connected && (r.provider === "anthropic" || r.provider === "glm"))
    .map((r) => ({ provider: r.provider as "anthropic" | "glm", label: LABEL[r.provider] ?? r.provider }));
}

/** Conversa com o agente de IA (tool-use tenant-scoped). Retorna resposta + tools usadas. */
export async function askAgentAction(
  messages: AgentMessage[],
  provider?: "anthropic" | "glm",
): Promise<ActionState & { reply?: string; toolCalls?: AgentToolCall[] }> {
  try {
    const res = await runAsUserAction(async () =>
      runAgent({ messages, ...(provider ? { provider } : {}) }),
    );
    return { ok: true, reply: res.reply, toolCalls: res.toolCalls };
  } catch (e) {
    return { error: mensagemParaTela(e) };
  }
}

/** Histórico do assistente — conversas guardadas NA CONTA (sincroniza entre dispositivos). */
export async function listConversationsAction(): Promise<ConversaResumo[]> {
  try {
    return await runAsUserAction(async () => listAiConversations());
  } catch {
    return [];
  }
}

export async function getConversationAction(id: string): Promise<ConversaFull | null> {
  try {
    return await runAsUserAction(async () => getAiConversation(id));
  } catch {
    return null;
  }
}

export async function saveConversationAction(input: {
  id?: string | null;
  titulo?: string;
  messages: AiMsg[];
}): Promise<ConversaResumo | null> {
  try {
    return await runAsUserAction(async () => saveAiConversation(input));
  } catch {
    return null;
  }
}

export async function deleteConversationAction(id: string): Promise<void> {
  try {
    await runAsUserAction(async () => deleteAiConversation(id));
  } catch {
    /* noop */
  }
}

