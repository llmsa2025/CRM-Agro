import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CATRACA do selo do token de administrador da telefonia (F2-25). Estática, sem banco: pega o padrão de
 * código, não a intenção.
 *
 * O que ela garante:
 * 1. `abrirNoWorker` só aparece no `selo.ts`, em `apps/worker/` e nos módulos de job de `calls/telefonia/` listados
 *    abaixo. NUNCA em `apps/web/` (nem em teste de lá).
 * 2. O nome da variável da chave privada (`TELEFONIA_CHAVE_PRIVADA`, também com o prefixo `VPS_` e o sufixo
 *    `_ANTERIOR`) só aparece nos arquivos do caminho do worker (workflow, receiver, script do worker, gerador do par). Em
 *    especial: nenhum arquivo do site, nenhum workflow da Vercel, nenhum `next.config` o cita. Se o site citar, a chave
 *    pode acabar no pacote do navegador.
 * 3. Ninguém reexporta o `selo.ts` inteiro por um barril (`export * from "./selo"`), que levaria `abrirNoWorker` para o
 *    `@crmagro/core` e, por ele, para o site.
 * 4. O `package.json` do core não abre um subcaminho para `calls/telefonia`.
 *
 * Módulo novo de job que precisa abrir o token (F2-07 em diante): acrescente o caminho em `JOBS_QUE_ABREM` NO MESMO PR,
 * para o revisor ver. Teste e `.md` não contam (não vão para produção).
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const IGNORAR = new Set(["node_modules", ".next", "dist", "coverage", ".git"]);
/** Só na raiz do repositório: `docs/` é texto. */
const IGNORAR_PELO_CAMINHO = new Set(["docs", "apps/web-preview"]);
const EXTENSOES = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|ya?ml|sh)$/;

/** Módulos de job de `packages/core/src/calls/telefonia/` que podem abrir o token. Cada um entra num PR revisado. */
export const JOBS_QUE_ABREM: readonly string[] = [
  // F2-07 acrescenta: "packages/core/src/calls/telefonia/conta-jobs.ts"
];

const SELO = "packages/core/src/calls/telefonia/selo.ts";

/** Pode citar `abrirNoWorker`. */
const PODEM_ABRIR = (caminho: string, jobs: readonly string[] = JOBS_QUE_ABREM) =>
  caminho === SELO || caminho.startsWith("apps/worker/") || jobs.includes(caminho);

/** Pode citar o NOME da variável da chave privada: quem abre mais o caminho de entrega ao worker. */
const CAMINHO_DA_ENTREGA = new Set([
  "packages/core/vitest.config.ts", // zera a variável nos testes
  ".github/workflows/worker-credenciais.yml",
  "scripts/ops/worker-credenciais.mjs",
  "scripts/ops/telefonia-gerar-chaves.sh",
  "scripts/run-worker.sh",
]);
const PODEM_CITAR_A_VARIAVEL = (caminho: string, jobs: readonly string[] = JOBS_QUE_ABREM) =>
  PODEM_ABRIR(caminho, jobs) || CAMINHO_DA_ENTREGA.has(caminho);

const ehTeste = (caminho: string) => /\.(test|teste)\.(ts|tsx|js|mjs|sh)$/.test(caminho);

export type Arquivo = { caminho: string; texto: string };

const ABRIR = /\babrirNoWorker\b/;
const VARIAVEL = /TELEFONIA_CHAVE_PRIVADA/;
const REEXPORTA_O_SELO = /export\s*\*\s*(?:as\s+\w+\s+)?from\s*["'][^"']*\/selo(?:\.[a-z]+)?["']/;

