import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Item 3.1 (INT-15, INT-14): toda chamada externa sai com `AbortSignal` (teto de
 * tempo) e o download de mídia tem teto de tamanho, lido em pedaços. Nada sai
 * para a rede: o `fetch` global é trocado por um gravador.
 */
vi.mock("@crmagro/config", async (original) => {
  const real = await original<typeof import("@crmagro/config")>();
  return {
    ...real,
    env: { ...real.env, SUPABASE_URL: "https://storage.teste", SUPABASE_SERVICE_ROLE_KEY: "chave-teste" },
  };
});

const {
  createEvolutionInstance,
  setEvolutionWebhook,
  deleteEvolutionInstance,
  getEvolutionQR,
  VoopiProvider,
  baixarMidiaEvolution,
  lerCorpoComLimite,
} = await import("@crmagro/channels");
const { fetchCnpj, CnpjLookupFailed } = await import("@crmagro/captation");
const { uploadMedia, deleteMedia, uploadTimeoutMs } = await import("../storage/service");
const { WhisperTranscriptionProvider } = await import("../calls/transcription-provider");

type Chamada = { url: string; init: RequestInit | undefined };

/** Troca o fetch global: grava cada chamada e responde com `resposta(url)`. */
function gravarFetch(resposta: (url: string) => Response | Promise<Response> = () => Response.json({})) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    return resposta(String(url));
  });
  return chamadas;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toda chamada externa tem teto de tempo (INT-15)", () => {
  it("Evolution (onboarding), Voopi, Storage e transcrição", async () => {
    const chamadas = gravarFetch((url) =>
      url.includes("click-to-call") ? Response.json({ callId: "c1" }) : Response.json({ text: "ok" }),
    );
    const evo = { apiUrl: "https://evo.teste", apiKey: "k", instance: "i" };
    await createEvolutionInstance(evo);
    await setEvolutionWebhook({ ...evo, url: "https://app.teste/api/webhooks/whatsapp" });
    await deleteEvolutionInstance(evo); // logout + delete
    await getEvolutionQR(evo);
    const voopi = new VoopiProvider({
      sipHost: "sip.voopi.com.br",
      sipPort: "5060",
      sipUser: "u",
      sipPassword: "p",
      webhookUrl: "https://app.teste/api/webhooks/voopi",
    });
    await voopi.makeCall({ to: "+5565999990000" });
    await voopi.hangup("c1");
    await uploadMedia("conv/a.jpg", Buffer.from("abc"), "image/jpeg");
    await deleteMedia("conv/a.jpg");
    await new WhisperTranscriptionProvider({ url: "https://whisper.teste", model: "base", language: "pt" }).transcribe(
      "https://audio.teste/a.mp3",
    );
    // O resumo por IA passou a usar a IA do time (`chamarIa`, com teto) — 3.6,
    // coberto em `calls/resumo-ia.test.ts`.

    expect(chamadas).toHaveLength(10);
    const semTeto = chamadas.filter((c) => !(c.init?.signal instanceof AbortSignal)).map((c) => c.url);
    expect(semTeto).toEqual([]);
  });

  it("upload: 30 s + 1 s por MB", () => {
    expect(uploadTimeoutMs(0)).toBe(30_000);
    expect(uploadTimeoutMs(25 * 1024 * 1024)).toBe(55_000);
  });

  it("CNPJ: CNPJá presa → tenta a BrasilAPI; as duas presas → CnpjLookupFailed nomeado", async () => {
    const tempo = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const chamadas = gravarFetch((url) =>
      url.includes("cnpja") ? tempo() : Response.json({ razao_social: "Fazenda Boa Vista LTDA", uf: "MT" }),
    );
    const r = await fetchCnpj("11.222.333/0001-81");
    expect(r.razaoSocial).toBe("Fazenda Boa Vista LTDA");
    expect(chamadas.map((c) => c.init?.signal instanceof AbortSignal)).toEqual([true, true]);

    gravarFetch(() => tempo());
    await expect(fetchCnpj("11.222.333/0001-81")).rejects.toBeInstanceOf(CnpjLookupFailed);
    await expect(fetchCnpj("11.222.333/0001-81")).rejects.toThrow(/tempo esgotado/);
  });
});

/** Resposta em pedaços, sem content-length (como um chunked de verdade). */
function respostaEmPedacos(pedacos: string[]): Response {
  const enc = new TextEncoder();
  const corpo = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pedacos) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(corpo);
}

