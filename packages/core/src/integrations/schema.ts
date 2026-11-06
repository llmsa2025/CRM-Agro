import { z } from "zod";

/**
 * Provedores de IA plugáveis (Fase 6). As credenciais (chave de API) são
 * cifradas em `Integration.credentials` via `encryptCredentials`. `glm` = z.ai
 * (endpoint Anthropic-compatível).
 */
export const aiProviderSchema = z.enum(["anthropic", "openai", "glm"]);
export type AiProvider = z.infer<typeof aiProviderSchema>;

/** Entrada para conectar/atualizar um provedor de IA. */
export const saveAiIntegrationSchema = z.object({
  provider: aiProviderSchema,
  apiKey: z.string().trim().min(8, "chave de API muito curta"),
});
export type SaveAiIntegrationInput = z.infer<typeof saveAiIntegrationSchema>;

/**
 * Governança da IA na plataforma:
 *  - off        → IA desligada (nenhuma chamada).
 *  - read_only  → IA só lê/analisa/sugere (não escreve no banco).
 *  - read_write → IA pode escrever (sempre atribuído a autor=IA; tags "IA:").
 */
export const aiModeSchema = z.enum(["off", "read_only", "read_write"]);
export type AiMode = z.infer<typeof aiModeSchema>;

/** DTO seguro para a UI — NUNCA expõe a chave em claro (só os 4 últimos). */
export type AiIntegrationDTO = {
  provider: AiProvider;
  connected: boolean;
  status: string;
  maskedKey: string | null;
  updatedAt: string | null;
};
