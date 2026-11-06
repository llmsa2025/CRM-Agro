import { z } from "zod";
import { chamarIa, provedoresConectados, textoDaResposta } from "../ai/provedores";
import { getAiMode } from "../integrations/service";
import { logger } from "../logger/index";

/**
 * Provider de transcrição — interface pluggável (mesma filosofia do
 * `CallProvider` em channels). Em produção, `WhisperTranscriptionProvider`
 * fala com um serviço faster-whisper local. Em dev/test, `StubTranscriptionProvider`
 * retorna placeholder sem depender de nada externo.
 */

export interface TranscriptionProvider {
  transcribe(audioUrl: string): Promise<string>;
}

export const transcriptionConfigSchema = z.object({
  url: z.string().url().optional(),
  model: z.string().default("base"),
  language: z.string().default("pt"),
});
export type TranscriptionConfig = z.infer<typeof transcriptionConfigSchema>;

/** Sem serviço de transcrição configurado (TRANSCRIPTION_SERVICE_URL vazio). */
export class TranscricaoNaoConfigurada extends Error {
  constructor() {
    super("TranscricaoNaoConfigurada: transcrição não configurada (TRANSCRIPTION_SERVICE_URL).");
    this.name = "TranscricaoNaoConfigurada";
  }
}

/**
 * Stub — sem serviço de whisper. NÃO devolve texto: antes gravava um
 * placeholder ("[Transcrição pendente — áudio em <url>]") como se fosse a
 * transcrição, e o resumo IA era feito sobre ele (S13). Agora lança, e o
 * pipeline não persiste nada.
 */
export class StubTranscriptionProvider implements TranscriptionProvider {
  async transcribe(): Promise<string> {
    throw new TranscricaoNaoConfigurada();
  }
}

/** Teto da transcrição (serviço Whisper — INT-15). */
const TRANSCRICAO_TIMEOUT_MS = 5 * 60_000;

/**
 * Provider Whisper HTTP — fala com uma API REST faster-whisper local.
 * Espera POST { audio_url } → { text: string }.
 *
 * Se TRANSCRIPTION_SERVICE_URL não estiver setado, usa o stub.
 */
export class WhisperTranscriptionProvider implements TranscriptionProvider {
  private url: string;
  private model: string;
  private language: string;

  constructor(config: TranscriptionConfig) {
    this.url = config.url ?? "";
    this.model = config.model;
    this.language = config.language;
  }

  async transcribe(audioUrl: string): Promise<string> {
    const resp = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: audioUrl,
        model: this.model,
        language: this.language,
      }),
      // INT-15: transcrever uma ligação longa demora, mas não para sempre.
      signal: AbortSignal.timeout(TRANSCRICAO_TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`Whisper API retornou ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as { text?: string };
    return data.text ?? "";
  }
}

/**
 * Factory — escolhe o provider com base no env. Se TRANSCRIPTION_SERVICE_URL
 * estiver vazio ou não setado, usa o stub.
 */
export function getTranscriptionProvider(): TranscriptionProvider {
  const url = process.env.TRANSCRIPTION_SERVICE_URL;
  if (!url) {
    return new StubTranscriptionProvider();
  }
  return new WhisperTranscriptionProvider(
    transcriptionConfigSchema.parse({ url }),
  );
}

/** Teto do resumo por IA (INT-15) e do texto mandado a ela. */
const RESUMO_TIMEOUT_MS = 60_000;
const RESUMO_MAX_CHARS = 60_000;

/**
 * Resumo da ligação pela IA DO TIME (as chaves conectadas em Integrações, com
 * o fallback de provedor do item 3.5). Roda no contexto do time (runAsSystem).
 *
 * Antes (INT-22) usava a chave do OPERADOR (`ANTHROPIC_API_KEY` do servidor):
 * o conteúdo da ligação de um cliente passava pelo gateway do operador (LGPD).
 * E sem chave, ou em erro, devolvia um placeholder ("[Resumo pendente…]",
 * "[Erro ao gerar resumo…]") que era GRAVADO como se fosse o resumo. Agora: sem
 * IA conectada, ou em falha → `null`, e a transcrição é salva sem resumo.
 *
 * Respeita a governança da IA do time (`aiMode`, padrão "off"), como o
 * `flow-message` e o `personalize`: com a IA desligada, a transcrição (dado
 * pessoal do lead) NÃO vai para o provedor, mesmo com chave conectada.
 */
export async function generateSummary(transcript: string): Promise<string | null> {
  if ((await getAiMode()) === "off") return null;
  const candidatos = await provedoresConectados();
  if (candidatos.length === 0) return null;
  const prompt = `Resuma esta ligação telefônica comercial em 3-5 frases, destacando pontos-chave, decisão tomada e próximos passos:\n\n${transcript.slice(0, RESUMO_MAX_CHARS)}`;
  try {
    const { data } = await chamarIa(
      candidatos,
      { max_tokens: 500, messages: [{ role: "user", content: prompt }] },
      { timeoutMs: RESUMO_TIMEOUT_MS },
    );
    return textoDaResposta(data) || null;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[transcrição] resumo por IA falhou — salvo sem resumo");
    return null;
  }
}
