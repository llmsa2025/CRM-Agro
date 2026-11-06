import { describe, it, expect } from "vitest";
import { envSchema } from "@crmagro/config";

/**
 * `GOOGLE_AGENDA_LIBERADOS=` (vazio) no .env: é o estado "ninguém conecta" —
 * não pode derrubar o boot do web nem do worker num restart do pm2, e o texto
 * passa inteiro para `lerLiberados` (quem decide e-mail, time e `todos`).
 * Puro: só o schema.
 */
describe("env — GOOGLE_AGENDA_LIBERADOS", () => {
  const campo = envSchema.shape.GOOGLE_AGENDA_LIBERADOS;

  it("vazio, só espaços ou ausente = ausente (ninguém conecta), sem derrubar o boot", () => {
    expect(campo.safeParse("")).toEqual({ success: true, data: undefined });
    expect(campo.safeParse("   ")).toEqual({ success: true, data: undefined });
    expect(campo.safeParse(undefined)).toEqual({ success: true, data: undefined });
  });

  it("a lista passa como está (a leitura é do core)", () => {
    expect(campo.safeParse("ana@x.com, 00000000-0000-0000-0000-000000000001")).toEqual({
      success: true,
      data: "ana@x.com, 00000000-0000-0000-0000-000000000001",
    });
    expect(campo.safeParse("todos")).toEqual({ success: true, data: "todos" });
  });
});
