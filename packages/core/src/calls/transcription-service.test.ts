import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Testes do serviço de transcrição + resumo IA.
 *
 * Mocks:
 * - basePrisma.call.findUnique: retorna Call mockada
 * - runWithTeam/runAsSystem: executam o callback diretamente (sem ALS)
 * - getTranscriptionProvider: retorna stub com texto conhecido
 * - generateSummary: retorna resumo mockado
 * - updateCallTranscription: spy
 * - db().activity.create: spy
 * - publishRealtime: spy
 */

vi.mock("@crmagro/db", () => ({
  basePrisma: {
    call: { findUnique: vi.fn() },
  },
  runWithTeam: vi.fn(async (_teamId: string, fn: () => Promise<void>) => fn()),
  runAsSystem: vi.fn(async (_teamId: string, fn: () => Promise<void>) => fn()),
  db: vi.fn(() => ({
    activity: { create: vi.fn().mockResolvedValue({ id: "act-1" }) },
  })),
  tenantData: vi.fn((data: unknown) => data),
}));

vi.mock("../events/redis-bus", () => ({
  publishRealtime: vi.fn(),
}));

vi.mock("./transcription-provider", () => ({
  TranscricaoNaoConfigurada: class TranscricaoNaoConfigurada extends Error {},
  getTranscriptionProvider: vi.fn(() => ({
    transcribe: vi.fn().mockResolvedValue("Olá, tudo bem? Sou da empresa X."),
  })),
  generateSummary: vi.fn().mockResolvedValue("Ligação de apresentação comercial."),
}));

vi.mock("./service", () => ({
  updateCallTranscription: vi.fn().mockResolvedValue({}),
}));

import { processTranscription } from "./transcription-service";
import { basePrisma } from "@crmagro/db";
import { publishRealtime } from "../events/redis-bus";
import { getTranscriptionProvider, generateSummary, TranscricaoNaoConfigurada } from "./transcription-provider";
import { updateCallTranscription } from "./service";

function makeCall(overrides: Record<string, unknown> = {}) {
  return {
    id: "call-1",
    teamId: "team-1",
    contactId: "contact-1",
    status: "completed",
    // Host da Voopi: gravação de outro host nem é transcrita (S13).
    recordingUrl: "https://gravacoes.voopi.com.br/recording.mp3",
    transcript: null,
    direction: "outbound",
    phoneNumber: "+5511999999999",
    ...overrides,
  } as never;
}

describe("processTranscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignora se Call não existe", async () => {
    vi.mocked(basePrisma.call.findUnique).mockResolvedValue(null as never);
    await processTranscription("nonexistent");
    expect(updateCallTranscription).not.toHaveBeenCalled();
  });

  it("ignora se recordingUrl é null", async () => {
    vi.mocked(basePrisma.call.findUnique).mockResolvedValue(
      makeCall({ recordingUrl: null }) as never,
    );
    await processTranscription("call-1");
    expect(updateCallTranscription).not.toHaveBeenCalled();
  });

  it("ignora se status !== completed", async () => {
    vi.mocked(basePrisma.call.findUnique).mockResolvedValue(
      makeCall({ status: "ringing" }) as never,
    );
    await processTranscription("call-1");
    expect(updateCallTranscription).not.toHaveBeenCalled();
  });

  it("ignora se já tem transcript (idempotência)", async () => {
    vi.mocked(basePrisma.call.findUnique).mockResolvedValue(
      makeCall({ transcript: "Já transcrito" }) as never,
    );
    await processTranscription("call-1");
    expect(updateCallTranscription).not.toHaveBeenCalled();
  });

  it("transcreve e gera resumo para Call válida", async () => {
    vi.mocked(basePrisma.call.findUnique).mockResolvedValue(makeCall() as never);

    await processTranscription("call-1");

    expect(getTranscriptionProvider).toHaveBeenCalled();
    expect(generateSummary).toHaveBeenCalledWith("Olá, tudo bem? Sou da empresa X.");
    expect(updateCallTranscription).toHaveBeenCalledWith("call-1", {
      transcript: "Olá, tudo bem? Sou da empresa X.",
      summary: "Ligação de apresentação comercial.",
    });
    expect(publishRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "call:transcription-completed",
        callId: "call-1",
        contactId: "contact-1",
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith({ type: "dashboard:changed" });
  });

  it("sem serviço de transcrição: lança 'transcrição não configurada' e não grava nada", async () => {
    vi.mocked(basePrisma.call.findUnique).mockResolvedValue(makeCall() as never);
    vi.mocked(getTranscriptionProvider).mockReturnValueOnce({
      transcribe: vi.fn().mockRejectedValue(new TranscricaoNaoConfigurada()),
    });

    await expect(processTranscription("call-1")).rejects.toBeInstanceOf(TranscricaoNaoConfigurada);
    expect(generateSummary).not.toHaveBeenCalled();
    expect(updateCallTranscription).not.toHaveBeenCalled();
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("sem IA no time (resumo null): salva só a transcrição, sem placeholder", async () => {
    vi.mocked(basePrisma.call.findUnique).mockResolvedValue(makeCall() as never);
    vi.mocked(generateSummary).mockResolvedValueOnce(null);

    await processTranscription("call-1");

    expect(updateCallTranscription).toHaveBeenCalledWith("call-1", {
      transcript: "Olá, tudo bem? Sou da empresa X.",
    });
    expect(publishRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ type: "call:transcription-completed", summary: null }),
    );
  });
});
