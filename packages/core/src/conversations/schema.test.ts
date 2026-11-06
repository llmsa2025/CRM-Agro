import { describe, it, expect } from "vitest";
import { createChannelAccountSchema } from "./schema";

describe("createChannelAccountSchema", () => {
  // Caso válido: só identificadores não-secretos.
  it("aceita credentials com instance e number (não-secretos)", () => {
    const r = createChannelAccountSchema.safeParse({
      canal: "whatsapp",
      label: "WhatsApp comercial",
      provider: "evolution",
      credentials: { instance: "minha-instancia", number: "+5511999999999" },
    });
    expect(r.success).toBe(true);
  });

  // Defesa em profundidade: o schema REJEITA qualquer chave suspeita de segredo.
  // Mesmo que a action esteja morta hoje, isso impede persistência acidental
  // de apiKey/secret no banco Json se alguém ilhar o endpoint no futuro.
  const SECRET_CASES: Array<[string, Record<string, unknown>]> = [
    ["apiKey", { instance: "x", apiKey: "K" }],
    ["api_key (snake)", { instance: "x", api_key: "K" }],
    ["apiSecret", { instance: "x", apiSecret: "S" }],
    ["secret", { instance: "x", secret: "S" }],
    ["password", { instance: "x", password: "P" }],
    ["token", { instance: "x", token: "T" }],
    ["bearer", { instance: "x", bearer: "B" }],
    ["accessToken", { instance: "x", accessToken: "AT" }],
    ["refresh_token", { instance: "x", refresh_token: "RT" }],
  ];

  for (const [nome, creds] of SECRET_CASES) {
    it(`rejeita credentials com ${nome}`, () => {
      const r = createChannelAccountSchema.safeParse({
        canal: "whatsapp",
        label: "x",
        provider: "evolution",
        credentials: creds,
      });
      expect(r.success).toBe(false);
    });
  }

  it("rejeita label vazio", () => {
    const r = createChannelAccountSchema.safeParse({
      canal: "whatsapp",
      label: "",
      provider: "evolution",
      credentials: { instance: "x" },
    });
    expect(r.success).toBe(false);
  });

  it("rejeita canal inválido", () => {
    const r = createChannelAccountSchema.safeParse({
      canal: "telegram",
      label: "x",
      provider: "evolution",
      credentials: { instance: "x" },
    });
    expect(r.success).toBe(false);
  });
});
