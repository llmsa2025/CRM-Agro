import { z } from "zod";

/**
 * Schemas zod de Call (ligações) — uma fonte de verdade. Tipos via z.infer.
 * (AGENTS.md: zod em toda borda.) A normalização do phoneNumber para
 * E.164 acontece no service (`createCall`).
 *
 * A API HTTP NÃO cria nem muda campo de provedor da ligação (F1A-08): o POST de
 * ligação não existe e o PATCH só aceita `anotarLigacaoApiSchema` (lista de
 * permissão). Status, duração, gravação e transcrição vêm do provedor.
 */

/** CallDirection — espelha o enum do Prisma (§4/migration add_call_model). */
export const callDirectionSchema = z.enum(["outbound", "inbound"]);

/**
 * CallStatus — espelha o enum do Prisma. Máquina de estados da ligação:
 * scheduled → ringing → (answered | no_answer | busy | failed) → completed.
 */
export const callStatusSchema = z.enum([
  "scheduled",
  "ringing",
  "answered",
  "no_answer",
  "busy",
  "failed",
  "completed",
]);

/**
 * Resultado da ligação (produto §D) — espelha o enum `CallOutcome` do Prisma.
 * Vale para o pop-up (`finishManualCall`), o discador (`markCallOutcome`) e a
 * Voopi. Efeitos além de gravar:
 *  - `voicemail` → retorno automático em 2 dias úteis (compromisso `ligacao`);
 *  - `wrong_number` → o número do contato fica inválido (`ChannelIdentifier.
 *    invalido`), tag `Número errado` e o contato entra em "Revisar dados".
 * `disposition` (texto livre) continua separado.
 */
export const callOutcomeSchema = z.enum(["answered", "no_answer", "busy", "voicemail", "wrong_number", "skip"]);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;

/** Rótulos da tela (pop-up, discador, histórico) — uma fonte só. */
export const ROTULO_RESULTADO: Record<CallOutcome, string> = {
  answered: "Atendeu",
  no_answer: "Não atendeu",
  busy: "Ocupado",
  voicemail: "Caixa postal",
  wrong_number: "Número errado",
  skip: "Pulada",
};

/** Finalizar a ligação do pop-up (borda da action). */
export const finishManualCallSchema = z.object({
  outcome: callOutcomeSchema,
  durationSec: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
  disposition: z.string().optional(),
  dealId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
});
export type FinishManualCallInput = z.infer<typeof finishManualCallSchema>;

/**
 * Quem registra a ligação (`Call.provider`). União FECHADA, de uso interno: a API
 * não aceita provedor vindo do cliente. A F1A-11 tira "voopi"; a F1B-03 passa a
 * usar as chaves do registro de provedores.
 */
export type ProvedorDaLigacao = "manual" | "voopi";

/**
 * Entrada de `createCall`: tipo TypeScript INTERNO, sem schema zod de propósito (não
 * há rota que crie ligação). Quem chama (o discador e a Voopi) já leu o número do banco.
 * A row nasce leve (status default `scheduled` no Prisma, sem áudio/transcrição/resumo).
 * `providerCallId` chega quando o provedor já devolveu o id da chamada; `channelAccountId`
 * liga a conta conectada usada.
 */
export type CreateCallInput = {
  contactId: string;
  phoneNumber: string;
  direction: z.infer<typeof callDirectionSchema>;
  provider: ProvedorDaLigacao;
  channelAccountId?: string;
  providerCallId?: string;
};

/**
 * Corpo do `PATCH /api/calls/:id`: LISTA DE PERMISSÃO (F1A-08). Só `notes` e
 * `disposition`; qualquer outro campo (status, duração, gravação, transcrição,
 * resumo, horários, provedor, dono) é recusado com 400, e ao menos um dos dois é
 * obrigatório. Quem escreve esses campos é o provedor, nunca a API.
 */
export const anotarLigacaoApiSchema = z
  .object({
    notes: z.string().trim().max(5000, "notes: no máximo 5000 caracteres").optional(),
    disposition: z.string().trim().max(200, "disposition: no máximo 200 caracteres").optional(),
  })
  .strict()
  .refine((d) => d.notes !== undefined || d.disposition !== undefined, {
    message: "Informe notes ou disposition.",
  });
export type AnotarLigacaoApiInput = z.infer<typeof anotarLigacaoApiSchema>;

/**
 * Atualização de status/ciclo da ligação — de uso INTERNO: só o aplicador da
 * Voopi (`applyVoopiWebhookEvent`) a usa, e sai junto com ele na F1A-11. Nenhuma
 * rota da API a aceita (a catraca `escritores.catraca.test.ts` confere).
 * `status` é o único campo obrigatório; o restante preenche conforme o ciclo
 * (startedAt/endedAt/duração quando conecta/termina, disposition/notes).
 */
export const updateCallStatusSchema = z.object({
  status: callStatusSchema,
  startedAt: z.coerce.date().optional(),
  endedAt: z.coerce.date().optional(),
  durationSeconds: z.number().int().min(0).optional(),
  disposition: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});
export type UpdateCallStatusInput = z.infer<typeof updateCallStatusSchema>;

/**
 * Atualização de transcrição/resumo/áudio — preenchida pelo worker pós-chamada
 * (IA transcreve/sintetiza o áudio gravado). Todos opcionais: worker parcial.
 */
export const updateCallTranscriptionSchema = z.object({
  transcript: z.string().optional(),
  summary: z.string().optional(),
  recordingUrl: z.string().trim().optional(),
});
export type UpdateCallTranscriptionInput = z.infer<typeof updateCallTranscriptionSchema>;
