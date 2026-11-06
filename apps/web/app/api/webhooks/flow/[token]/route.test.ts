import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/webhooks/flow/[token]: rota PÚBLICA, o token na URL é o segredo. O que esta prova garante, com os
 * serviços trocados por falsos (a regra de verdade, com banco, está em packages/core/src/flows/webhook-hash.test.ts):
 *  - o token NUNCA entra em chave de limite (a chave vai para o Redis e, com o Redis fora, para o log de aviso);
 *  - a resposta é só `{ ok: true }` (sem id de contato) e nenhuma resposta ecoa o token;
 *  - nada é logado.
 */
const h = vi.hoisted(() => ({
  rateLimit: vi.fn(async (..._a: unknown[]) => ({ allowed: true, remaining: 1, retryAfterMs: 0 })),
  enrollByWebhook: vi.fn(async (..._a: unknown[]): Promise<{ ok: boolean; contactId?: string; error?: string }> => ({ ok: true, contactId: "contato-que-nao-pode-vazar" })),
}));
vi.mock("@crmagro/core", () => ({
  rateLimit: (...a: unknown[]) => h.rateLimit(...a),
  enrollByWebhook: (...a: unknown[]) => h.enrollByWebhook(...a),
  parseWebhookLead: (corpo: unknown) => ({ ok: true, data: corpo }),
  // Mesmo formato do core (webhook-token.ts): hash cortado, nunca o token.
  chaveDoLimiteDoWebhook: (token: string) => `flowhook:t:${createHash("sha256").update(token.slice(0, 256), "utf8").digest("hex").slice(0, 32)}`,
}));

const { POST } = await import("./route");

const TOKEN = "tokdarotadoweb-tokdarotadoweb-tokdar01";
const pedir = (token = TOKEN, ip = "200.10.20.30") =>
  POST(
    new Request(`https://app.crmagro.example/api/webhooks/flow/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ telefone: "11999998888" }),
    }),
    { params: Promise.resolve({ token }) },
  );

beforeEach(() => {
  h.rateLimit.mockClear();
  h.enrollByWebhook.mockClear();
  h.rateLimit.mockImplementation(async () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }));
  h.enrollByWebhook.mockImplementation(async () => ({ ok: true, contactId: "contato-que-nao-pode-vazar" }));
});

describe("POST /api/webhooks/flow/[token]", () => {
  it("nenhuma chave de limite (Redis) contém o token: o limite por token usa o hash, o do IP usa o IP", async () => {
    await pedir();
    const chaves = h.rateLimit.mock.calls.map((c) => String(c[0]));
    expect(chaves).toHaveLength(2);
    expect(chaves.some((k) => k.includes(TOKEN))).toBe(false);
    expect(chaves[0]).toBe("flowhook:ip:200.10.20.30");
    expect(chaves[1]).toMatch(/^flowhook:t:[0-9a-f]{32}$/);
    // Estável: o mesmo token cai sempre no mesmo balde.
    await pedir();
    expect(String(h.rateLimit.mock.calls[3]![0])).toBe(chaves[1]);
  });

  it("o serviço recebe o token (é o que ele procura pelo hash) e a resposta é só { ok: true }, sem id de contato", async () => {
    const r = await pedir();
    expect(h.enrollByWebhook).toHaveBeenCalledWith(TOKEN, { telefone: "11999998888" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("limite estourado: 429 sem o token na resposta, e não chega ao serviço", async () => {
    h.rateLimit.mockImplementation(async (...a: unknown[]) => ({ allowed: !String(a[0]).startsWith("flowhook:t:"), remaining: 0, retryAfterMs: 5000 }));
    const r = await pedir();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(JSON.stringify(await r.json())).not.toContain(TOKEN);
    expect(h.enrollByWebhook).not.toHaveBeenCalled();
  });

  it("token sem fluxo: 404 sem ecoar o token", async () => {
    h.enrollByWebhook.mockResolvedValueOnce({ ok: false, error: "nenhum fluxo ativo com gatilho Webhook para este token" });
    const r = await pedir();
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toContain(TOKEN);
  });

  it("não loga nada (nem o token): o caminho feliz e o de erro ficam em silêncio", async () => {
    const saidas = (["log", "info", "warn", "error", "debug"] as const).map((n) => vi.spyOn(console, n).mockImplementation(() => undefined));
    await pedir();
    h.enrollByWebhook.mockResolvedValueOnce({ ok: false, error: "nenhum fluxo ativo com gatilho Webhook para este token" });
    await pedir();
    expect(JSON.stringify(saidas.flatMap((s) => s.mock.calls))).not.toContain(TOKEN);
    vi.restoreAllMocks();
  });

  it("token enorme: a chave de limite continua curta (não guarda o texto)", async () => {
    const enorme = "a".repeat(5000);
    await pedir(enorme);
    const chave = String(h.rateLimit.mock.calls[1]![0]);
    expect(chave.length).toBeLessThan(60);
    expect(chave).not.toContain("aaaaaaaa");
  });
});