/** Violações (uma frase cada), a partir de arquivos já lidos. Pura: o teste e o auto-teste usam a mesma. */
export function violacoes(arquivos: readonly Arquivo[], jobs: readonly string[] = JOBS_QUE_ABREM): string[] {
  const achados: string[] = [];
  for (const { caminho, texto } of arquivos) {
    const noSite = caminho.startsWith("apps/web/");
    if (ehTeste(caminho) && !noSite) continue;
    if (ABRIR.test(texto) && !PODEM_ABRIR(caminho, jobs)) {
      achados.push(
        noSite
          ? `${caminho}: o site não pode citar abrirNoWorker (só o worker abre o token da telefonia)`
          : `${caminho}: cita abrirNoWorker mas não é o selo, apps/worker nem um job listado em JOBS_QUE_ABREM`,
      );
    }
    if (VARIAVEL.test(texto) && !PODEM_CITAR_A_VARIAVEL(caminho, jobs)) {
      achados.push(
        noSite
          ? `${caminho}: o site não pode citar a variável da chave privada da telefonia (iria para o pacote do navegador)`
          : `${caminho}: cita a variável da chave privada da telefonia fora do caminho de entrega ao worker`,
      );
    }
    if (!ehTeste(caminho) && REEXPORTA_O_SELO.test(texto)) {
      achados.push(`${caminho}: reexporta o selo inteiro (export * from ".../selo"); exporte só selarParaOWorker, por nome`);
    }
  }
  return achados;
}

function lerArquivos(): Arquivo[] {
  const saida: Arquivo[] = [];
  const andar = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORAR.has(e.name)) continue;
      const cheio = join(dir, e.name);
      if (IGNORAR_PELO_CAMINHO.has(relative(RAIZ, cheio).split("\\").join("/"))) continue;
      // Só arquivo e pasta de verdade: o link `node_modules` e o `.env` de um worktree ligado ficam de fora.
      if (e.isDirectory()) andar(cheio);
      else if (e.isFile() && EXTENSOES.test(e.name) && e.name !== "pnpm-lock.yaml") {
        saida.push({ caminho: relative(RAIZ, cheio).split("\\").join("/"), texto: readFileSync(cheio, "utf8") });
      }
    }
  };
  andar(RAIZ);
  return saida;
}

describe("catraca do selo da telefonia", () => {
  const arquivos = lerArquivos();

  it("varre o repositório de verdade (não passa por falta de arquivo)", () => {
    const caminhos = arquivos.map((a) => a.caminho);
    expect(caminhos).toContain(SELO);
    expect(caminhos).toContain("apps/worker/src/index.ts");
    expect(caminhos.some((c) => c.startsWith("apps/web/"))).toBe(true);
  });

  it("abrirNoWorker e a variável da chave privada ficam no caminho do worker", () => {
    expect(violacoes(arquivos)).toEqual([]);
  });

  it("nenhum arquivo de apps/web cita abrirNoWorker nem a chave (teste incluído)", () => {
    const doSite = arquivos.filter((a) => a.caminho.startsWith("apps/web/"));
    expect(doSite.length).toBeGreaterThan(50);
    expect(doSite.filter((a) => ABRIR.test(a.texto) || VARIAVEL.test(a.texto)).map((a) => a.caminho)).toEqual([]);
  });

  it("nenhum workflow da Vercel, do banco ou do backup recebe a chave", () => {
    const workflows = arquivos.filter((a) => a.caminho.startsWith(".github/workflows/") && a.caminho !== ".github/workflows/worker-credenciais.yml");
    expect(workflows.length).toBeGreaterThan(1);
    expect(workflows.filter((a) => VARIAVEL.test(a.texto)).map((a) => a.caminho)).toEqual([]);
  });

  it("os módulos de job listados existem (lista parada em arquivo apagado não vale)", () => {
    const existentes = new Set(arquivos.map((a) => a.caminho));
    expect(JOBS_QUE_ABREM.filter((c) => !existentes.has(c))).toEqual([]);
    expect(JOBS_QUE_ABREM.filter((c) => !c.startsWith("packages/core/src/calls/telefonia/") || ehTeste(c))).toEqual([]);
  });

  it("o package.json do core não abre subcaminho para calls/telefonia", () => {
    const pacote = JSON.parse(readFileSync(join(RAIZ, "packages/core/package.json"), "utf8")) as { exports?: Record<string, string> };
    expect(Object.values(pacote.exports ?? {}).filter((v) => /telefonia/.test(v))).toEqual([]);
  });
});

