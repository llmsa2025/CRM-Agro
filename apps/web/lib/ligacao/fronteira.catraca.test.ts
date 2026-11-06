import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Catraca da fronteira de `apps/web/lib/ligacao/`.
 *
 * Esta pasta roda NO NAVEGADOR e é lógica pura, testada sem DOM. Por isso:
 *  - nenhum valor do `@crmagro/*` (o barrel do core arrasta bullmq e ioredis para o bundle do navegador); só `import type`;
 *  - nada Node-only (`node:*`, bullmq, ioredis...), nada de React nem de Next, nada de `components/` nem de `app/`;
 *  - nenhuma variável `NEXT_PUBLIC_` (o modo Fake vem do servidor) e nenhum `process.env`;
 *  - nenhum travessão nem meia-risca em arquivo nenhum (AGENTS.md (texto da interface)).
 * Quebrou? É de propósito: mova a lógica para o lugar certo em vez de afrouxar a regra.
 */
const RAIZ = __dirname;

function arquivos(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) achados.push(...arquivos(caminho));
    else if (nome.endsWith(".ts") || nome.endsWith(".tsx")) achados.push(caminho);
  }
  return achados;
}

/** Travessão (U+2014) e meia-risca (U+2013), montados por código para este arquivo não conter o próprio caractere. */
const TRAVESSOES = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);

const todos = arquivos(RAIZ);
const deProducao = todos.filter((f) => !/\.test\.tsx?$/.test(f));
const nome = (f: string) => relative(RAIZ, f).replace(/\\/g, "/");

const PROIBIDOS_EM_QUALQUER_IMPORT = [/^node:/, /^(fs|path|os|child_process|crypto|net|http|https|stream|util)$/, /^(bullmq|ioredis|nodemailer|imapflow|mailparser|playwright|playwright-core)$/, /^react(-dom)?(\/|$)/, /^next(\/|$)/, /^@\/(components|app)(\/|$)/, /^\.{1,2}\/(?:.*\/)?(components|app)(\/|$)/];

/** Cada `import ... from "x"`, `import "x"`, `import("x")`, `require("x")` e `export ... from "x"`, com o trecho antes do `from`. */
function importacoes(fonte: string): { antes: string; modulo: string }[] {
  const achadas: { antes: string; modulo: string }[] = [];
  for (const m of fonte.matchAll(/\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) achadas.push({ antes: (m[1] ?? "").trim(), modulo: m[2] ?? "" });
  // Reexportação também puxa o módulo: `export * from "x"`, `export * as n from "x"`, `export { a } from "x"`, `export type { T } from "x"`.
  for (const m of fonte.matchAll(/\bexport\s+((?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}))\s+from\s+["']([^"']+)["']/g)) achadas.push({ antes: (m[1] ?? "").trim(), modulo: m[2] ?? "" });
  for (const m of fonte.matchAll(/\bimport\s+["']([^"']+)["']/g)) achadas.push({ antes: "", modulo: m[1] ?? "" });
  for (const m of fonte.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) achadas.push({ antes: "(dinamico)", modulo: m[1] ?? "" });
  for (const m of fonte.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) achadas.push({ antes: "(require)", modulo: m[1] ?? "" });
  return achadas;
}

describe("fronteira de apps/web/lib/ligacao", () => {
  it("a pasta tem arquivos de produção para conferir", () => {
    expect(deProducao.length).toBeGreaterThanOrEqual(8);
    expect(todos.some((f) => nome(f) === "motor.ts")).toBe(true);
  });

  it("só `import type` do @crmagro/*", () => {
    const furos: string[] = [];
    for (const f of deProducao) {
      for (const { antes, modulo } of importacoes(readFileSync(f, "utf8"))) {
        if (!modulo.startsWith("@crmagro/")) continue;
        if (antes.startsWith("type ")) continue;
        furos.push(`${nome(f)} importa valor de ${modulo}`);
      }
    }
    expect(furos).toEqual([]);
  });

  it("nada Node-only, React, Next nem componente", () => {
    const furos: string[] = [];
    for (const f of deProducao) {
      for (const { modulo } of importacoes(readFileSync(f, "utf8"))) {
        if (PROIBIDOS_EM_QUALQUER_IMPORT.some((re) => re.test(modulo))) furos.push(`${nome(f)} importa ${modulo}`);
      }
    }
    expect(furos).toEqual([]);
  });

  it("sem NEXT_PUBLIC_ nem process.env", () => {
    const furos: string[] = [];
    for (const f of deProducao) {
      const fonte = readFileSync(f, "utf8");
      if (/NEXT_PUBLIC_/.test(fonte)) furos.push(`${nome(f)} usa NEXT_PUBLIC_`);
      if (/process\.env/.test(fonte)) furos.push(`${nome(f)} usa process.env`);
    }
    expect(furos).toEqual([]);
  });

  it("nenhum arquivo, nem comentário, tem travessão ou meia-risca", () => {
    const furos = todos.filter((f) => TRAVESSOES.test(readFileSync(f, "utf8"))).map(nome);
    expect(furos).toEqual([]);
  });

  it("o leitor de importações enxerga os jeitos de importar e de reexportar", () => {
    const amostra = [
      'import { a } from "x1";',
      'import type { B } from "x2";',
      'import "x3";',
      'const c = await import("x4");',
      'const d = require("x5");',
      "import {\n  e,\n  f,\n} from 'x6';",
      'export * from "x7";',
      'export type { T } from "x8";',
      'export { v } from "x9";',
      'export * as ns from "x10";',
      "export const k = 1;\nimport type { Z } from 'x11';",
    ].join("\n");
    const achadas = importacoes(amostra);
    expect(achadas.map((i) => i.modulo).sort()).toEqual(["x1", "x10", "x11", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9"]);
    expect(achadas.find((i) => i.modulo === "x2")?.antes.startsWith("type ")).toBe(true);
    // Reexportar valor não pode passar por `import type`: só `export type` é de tipo.
    expect(achadas.find((i) => i.modulo === "x7")?.antes.startsWith("type ")).toBe(false);
    expect(achadas.find((i) => i.modulo === "x8")?.antes.startsWith("type ")).toBe(true);
    expect(achadas.find((i) => i.modulo === "x9")?.antes.startsWith("type ")).toBe(false);
    // Um `export` solto antes de um `import type` não contamina o import.
    expect(achadas.find((i) => i.modulo === "x11")?.antes.startsWith("type ")).toBe(true);
  });

  it("a lista de proibidos pega componente e rota por caminho relativo, e deixa os vizinhos passarem", () => {
    const barra = (modulo: string) => PROIBIDOS_EM_QUALQUER_IMPORT.some((re) => re.test(modulo));
    for (const ruim of ["../../components/ligacao/barra", "../components/x", "../../app/ligacoes/x", "./app", "@/components/ui/button", "@/app/x", "react", "next/navigation", "node:fs"]) {
      expect(barra(ruim), ruim).toBe(true);
    }
    for (const bom of ["./estado", "./motores/fake", "../ligacao-selo", "../format/data", "@crmagro/core", "vitest"]) {
      expect(barra(bom), bom).toBe(false);
    }
  });
});
