import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pixel de abertura de e-mail: rota PÚBLICA e anônima. Só um UUID chega ao banco, e o pixel SEMPRE
 * responde (nunca quebra a renderização do e-mail do destinatário), mesmo com o banco fora.
 */
const markEmailOpened = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => null));
vi.mock("@crmagro/core", () => ({ markEmailOpened }));

const { GET } = await import("./route");

const pedir = (id: string, ua = "Mozilla/5.0") =>
  GET(new Request(`http://x/api/email/track/${id}`, { headers: { "user-agent": ua } }), { params: Promise.resolve({ id }) });

beforeEach(() => markEmailOpened.mockClear());

describe("GET /api/email/track/[id]", () => {
  it("UUID: marca a abertura e devolve o GIF", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const r = await pedir(id);
    expect(markEmailOpened).toHaveBeenCalledWith(id, { userAgent: "Mozilla/5.0" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/gif");
  });

  it("id que não é UUID (lixo, sondagem, texto enorme): devolve o GIF e NÃO consulta o banco", async () => {
    for (const ruim of ["x", "123", "../../etc/passwd", "'; DROP TABLE \"Message\"; --", "a".repeat(5000), "123e4567-e89b-42d3-a456-42661417400", ""]) {
      const r = await pedir(ruim);
      expect(r.status, ruim.slice(0, 20)).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/gif");
    }
    expect(markEmailOpened).not.toHaveBeenCalled();
  });

  it("o banco falhando não quebra o pixel", async () => {
    markEmailOpened.mockRejectedValueOnce(new Error("banco fora"));
    const r = await pedir("123e4567-e89b-42d3-a456-426614174000");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/gif");
  });

  it("nunca cacheia (cada abertura precisa chegar ao servidor)", async () => {
    const r = await pedir("123e4567-e89b-42d3-a456-426614174000");
    expect(r.headers.get("cache-control")).toContain("no-store");
  });
});
