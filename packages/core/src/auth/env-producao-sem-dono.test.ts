import { describe, it, expect } from "vitest";
import { envSchema } from "@crmagro/config";

/**
 * Produção (VPS e Vercel) sobe SEM a credencial de dono e sem o banco de teste: `DIRECT_URL`,
 * `DATABASE_URL_TEST`, `DIRECT_URL_TEST` e `DEV_TEAM_ID` são opcionais. Antes eram obrigatórias e
 * forçariam a URL de dono para dentro da Vercel.
 * Puro: só o schema.
 */
const minimo = {
  DATABASE_URL: "postgresql://crmagro_sistema:x@pooler.exemplo.com:6543/postgres?pgbouncer=true",
  REDIS_URL: "rediss://default:x@redis.exemplo.com:6379",
  AUTH_SECRET: "a".repeat(32),
  CREDENTIALS_ENCRYPTION_KEY: "b".repeat(32),
  EVOLUTION_API_URL: "https://evolution.exemplo.com",
  EVOLUTION_API_KEY: "chave",
  EVOLUTION_INSTANCE: "instancia",
};

describe("env — produção sem a credencial de dono", () => {
  it("sobe só com o mínimo: sem DIRECT_URL, sem *_TEST e sem DEV_TEAM_ID", () => {
    const r = envSchema.safeParse(minimo);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.DIRECT_URL).toBeUndefined();
      expect(r.data.DATABASE_URL_TEST).toBeUndefined();
      expect(r.data.DIRECT_URL_TEST).toBeUndefined();
      expect(r.data.DEV_TEAM_ID).toBeUndefined();
    }
  });

  it("chave vazia no .env (`CHAVE=`) conta como ausente, sem derrubar o boot", () => {
    const r = envSchema.safeParse({ ...minimo, DIRECT_URL: "", DATABASE_URL_TEST: "  ", DIRECT_URL_TEST: "", DEV_TEAM_ID: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.DIRECT_URL).toBeUndefined();
      expect(r.data.DEV_TEAM_ID).toBeUndefined();
    }
  });

  it("quando vêm preenchidas, continuam valendo: URL malformada ainda é recusada", () => {
    expect(envSchema.safeParse({ ...minimo, DIRECT_URL: "isto-nao-e-url" }).success).toBe(false);
    expect(envSchema.safeParse({ ...minimo, DATABASE_URL_TEST: "isto-nao-e-url" }).success).toBe(false);
    const ok = envSchema.safeParse({
      ...minimo,
      DIRECT_URL: "postgresql://postgres:x@db.exemplo.com:5432/postgres",
      DEV_TEAM_ID: "00000000-0000-0000-0000-000000000001",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.DEV_TEAM_ID).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("o que o app usa de verdade continua obrigatório", () => {
    for (const chave of Object.keys(minimo) as (keyof typeof minimo)[]) {
      const resto = Object.fromEntries(Object.entries(minimo).filter(([k]) => k !== chave));
      const r = envSchema.safeParse(resto);
      expect(r.success, `${chave} deveria ser obrigatória`).toBe(false);
    }
  });
});
