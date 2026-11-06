import { describe, it, expect } from "vitest";
import { envSchema } from "@crmagro/config";

/**
 * `CADASTRO_EMPRESA=` e `CADASTRO_EMPRESA_SENHA=` (vazios) no .env: o doc diz
 * "vazio = automático" — antes, o `z.enum` recusava a string vazia e o web e o
 * worker não subiam ("Env inválido") num restart do pm2. Puro: só o schema.
 */
describe("env — chaves do cadastro de empresa", () => {
  for (const chave of ["CADASTRO_EMPRESA", "CADASTRO_EMPRESA_SENHA"] as const) {
    const campo = envSchema.shape[chave];

    it(`${chave}: vazio (ou só espaços) = ausente, sem derrubar o boot`, () => {
      expect(campo.safeParse("")).toEqual({ success: true, data: undefined });
      expect(campo.safeParse("   ")).toEqual({ success: true, data: undefined });
      expect(campo.safeParse(undefined)).toEqual({ success: true, data: undefined });
    });

    it(`${chave}: "on" e "off" valem; outro valor continua recusado`, () => {
      expect(campo.safeParse("on")).toEqual({ success: true, data: "on" });
      expect(campo.safeParse("off")).toEqual({ success: true, data: "off" });
      expect(campo.safeParse("sim").success).toBe(false);
    });
  }
});
