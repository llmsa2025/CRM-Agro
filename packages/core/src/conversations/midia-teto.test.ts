import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { parseEvolutionInbound } from "@crmagro/channels";

/**
 * Item 3.1 (INT-14): mídia recebida acima do teto nem é baixada — a mensagem
 * entra com o aviso "veja no celular"; abaixo do teto, o Buffer baixado sobe
 * para o Storage sem cópia. Download e Storage mockados (nada sai para a rede).
 */
const baixar = vi.fn();
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  baixarMidiaEvolution: (...args: unknown[]) => baixar(...args),
}));
const subir = vi.fn();
vi.mock("../storage/service", async (original) => ({
  ...(await original<typeof import("../storage/service")>()),
  storageEnabled: () => true,
  uploadMedia: (...args: unknown[]) => subir(...args),
}));
vi.mock("../flows/queue", () => ({
  scheduleStep: vi.fn(),
  acordarPasso: vi.fn(),
  getFlowQueue: () => ({}),
}));

const { receiveInbound, avisoArquivoGrande } = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000003a8";
const sufixo = Math.random().toString(36).slice(2, 8);
const INSTANCIA = `midia-teto-${sufixo}`;
const NUMERO = "5565988884321";
const MB = 1024 * 1024;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Mídia teto (test)" } });
});

beforeEach(async () => {
  baixar.mockReset();
  subir.mockReset();
  const w = { teamId: TEAM };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: INSTANCIA, status: "connected" },
  });
});

function msg(id: string, media: { kind: "image" | "audio" | "doc"; mime: string; size?: number | null }, text: string | null = null) {
  return {
    from: NUMERO,
    fromMe: false,
    text,
    media: { fileName: null, ...media },
    providerMessageId: `${sufixo}-${id}`,
    timestamp: null,
    name: "Lead",
    instance: INSTANCIA,
  };
}

async function gravada(id: string) {
  return basePrisma.message.findFirstOrThrow({ where: { teamId: TEAM, providerMessageId: `${sufixo}-${id}` } });
}

describe("mídia recebida com teto (INT-14)", () => {
  it("o parser lê o fileLength (número, texto ou Long) como tamanho", () => {
    const corpo = (fileLength: unknown) => ({
      instance: INSTANCIA,
      data: {
        key: { remoteJid: `${NUMERO}@s.whatsapp.net`, id: "F1" },
        message: { videoMessage: { mimetype: "video/mp4", fileLength } },
      },
    });
    expect(parseEvolutionInbound(corpo(300 * MB))?.media?.size).toBe(300 * MB);
    expect(parseEvolutionInbound(corpo("5242880"))?.media?.size).toBe(5 * MB);
    expect(parseEvolutionInbound(corpo({ low: 5 * MB, high: 0, unsigned: true }))?.media?.size).toBe(5 * MB);
    expect(parseEvolutionInbound(corpo(undefined))?.media?.size).toBeNull();
  });

  it("vídeo de 300 MB: nem baixa; a mensagem leva o aviso e a prévia também", async () => {
    await receiveInbound(msg("v300", { kind: "doc", mime: "video/mp4", size: 300 * MB }));
    expect(baixar).not.toHaveBeenCalled();
    const m = await gravada("v300");
    expect(m.conteudo).toBe("[arquivo grande (300 MB): veja no celular]");
    expect(m.mediaPath).toBeNull();
    expect(m.tipo).toBe("doc");
    const conv = await basePrisma.conversation.findUniqueOrThrow({ where: { id: m.conversationId } });
    expect(conv.lastMessagePreview).toBe(avisoArquivoGrande(300 * MB));
  });

  it("tamanho desconhecido e o download passa do teto: legenda preservada + aviso", async () => {
    baixar.mockResolvedValue({ ok: false, motivo: "grande" });
    await receiveInbound(msg("doc", { kind: "doc", mime: "application/pdf", size: null }, "segue a proposta"));
    expect(baixar).toHaveBeenCalledTimes(1);
    const m = await gravada("doc");
    expect(m.conteudo).toBe("segue a proposta\n[arquivo grande: veja no celular]");
    expect(m.mediaPath).toBeNull();
  });

  it("dentro do teto: o Buffer baixado sobe para o Storage sem cópia", async () => {
    const bytes = Buffer.from("foto");
    baixar.mockResolvedValue({ ok: true, bytes, mime: "image/jpeg" });
    await receiveInbound(msg("foto", { kind: "image", mime: "image/jpeg", size: 4 }));
    expect(subir).toHaveBeenCalledTimes(1);
    expect(subir.mock.calls[0]?.[1]).toBe(bytes); // a mesma instância, não uma cópia
    const m = await gravada("foto");
    expect(m.mediaPath).toMatch(/\.jpeg$/);
    expect(m.conteudo).toBe("");
  });

  it("download estourou o prazo: aviso 'demorou demais: veja no celular' (antes caía em falha, sem aviso)", async () => {
    baixar.mockResolvedValue({ ok: false, motivo: "tempo" });
    await receiveInbound(msg("video", { kind: "doc", mime: "video/mp4", size: 12 * MB }, "olha a lavoura"));
    const m = await gravada("video");
    expect(m.conteudo).toBe("olha a lavoura\n[arquivo (12 MB) não baixado, demorou demais: veja no celular]");
    expect(m.mediaPath).toBeNull();
  });

  it("eco do celular (fromMe) e @lid: o download recebe a chave original", async () => {
    baixar.mockResolvedValue({ ok: false, motivo: "falha" });
    await receiveInbound({
      ...msg("eco", { kind: "image", mime: "image/jpeg", size: 10 }),
      fromMe: true,
      remoteJid: "123456789012345@lid",
    });
    expect(baixar).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: `${sufixo}-eco`, remoteJid: "123456789012345@lid", fromMe: true }),
    );
  });

  it("download falhou (Evolution fora): mensagem entra como mídia sem arquivo, sem aviso", async () => {
    baixar.mockResolvedValue({ ok: false, motivo: "falha" });
    await receiveInbound(msg("audio", { kind: "audio", mime: "audio/ogg", size: 20_000 }));
    const m = await gravada("audio");
    expect(m.tipo).toBe("audio");
    expect(m.mediaPath).toBeNull();
    expect(m.conteudo).toBe("");
    expect(subir).not.toHaveBeenCalled();
  });
});