describe("mídia recebida com teto de tamanho (INT-14)", () => {
  it("lerCorpoComLimite: para ao passar do teto, mesmo sem content-length", async () => {
    expect((await lerCorpoComLimite(respostaEmPedacos(["abc", "def"]), 10))?.toString()).toBe("abcdef");
    expect(await lerCorpoComLimite(respostaEmPedacos(["abcdef", "ghijkl"]), 10)).toBeNull();
    const declarada = new Response("x".repeat(20), { headers: { "content-length": "20" } });
    expect(await lerCorpoComLimite(declarada, 10)).toBeNull();
  });

  it("baixarMidiaEvolution: devolve o Buffer; acima do teto → grande; erro → falha", async () => {
    const arquivo = Buffer.from("conteúdo da foto");
    const chamadas = gravarFetch(() => Response.json({ base64: arquivo.toString("base64"), mimetype: "image/jpeg" }));
    const ok = await baixarMidiaEvolution({ providerMessageId: "M1", from: "+5565999990000", instance: "i" });
    expect(ok).toEqual({ ok: true, bytes: arquivo, mime: "image/jpeg" });
    expect(Buffer.isBuffer(ok.ok && ok.bytes)).toBe(true);
    expect(chamadas[0]?.init?.signal instanceof AbortSignal).toBe(true);

    // 3 KB de arquivo com teto de 1 KB: a leitura para no meio.
    gravarFetch(() => respostaEmPedacos([JSON.stringify({ base64: Buffer.alloc(3072, 7).toString("base64") })]));
    expect(await baixarMidiaEvolution({ providerMessageId: "M2", from: "+5565999990000" }, 1024)).toEqual({
      ok: false,
      motivo: "grande",
    });

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await baixarMidiaEvolution({ providerMessageId: "M3", from: "+5565999990000" })).toEqual({
      ok: false,
      motivo: "falha",
    });
  });

  it("a chave do download vai como veio no webhook: @lid e fromMe (sugestão do auditor no #91)", async () => {
    const chamadas = gravarFetch(() => Response.json({ base64: "YQ==", mimetype: "image/jpeg" }));
    await baixarMidiaEvolution({
      providerMessageId: "ECO1",
      from: "+5565999990000",
      instance: "i",
      remoteJid: "123456789012345@lid",
      fromMe: true,
    });
    await baixarMidiaEvolution({ providerMessageId: "IN1", from: "+5565999990000", instance: "i" });
    const chaves = chamadas.map((c) => (JSON.parse(String(c.init?.body)) as { message: { key: unknown } }).message.key);
    expect(chaves).toEqual([
      { id: "ECO1", remoteJid: "123456789012345@lid", fromMe: true },
      { id: "IN1", remoteJid: "5565999990000@s.whatsapp.net", fromMe: false },
    ]);
  });

  it("prazo estourado → 'tempo' (antes dos cabeçalhos ou no meio do corpo), não 'falha'", async () => {
    const entrada = { providerMessageId: "T1", from: "+5565999990000" };
    // Evolution não responde (ainda baixando do WhatsApp).
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
      new Promise<Response>((_ok, erro) => init?.signal?.addEventListener("abort", () => erro(init.signal!.reason))),
    );
    expect(await baixarMidiaEvolution(entrada, 1024 * 1024, 50)).toEqual({ ok: false, motivo: "tempo" });

    // Respondeu, mas o corpo parou no meio (o fetch real liga o prazo ao corpo).
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const corpo = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"base64":"AAAA'));
          init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
        },
      });
      return new Response(corpo);
    });
    expect(await baixarMidiaEvolution(entrada, 1024 * 1024, 50)).toEqual({ ok: false, motivo: "tempo" });
  });

  it("no máximo 2 downloads ao mesmo tempo por processo", async () => {
    let ativos = 0;
    let pico = 0;
    const liberar: Array<() => void> = [];
    vi.stubGlobal("fetch", async () => {
      ativos++;
      pico = Math.max(pico, ativos);
      await new Promise<void>((r) => liberar.push(r));
      ativos--;
      return Response.json({ base64: "YQ==", mimetype: "text/plain" });
    });
    const downloads = [1, 2, 3, 4, 5].map((i) =>
      baixarMidiaEvolution({ providerMessageId: `P${i}`, from: "+5565999990000" }),
    );
    // Solta um de cada vez até todos terminarem.
    while (liberar.length || ativos) {
      await new Promise((r) => setTimeout(r, 5));
      liberar.shift()?.();
    }
    const r = await Promise.all(downloads);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(pico).toBe(2);
  });
});
