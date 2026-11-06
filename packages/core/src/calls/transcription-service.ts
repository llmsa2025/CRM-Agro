import { basePrisma, runAsSystem, db, tenantData } from "@crmagro/db";
import type { Prisma, CallDirection } from "@prisma/client";
import { publishRealtime } from "../events/redis-bus";
import { getTranscriptionProvider, generateSummary } from "./transcription-provider";
import { gravacaoPermitida } from "./recording-url";
import { updateCallTranscription } from "./service";

/**
 * Serviço de transcrição + resumo IA para chamadas gravadas.
 *
 * Pipeline:
 * 1. Busca a Call cross-team (sem ALS de request, como applyVoopiWebhookEvent).
 * 2. Valida: recordingUrl existe + status === "completed".
 * 3. Transcreve áudio via TranscriptionProvider (faster-whisper). Sem serviço
 *    configurado → lança `TranscricaoNaoConfigurada`, sem gravar nada.
 * 4. Gera resumo do transcript pela IA do time (sem IA → sem resumo).
 * 5. Atualiza Call (transcript + summary) + cria Activity de call.
 * 6. Publica evento realtime call:transcription-completed.
 *
 * Idempotência: se a Call já tiver transcript, skip (não retranscreve).
 */

function activityDirecao(direction: CallDirection): "out" | "in" {
  return direction === "outbound" ? "out" : "in";
}

/**
 * Processa a transcrição de uma chamada.
 * Roda dentro de runWithTeam (abre contexto de tenancy com o teamId da Call).
 */
export async function processTranscription(callId: string): Promise<void> {
  // 1. Busca a Call cross-team (sem ALS, como applyVoopiWebhookEvent).
  const call = await basePrisma.call.findUnique({
    where: { id: callId },
    select: {
      id: true,
      teamId: true,
      contactId: true,
      status: true,
      recordingUrl: true,
      transcript: true,
      direction: true,
      phoneNumber: true,
    },
  });

  // Call não existe — ignora silenciosamente.
  if (!call) return;

  // 2. Valida pré-requisitos.
  if (!call.recordingUrl) return;
  if (call.status !== "completed") return;
  // Já tem transcript — idempotência.
  if (call.transcript) return;

  // 3. Abre contexto de tenancy.
  // 2b. S13: só transcreve gravação de host permitido (o serviço de whisper
  // baixa a URL — URL arbitrária seria SSRF a partir do VPS).
  if (!gravacaoPermitida(call.recordingUrl)) return;

  await runAsSystem(call.teamId, async () => {
    // 4. Transcreve o áudio. Sem serviço configurado o provider LANÇA
    // `TranscricaoNaoConfigurada` ("transcrição não configurada") e nada é
    // gravado: nem placeholder, nem resumo. O job falha à vista (o handler do
    // worker não retenta esse erro) em vez de sumir em silêncio.
    const provider = getTranscriptionProvider();
    const transcript = await provider.transcribe(call.recordingUrl!);

    // 5. Gera resumo IA (IA do time; sem IA conectada ou em falha → null, e a
    // transcrição é salva sem resumo — nada de placeholder gravado).
    const summary = await generateSummary(transcript);

    // 6. Atualiza a Call com transcript + summary.
    await updateCallTranscription(callId, { transcript, ...(summary ? { summary } : {}) });

    // 7. Cria Activity de call com o resumo (rastreabilidade na timeline).
    const prisma = db();
    await prisma.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId: call.contactId,
        tipo: "call",
        direcao: activityDirecao(call.direction),
        conteudo: summary ? `Ligação transcrita: ${summary}` : "Ligação transcrita",
        meta: { callId: call.id, transcribed: true, summarized: summary !== null },
      }),
    });

    // 8. Publica evento realtime (discador/historico atualiza ao vivo).
    publishRealtime({
      type: "call:transcription-completed",
      callId: call.id,
      contactId: call.contactId,
      transcript,
      summary,
    });

    // KPIs do "motor do dia" podem mudar com nova activity.
    publishRealtime({ type: "dashboard:changed" });
  });
}
