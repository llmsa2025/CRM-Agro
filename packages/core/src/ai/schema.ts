import { z } from "zod";

/** Mensagem de chat trocada com o agente (API pública simples: papel + texto). */
export const agentMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const runAgentInputSchema = z.object({
  messages: z.array(agentMessageSchema).min(1),
  provider: z.enum(["anthropic", "glm"]).optional(), // openai (formato chat) fica p/ depois
  model: z.string().trim().optional(),
  maxSteps: z.number().int().min(1).max(12).optional(),
});
export type RunAgentInput = z.infer<typeof runAgentInputSchema>;

/** Registro de uma chamada de tool feita pelo agente (para auditoria/UI). */
export type AgentToolCall = {
  name: string;
  input: unknown;
  ok: boolean;
  write: boolean;
};

export type RunAgentResult = {
  reply: string;
  toolCalls: AgentToolCall[];
  stopReason: string;
};