describe("auto-teste da catraca (a regra pega o que precisa pegar)", () => {
  const web = (texto: string, caminho = "apps/web/app/exemplo/actions.ts"): Arquivo => ({ caminho, texto });

  it("reprova abrirNoWorker importado no site, pelo barril ou por nome", () => {
    expect(violacoes([web('import { abrirNoWorker } from "@crmagro/core";')])).toHaveLength(1);
    expect(violacoes([web('import * as core from "@crmagro/core"; core.abrirNoWorker(x);')])).toHaveLength(1);
    expect(violacoes([web("const abrir = abrirNoWorker;", "apps/web/lib/x.ts")])).toHaveLength(1);
  });

  it("reprova o teste de apps/web que cita (o site é estrito até no teste)", () => {
    expect(violacoes([web("abrirNoWorker()", "apps/web/lib/x.test.ts")])).toHaveLength(1);
  });

  it("reprova a variável da chave no site, num next.config e num workflow da Vercel", () => {
    expect(violacoes([web("process.env.TELEFONIA_CHAVE_PRIVADA")])).toHaveLength(1);
    expect(violacoes([web("export default { env: { TELEFONIA_CHAVE_PRIVADA: process.env.X } }", "apps/web/next.config.mjs")])).toHaveLength(1);
    expect(violacoes([{ caminho: ".github/workflows/vercel-google.yml", texto: "VPS_TELEFONIA_CHAVE_PRIVADA: ${{ secrets.X }}" }])).toHaveLength(1);
    expect(violacoes([web("VPS_TELEFONIA_CHAVE_PRIVADA_ANTERIOR")])).toHaveLength(1);
  });

  it("reprova um módulo do core fora da lista e aceita o da lista", () => {
    const job = { caminho: "packages/core/src/calls/telefonia/conta-jobs.ts", texto: 'import { abrirNoWorker } from "./selo";' };
    expect(violacoes([job], [])).toHaveLength(1);
    expect(violacoes([job], [job.caminho])).toEqual([]);
    const outro = { caminho: "packages/core/src/calls/service.ts", texto: 'import { abrirNoWorker } from "./telefonia/selo";' };
    expect(violacoes([outro], [job.caminho])).toHaveLength(1);
  });

  it("aceita o selo, o worker e o caminho de entrega", () => {
    expect(
      violacoes([
        { caminho: SELO, texto: "export function abrirNoWorker() {} const A = 'TELEFONIA_CHAVE_PRIVADA'" },
        { caminho: "apps/worker/src/telefonia-handler.ts", texto: "abrirNoWorker(x)" },
        { caminho: "scripts/run-worker.sh", texto: "VPS_TELEFONIA_CHAVE_PRIVADA" },
        { caminho: ".github/workflows/worker-credenciais.yml", texto: "VPS_TELEFONIA_CHAVE_PRIVADA" },
        { caminho: "packages/core/src/calls/telefonia/selo.test.ts", texto: "abrirNoWorker()" },
      ]),
    ).toEqual([]);
  });

  it("reprova o barril que reexporta o selo inteiro, e aceita o nome só do lado de selar", () => {
    for (const texto of ['export * from "./selo";', "export * from './telefonia/selo'", 'export * as selo from "./telefonia/selo.ts"']) {
      expect(violacoes([{ caminho: "packages/core/src/calls/index.ts", texto }]), texto).toHaveLength(1);
    }
    expect(violacoes([{ caminho: "packages/core/src/calls/index.ts", texto: 'export { selarParaOWorker } from "./telefonia/selo";' }])).toEqual([]);
  });
});
