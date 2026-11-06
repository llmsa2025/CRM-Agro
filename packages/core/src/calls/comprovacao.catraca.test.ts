import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CATRACA da prova da ligação (F1A-03). `meta.comprovada` é a projeção, na Activity, da prova guardada na Call
 * (`Call.evidencia`, que só o aplicador de fatos do provedor grava). Se dois lugares puderem escrever essa chave,
 * volta a haver duas fontes do que "conta como ligação", e o placar deixa de ser honesto. Estático, sem banco.
 * Quebra quando alguém:
 * 1. importa `marcarTentativaComprovada` num arquivo que não está em `APLICADORES_DE_PROVA`;
 * 2. escreve a chave `comprovada` fora de `calls/comprovacao.ts` e de `HELPERS_DE_TESTE` (objeto, atribuição, SQL ou chave computada).
 * Ler a chave é livre. A catraca é pela FORMA: pega o padrão de código, não a intenção.
 *
 * Quando a F1B-09 criar o projetor da Activity, o arquivo dele entra em `APLICADORES_DE_PROVA` e, ao escrever a
 * chave, usa `marcarTentativaComprovada`. A tela (F1A-07) só LÊ a chave, como texto.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const IGNORAR = new Set(["node_modules", ".next", "dist", "coverage", ".turbo"]);

/** Arquivos que podem importar `marcarTentativaComprovada` (além de `comprovacao.ts`). Vazia hoje: a F1B-09 põe o projetor. */
const APLICADORES_DE_PROVA: readonly string[] = [];

/**
 * Helpers que só os testes importam e que semeiam Activity com a chave já pronta, direto no banco. Isenção por caminho
 * exato (não por pasta): um arquivo novo em `test-support/`, ou em qualquer outro lugar, continua sob a catraca.
 */
const HELPERS_DE_TESTE: readonly string[] = ["packages/core/src/test-support/toque-cenario.ts"];

const ARQUIVO_DA_PROVA = "packages/core/src/calls/comprovacao.ts";

function arquivos(dir: string, saida: string[] = []): string[] {
  if (!existsSync(dir)) return saida;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name)) continue;
    const cheio = join(dir, e.name);
    if (e.isDirectory()) arquivos(cheio, saida);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) saida.push(cheio);
  }
  return saida;
}

