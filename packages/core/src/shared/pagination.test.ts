import { describe, it, expect } from "vitest";
import { applyCursor, buildResult, cursorPaginationSchema } from "./pagination";

describe("pagination — applyCursor", () => {
  it("sem cursor: busca limit+1, skip 0, sem cursor (primeira página)", () => {
    expect(applyCursor({ limit: 50 })).toEqual({ take: 51, skip: 0 });
  });

  it("com cursor: busca limit+1, skip 1 (pula a âncora) e ancora no id", () => {
    expect(applyCursor({ cursor: "abc", limit: 20 })).toEqual({
      take: 21,
      skip: 1,
      cursor: { id: "abc" },
    });
  });

  it("limit ausente cai no default (50)", () => {
    expect(applyCursor({} as { cursor?: string; limit?: number })).toEqual({ take: 51, skip: 0 });
  });
});

describe("pagination — buildResult", () => {
  const row = (id: string) => ({ id, nome: `n-${id}` });

  it("veio a linha extra → hasMore=true, descarta sentinela, nextCursor = último da página", () => {
    // limit 2, vieram 3 (limit+1)
    const res = buildResult([row("a"), row("b"), row("c")], 2);
    expect(res.items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe("b");
  });

  it("não veio linha extra → hasMore=false, nextCursor=null (fim)", () => {
    const res = buildResult([row("a"), row("b")], 2);
    expect(res.items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  it("página vazia → sem mais resultados", () => {
    const res = buildResult([], 2);
    expect(res.items).toEqual([]);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });
});

describe("pagination — cursorPaginationSchema", () => {
  it("aplica limit default e aceita cursor opcional", () => {
    expect(cursorPaginationSchema.parse({})).toEqual({ limit: 50 });
    const uuid = "00000000-0000-0000-0000-000000000001";
    expect(cursorPaginationSchema.parse({ cursor: uuid, limit: "10" })).toEqual({
      cursor: uuid,
      limit: 10,
    });
  });

  it("rejeita limit fora de [1,100] e cursor não-uuid", () => {
    expect(() => cursorPaginationSchema.parse({ limit: 0 })).toThrow();
    expect(() => cursorPaginationSchema.parse({ limit: 101 })).toThrow();
    expect(() => cursorPaginationSchema.parse({ cursor: "not-a-uuid" })).toThrow();
  });
});
