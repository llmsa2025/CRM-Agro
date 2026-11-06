import { UnrecoverableError } from "bullmq";
import { processTranscription, TranscricaoNaoConfigurada, type TranscriptionJob } from "@crmagro/core";

/**
 * Handler BullMQ da fila "transcription".
 *
 * Consome jobs enfileirados por `scheduleTranscription` (chamado quando o
 * webhook da Voopi grava o recordingUrl). Cada job processa UMA chamada:
 * baixa áudio → transcribe → gera resumo IA → atualiza Call + Activity.
 *
 * Falhas: BullMQ retenta (attempts:3, backoff exponencial no queue.ts).
 * Erros de rede (áudio indisponível, IA fora do ar) são transientes e
 * o retry com backoff resolve. Erros permanentes (Call não existe)
 * são tratados como no-op no service (return early), não como throw.
 * Transcrição não configurada falha SEM retry (UnrecoverableError).
 */

export async function handleTranscriptionJob(
  _jobId: string | null | undefined,
  data: TranscriptionJob,
): Promise<void> {
  try {
    await processTranscription(data.callId);
  } catch (e) {
    // "Transcrição não configurada" (sem TRANSCRIPTION_SERVICE_URL) não
    // melhora tentando de novo: o job falha uma vez, com o motivo no log.
    if (e instanceof TranscricaoNaoConfigurada) throw new UnrecoverableError(e.message);
    throw e;
  }
}