const semComentarios = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/** Todo o código que roda: o core, os demais pacotes e os apps (web, worker, extensão). Sem testes. */
function codigoDoProjeto(): string[] {
  const pacotes = readdirSync(join(RAIZ, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORAR.has(e.name))
    .flatMap((e) => [join(RAIZ, "packages", e.name, "src"), join(RAIZ, "packages", e.name, "scripts")]);
  return [...pacotes, join(RAIZ, "apps")].flatMap((d) => arquivos(d));
}

const rel = (f: string) => relative(RAIZ, f);
const lerFonte = (f: string) => readFileSync(f, "utf8");

/**
 * Padrões que ESCREVEM a chave, no texto sem comentários:
 * - propriedade de objeto: `comprovada:` e `"comprovada":` (JSON dentro de SQL também);
 * - acesso por colchete: `["comprovada"]` (o padrão do plano; lê ou escreve, não faz diferença: a tela lê por `meta.comprovada`);
 * - atribuição: `.comprovada =`;
 * - caminho de `jsonb_set`: `{comprovada}`;
 * - chave computada pela constante: `[CHAVE_COMPROVADA]:` e `[CHAVE_COMPROVADA] =`.
 * O plural `comprovadas:` (relatório) não casa: o `\b` exige fim de palavra depois de `comprovada`.
 * `comprovada: boolean` (campo de tipo, como o estado da barra de ligação no navegador) também não é escrita da chave.
 */
const ESCRITA_DA_CHAVE: readonly RegExp[] = [
  /\bcomprovada["']?\s*:(?!\s*boolean\b)/,
  /["']comprovada["']\s*:(?!\s*boolean\b)/,
  /\[\s*["'`]comprovada["'`]\s*\]/,
  /\.comprovada\s*=(?!=)/,
  /\{\s*comprovada\s*\}/,
  /\[\s*CHAVE_COMPROVADA\s*\]\s*(:|=(?!=))/,
];

/** Texto onde a escrita da chave aparece, ou `null`. Pura, para o teste e para o auto-teste. */
export function escreveAChave(texto: string): string | null {
  const t = semComentarios(texto);
  for (const re of ESCRITA_DA_CHAVE) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

/** `true` quando o arquivo menciona a função que escreve a chave (importação, chamada ou reexportação por nome). */
export function usaOEscritor(texto: string): boolean {
  return /\bmarcarTentativaComprovada\b/.test(semComentarios(texto));
}

describe("catraca: meta.comprovada tem um escritor só", () => {
  it("o auto-teste enxerga as formas de escrever a chave e ignora leitura e comentário (a catraca não passa vazia)", () => {
    // Escritas.
    expect(escreveAChave("const m = { comprovada: true }")).not.toBeNull();
    expect(escreveAChave('const m = { "comprovada": true }')).not.toBeNull();
    expect(escreveAChave("meta['comprovada'] = true")).not.toBeNull();
    expect(escreveAChave('meta["comprovada"] = true')).not.toBeNull();
    expect(escreveAChave("meta.comprovada = true")).not.toBeNull();
    expect(escreveAChave("const m = { [CHAVE_COMPROVADA]: true }")).not.toBeNull();
    expect(escreveAChave("meta[CHAVE_COMPROVADA] = true")).not.toBeNull();
    expect(escreveAChave("sql`UPDATE \"Activity\" SET meta = meta || '{\"comprovada\": true}'`")).not.toBeNull();
    expect(escreveAChave("sql`SELECT jsonb_set(meta, '{comprovada}', 'true')`")).not.toBeNull();
    // Leituras e coisas parecidas passam.
    expect(escreveAChave("if (meta.comprovada === true) {}")).toBeNull();
    expect(escreveAChave("if (meta?.comprovada == null) {}")).toBeNull();
    expect(escreveAChave("const x = { path: [CHAVE_COMPROVADA], equals: true }")).toBeNull();
    expect(escreveAChave("const y = meta[CHAVE_COMPROVADA] === true")).toBeNull();
    expect(escreveAChave("const z = { comprovadas: 3, semComprovada: 1 }")).toBeNull();
    expect(escreveAChave("type R = { outcome: string; comprovada: boolean; conversa: boolean }")).toBeNull();
    expect(escreveAChave("const r = { comprovada: booleanDaTela }")).not.toBeNull();
    // Comentário não conta.
    expect(escreveAChave("// meta.comprovada = true\n/* { comprovada: true } */")).toBeNull();

    expect(usaOEscritor("import { marcarTentativaComprovada } from './comprovacao'")).toBe(true);
    expect(usaOEscritor("const m = marcarTentativaComprovada(meta, true)")).toBe(true);
    expect(usaOEscritor("// marcarTentativaComprovada")).toBe(false);
    expect(usaOEscritor("import { ehAtividadeComprovada } from './comprovacao'")).toBe(false);
  });

  const codigo = codigoDoProjeto();

  it("há código para varrer (a varredura não está olhando para o lugar errado)", () => {
    const nomes = codigo.map(rel);
    expect(codigo.length).toBeGreaterThan(300);
    expect(nomes).toContain(ARQUIVO_DA_PROVA);
    expect(nomes).toContain("packages/core/src/dashboard/service.ts");
    expect(nomes).toContain("packages/core/src/motor-do-dia/toque.ts");
    // O `test-support` entra na varredura: só o helper listado em HELPERS_DE_TESTE é isento, por caminho.
    for (const h of HELPERS_DE_TESTE) expect(nomes).toContain(h);
    expect(nomes.some((n) => n.startsWith("apps/web/app/"))).toBe(true);
    expect(nomes.some((n) => n.startsWith("apps/worker/src/"))).toBe(true);
  });

  it("só os arquivos de APLICADORES_DE_PROVA usam marcarTentativaComprovada", () => {
    const culpados = codigo
      .filter((f) => rel(f) !== ARQUIVO_DA_PROVA && !APLICADORES_DE_PROVA.includes(rel(f)) && usaOEscritor(lerFonte(f)))
      .map(rel);
    expect(culpados, "quem projeta a prova na Activity entra em APLICADORES_DE_PROVA (decisão revisada); ninguém mais escreve a chave").toEqual([]);
  });

  it("os aplicadores listados existem e de fato usam o escritor (a lista não apodrece)", () => {
    for (const f of APLICADORES_DE_PROVA) {
      expect(existsSync(join(RAIZ, f)), `${f} não existe mais`).toBe(true);
      expect(usaOEscritor(lerFonte(join(RAIZ, f))), `${f} não usa marcarTentativaComprovada`).toBe(true);
    }
  });

  it("os helpers de teste isentos existem e de fato escrevem a chave (a isenção não apodrece)", () => {
    for (const f of HELPERS_DE_TESTE) {
      expect(existsSync(join(RAIZ, f)), `${f} não existe mais`).toBe(true);
      expect(escreveAChave(lerFonte(join(RAIZ, f))), `${f} não escreve a chave: tire-o de HELPERS_DE_TESTE`).not.toBeNull();
    }
  });

  it("fora de comprovacao.ts e dos helpers de teste, nenhum arquivo escreve a chave comprovada", () => {
    const culpados = codigo
      .filter((f) => rel(f) !== ARQUIVO_DA_PROVA && !HELPERS_DE_TESTE.includes(rel(f)))
      .map((f) => ({ arquivo: rel(f), achou: escreveAChave(lerFonte(f)) }))
      .filter((c) => c.achou !== null);
    expect(culpados, "escreva a chave só por marcarTentativaComprovada (calls/comprovacao.ts)").toEqual([]);
  });

  it("dentro de comprovacao.ts há UM ponto de escrita da chave", () => {
    const texto = semComentarios(lerFonte(join(RAIZ, ARQUIVO_DA_PROVA)));
    expect(texto.match(/\[\s*CHAVE_COMPROVADA\s*\]\s*:/g) ?? []).toHaveLength(1);
    expect(texto).toMatch(/export const CHAVE_COMPROVADA = "comprovada";/);
  });
});
