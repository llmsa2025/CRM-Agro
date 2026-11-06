import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

/**
 * Item 3.6 (INT-22): o resumo da ligação usa a IA DO TIME (BYOK), nunca a chave
 * do operador, e não grava placeholder. As chaves do time são mockadas e o
 * `fetch` global é trocado — nada sai para a rede.
 */
const chaves: Record<string, string | null> = {};
const governanca = { modo: "suggest" as string };
vi.mock("../integrations/service", () => ({
  getAiApiKey: async (p: string) => chaves[p] ?? null,
  getAiMode: async () => governanca.modo,
}));

const { generateSummary } = await import("./transcription-provider");
const { transcricaoJobId } = await import("./transcription-queue");

type Chamada = { url: string; init?: RequestInit };
let chamadas: Chamada[] = [];

beforeEach(() => {
  chamadas = [];
  for (const k of Object.keys(chaves)) delete chaves[k];
  governanca.modo = "suggest";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function responder(fn: (url: string) => Response) {
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init });
    return fn(String(url));
  });
}

describe("resumo da ligação pela IA do time (INT-22)", () => {
  it("sem IA conectada no time → null, sem chamada nenhuma (mesmo com a chave do operador no ambiente)", async () => {
    const antes = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "chave-do-operador";
    try {
      responder(() => Response.json({}));
      expect(await generateSummary("cliente pediu proposta")).toBeNull();
      expect(chamadas).toHaveLength(0);
    } finally {
      if (antes === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = antes;
    }
  });

  it("IA do time DESLIGADA (governança \"off\") → null e nada sai, mesmo com a chave conectada", async () => {
    chaves.anthropic = "chave-do-time";
    governanca.modo = "off";
    responder(() => Response.json({ content: [{ type: "text", text: "não devia" }] }));
    expect(await generateSummary("cliente pediu proposta")).toBeNull();
    expect(chamadas).toHaveLength(0);
  });

  it("com a chave do time: resume por ela, com teto de tempo", async () => {
    chaves.anthropic = "chave-do-time";
    responder(() => Response.json({ content: [{ type: "text", text: "Pediu proposta para 200 ha." }] }));
    expect(await generateSummary("cliente pediu proposta para 200 ha")).toBe("Pediu proposta para 200 ha.");
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toContain("api.anthropic.com");
    expect((chamadas[0]!.init?.headers as Record<string, string>)["x-api-key"]).toBe("chave-do-time");
    expect(chamadas[0]!.init?.signal instanceof AbortSignal).toBe(true);
  });

  it("IA fora do ar (todos os provedores) → null, nada de \"[Erro ao gerar resumo…]\" gravado", async () => {
    chaves.anthropic = "a";
    chaves.glm = "g";
    responder(() => new Response("indisponível", { status: 503 }));
    expect(await generateSummary("texto")).toBeNull();
    expect(chamadas).toHaveLength(2); // tentou os dois
  });
});

describe("fila de transcrição", () => {
  it("jobId sem ':' — o BullMQ recusava `transcribe:<id>` e nenhuma ligação era transcrita", () => {
    const id = transcricaoJobId("5f2c7a4e-1111-2222-3333-444455556666");
    expect(id).toBe("transcribe_5f2c7a4e-1111-2222-3333-444455556666");
    // Mesma regra do BullMQ (Job.validateOptions): ":" só com exatamente 3 partes.
    expect(id.includes(":") && id.split(":").length !== 3).toBe(false);
  });
});
