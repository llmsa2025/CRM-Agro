import { describe, expect, it, vi } from "vitest";

/**
 * /api/calls (F1A-08): a rota só LÊ. Não existe POST de ligação: o Next responde 405 a todo método que o
 * `route.ts` não exporta. O GET segue listando (serviço trocado por falso; a regra está no core).
 */
const h = vi.hoisted(() => ({ listar: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ items: [], nextCursor: null, hasMore: false })) }));

vi.mock("@crmagro/db", () => ({ runWithTeam: (_teamId: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/tenant", () => ({
  currentUser: async () => ({ id: "u1", teamId: "t1", role: "member" }),
  identidade: () => ({ userId: "u1", role: "member" }),
}));
vi.mock("@crmagro/core", async () => {
  const { callStatusSchema } = await import("../../../../../packages/core/src/calls/schema");
  const { cursorPaginationSchema } = await import("../../../../../packages/core/src/shared/pagination");
  return { callStatusSchema, cursorPaginationSchema, listCalls: (...a: unknown[]) => h.listar(...a) };
});

const rota = await import("./route");

describe("/api/calls", () => {
  it("só exporta GET: POST, PUT, PATCH e DELETE não existem (405)", () => {
    expect(Object.keys(rota).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(["GET"]);
  });

  it("GET lista as ligações pelo serviço", async () => {
    const r = await rota.GET(new Request("https://app.crmagro.example/api/calls?status=completed&limit=10"));
    expect(r.status).toBe(200);
    expect(h.listar).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", limit: 10 }));
  });
});
