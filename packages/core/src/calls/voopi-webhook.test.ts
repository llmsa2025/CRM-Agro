import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { basePrisma } from "@crmagro/db";

/**
 * Webhook da Voopi pelo core (auditoria S13 — item 0.7). A rota antiga chamava
 * `db()` sem contexto de time e quebrava em todo evento. A fila de transcrição
 * é mockada (nenhum job de verdade).
 */
const scheduleTranscription = vi.fn(async () => {});
vi.mock("./transcription-queue", () => ({
  scheduleTranscription: (...a: unknown[]) => scheduleTranscription(...(a as [])),
}));

const { applyVoopiWebhookEvent } = await import("./service");
const { gravacaoPermitida } = await import("./recording-url");
const { StubTranscriptionProvider, TranscricaoNaoConfigurada } = await import("./transcription-provider");

const TEAM = "00000000-0000-0000-0000-0000000000fc";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Voopi (test)" } });
});

// A transcrição só é agendada com o serviço configurado (auditoria do #138).
const TRANSCRICAO_ANTES = process.env.TRANSCRIPTION_SERVICE_URL;
afterAll(() => {
  if (TRANSCRICAO_ANTES === undefined) delete process.env.TRANSCRIPTION_SERVICE_URL;
  else process.env.TRANSCRIPTION_SERVICE_URL = TRANSCRICAO_ANTES;
});

beforeEach(async () => {
  process.env.TRANSCRIPTION_SERVICE_URL = "https://whisper.teste/transcrever";
  scheduleTranscription.mockClear();
  await basePrisma.activity.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.call.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.contact.deleteMany({ where: { teamId: TEAM } });
});

async function ligacao(providerCallId: string) {
  const c = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Cliente" } });
  return basePrisma.call.create({
    data: {
      teamId: TEAM,
      contactId: c.id,
      phoneNumber: "5565999990000",
      direction: "outbound",
      provider: "voopi",
      providerCallId,
      status: "ringing",
    },
  });
}

describe("webhook Voopi no core", () => {
  it("atende e encerra a ligação (sem contexto de sessão)", async () => {
    const call = await ligacao(`vp-${Date.now()}`);
    await applyVoopiWebhookEvent({ event: "call.answered", callId: call.providerCallId! } as never);
    await applyVoopiWebhookEvent({ event: "call.ended", callId: call.providerCallId!, duration: 42 } as never);
    const depois = await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(depois.status).toBe("completed");
    expect(depois.durationSeconds).toBe(42);
  });

  it("gravação da Voopi é gravada e agenda transcrição; de outro host é ignorada", async () => {
    const call = await ligacao(`vp2-${Date.now()}`);
    await applyVoopiWebhookEvent({
      event: "call.recording",
      callId: call.providerCallId!,
      recordingUrl: "http://169.254.169.254/latest/meta-data/",
    } as never);
    expect((await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } })).recordingUrl).toBeNull();
    expect(scheduleTranscription).not.toHaveBeenCalled();

    await applyVoopiWebhookEvent({
      event: "call.recording",
      callId: call.providerCallId!,
      recordingUrl: "https://gravacoes.voopi.com.br/abc.mp3",
    } as never);
    expect((await basePrisma.call.findUniqueOrThrow({ where: { id: call.id } })).recordingUrl).toBe(
      "https://gravacoes.voopi.com.br/abc.mp3",
    );
    // Gravação chegou com a ligação em curso: só agenda quando ela termina (3.6).
    expect(scheduleTranscription).not.toHaveBeenCalled();
    await applyVoopiWebhookEvent({ event: "call.ended", callId: call.providerCallId!, duration: 30 } as never);
    expect(scheduleTranscription).toHaveBeenCalledTimes(1);
    expect(scheduleTranscription).toHaveBeenCalledWith(call.id);
  });

  it("fim da ligação antes da gravação: agenda quando a gravação chega; sem gravação, nunca", async () => {
    const call = await ligacao(`vp3-${Date.now()}`);
    await applyVoopiWebhookEvent({ event: "call.ended", callId: call.providerCallId!, duration: 12 } as never);
    expect(scheduleTranscription).not.toHaveBeenCalled(); // terminou, mas ainda sem gravação
    await applyVoopiWebhookEvent({
      event: "call.recording",
      callId: call.providerCallId!,
      recordingUrl: "https://gravacoes.voopi.com.br/def.mp3",
    } as never);
    expect(scheduleTranscription).toHaveBeenCalledTimes(1);
    expect(scheduleTranscription).toHaveBeenCalledWith(call.id);
  });

  it("allowlist de gravação: só https em host da Voopi", () => {
    expect(gravacaoPermitida("https://voopi.com.br/a.mp3")).toBe(true);
    expect(gravacaoPermitida("https://x.voopi.com.br/a.mp3")).toBe(true);
    expect(gravacaoPermitida("http://x.voopi.com.br/a.mp3")).toBe(false);
    expect(gravacaoPermitida("https://voopi.com.br.evil.com/a.mp3")).toBe(false);
    expect(gravacaoPermitida("https://127.0.0.1/a.mp3")).toBe(false);
    expect(gravacaoPermitida(null)).toBe(false);
  });

  it("sem serviço de transcrição, o stub não inventa texto", async () => {
    await expect(new StubTranscriptionProvider().transcribe()).rejects.toBeInstanceOf(TranscricaoNaoConfigurada);
  });
});
