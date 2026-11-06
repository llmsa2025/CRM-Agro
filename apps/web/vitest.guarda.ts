import { problemaDoBancoDoApp } from "../../packages/config/src/mesmo-banco";

/**
 * Guarda da suíte (vitest globalSetup): se `DATABASE_URL_APP` (a URL do papel `crmagro_app`) existir e
 * apontar para um banco diferente de `DATABASE_URL`, a suíte aborta ANTES de rodar (ver a do core).
 */
export default function setup() {
  const problema = problemaDoBancoDoApp({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_APP: process.env.DATABASE_URL_APP,
    DATABASE_URL_APP_WORKER: process.env.DATABASE_URL_APP_WORKER,
  });
  if (problema) throw new Error(`[guarda de teste] ${problema}`);
}
