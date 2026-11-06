import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Testes do web: regras puras de tela e as rotas da API com os serviços trocados por falsos
// (sem DOM e sem banco). O alias "@" é o mesmo do tsconfig, para as rotas resolverem "@/lib/...".
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "lib/**/*.test.ts"],
    // Aborta a suíte se DATABASE_URL_APP apontar para outro banco que DATABASE_URL. Ver vitest.guarda.ts.
    globalSetup: ["./vitest.guarda.ts"],
  },
});
