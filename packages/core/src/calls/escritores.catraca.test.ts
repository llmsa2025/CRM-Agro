import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * CATRACA dos escritores de ligação (F1A-08). Estática, sem banco.
 *
 * A promessa: nenhum campo que é do PROVEDOR (comprovado: status, duração, horários, gravação, transcrição,
 * resumo) muda pela API. Quem muda é o provedor, por dentro do core. O desfecho DECLARADO do Discador manual
 * (`markCallOutcome`, `/api/calls/dialer/outcome`) segue como está até a F2-22 (decisão D2). Por isso:
 *  - nenhum arquivo de `apps/` (rota, server action, worker, extensão) usa os escritores internos de Call:
 *    `createCall`, `updateCallStatus`, `updateCallTranscription`, `registrarResultado` e os schemas que
 *    descrevem esses campos (`updateCallStatusSchema`, `updateCallTranscriptionSchema`);
 *  - `/api/calls` só lê (GET) e `/api/calls/:id` só lê e anota (GET e PATCH): não existe POST de ligação;
 *  - o PATCH valida o corpo pela lista de permissão (`anotarLigacaoApiSchema`) e grava por `anotarCamposDaLigacao`.
 * Criou uma rota ou action que precisa de um desses? Ela não deve gravar fato de ligação: a ligação nasce do discador
 * (`createManualCall`, `markCallOutcome`) e do provedor. Se de fato precisa, é decisão de desenho: mexa nesta lista de propósito.
 * Observação: `updateCallStatus` e o schema dele ficam no core só porque o aplicador da Voopi os usa; saem com ele (F1A-11).
 *
 * A catraca é pela FORMA e lê o código pela árvore do TypeScript (não por regex): comentário nunca conta, e o nome vale
 * como identificador (importação simples, em várias linhas, com apelido, pelo namespace) ou como texto de string
 * (`core["createCall"]`, importação dinâmica). Ler pela árvore evita que uma string com `/*` esconda código real.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const IGNORAR = new Set(["node_modules", ".next", "dist", "coverage", ".turbo"]);
const EXTENSOES = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Escritores de Call que `apps/` não pode tocar. */
export const ESCRITORES_PROIBIDOS_EM_APPS = [
  "createCall",
  "updateCallStatus",
  "updateCallStatusSchema",
  "updateCallTranscription",
  "updateCallTranscriptionSchema",
  "registrarResultado",
] as const;

const METODOS_HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name)) continue;
    const cheio = join(dir, e.name);
    if (e.isDirectory()) arquivos(cheio, saida);
    else if (EXTENSOES.test(e.name) && !/\.d\.ts$/.test(e.name)) saida.push(cheio);
  }
  return saida;
}

/** Lê o código pela árvore do TypeScript; o tipo do arquivo (TS, TSX, JS...) vem da extensão. */
function lerArvore(texto: string, arquivo: string): ts.SourceFile {
  const ext = arquivo.slice(arquivo.lastIndexOf(".")).toLowerCase();
  const tipo =
    ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" ? ts.ScriptKind.JSX : /^\.(js|mjs|cjs)$/.test(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, false, tipo);
}

/**
 * Os escritores proibidos que o código cita: como identificador ou como texto de string. Comentário não é nó da
 * árvore, então não conta. Nome inteiro (`createCallbackUrl` não é `createCall`).
 */
export function escritoresCitados(texto: string, arquivo = "arquivo.ts"): string[] {
  // Atalho barato: só lê a árvore se algum nome aparece no texto bruto (a maioria dos arquivos de apps/ não cita).
  const candidatos = ESCRITORES_PROIBIDOS_EM_APPS.filter((nome) => texto.includes(nome));
  if (candidatos.length === 0) return [];
  const nomes = new Set<string>();
  const visitar = (no: ts.Node): void => {
    if (ts.isIdentifier(no) || ts.isStringLiteralLike(no)) nomes.add(no.text);
    ts.forEachChild(no, visitar);
  };
  visitar(lerArvore(texto, arquivo));
  return candidatos.filter((nome) => nomes.has(nome));
}

/** As chamadas do código (`quem(args)`), com o texto de quem chama e dos argumentos. Comentário não conta. */
export function chamadas(texto: string, arquivo = "arquivo.ts"): { quem: string; args: string[] }[] {
  const sf = lerArvore(texto, arquivo);
  const saida: { quem: string; args: string[] }[] = [];
  const visitar = (no: ts.Node): void => {
    if (ts.isCallExpression(no)) saida.push({ quem: no.expression.getText(sf), args: no.arguments.map((a) => a.getText(sf)) });
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return saida;
}

/** Os métodos HTTP que um `route.ts` exporta (função, constante, desestruturação ou reexportação nomeada). */
export function metodosExportados(texto: string, arquivo = "route.ts"): string[] {
  const sf = lerArvore(texto, arquivo);
  const achados = new Set<string>();
  const ehMetodo = (nome: string) => (METODOS_HTTP as readonly string[]).includes(nome);
  const exportado = (no: ts.Node) => ts.canHaveModifiers(no) && (ts.getModifiers(no) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const nomesDoBinding = (b: ts.BindingName): string[] =>
    ts.isIdentifier(b) ? [b.text] : b.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : nomesDoBinding(e.name)));
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      if (exportado(st) && st.name && ehMetodo(st.name.text)) achados.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      if (!exportado(st)) continue;
      for (const d of st.declarationList.declarations) for (const nome of nomesDoBinding(d.name)) if (ehMetodo(nome)) achados.add(nome);
    } else if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) if (ehMetodo(el.name.text)) achados.add(el.name.text);
    }
  }
  return [...achados].sort();
}

const rel = (f: string) => relative(RAIZ, f).replace(/\\/g, "/");
const lerFonte = (f: string) => readFileSync(f, "utf8");

const ROTA_LISTA = join(RAIZ, "apps/web/app/api/calls/route.ts");
const ROTA_DA_LIGACAO = join(RAIZ, "apps/web/app/api/calls/[id]/route.ts");
const doApps = arquivos(join(RAIZ, "apps"));

describe("escritores de ligação: apps/ não toca o que é do provedor", () => {
  it("encontra os arquivos de apps/ e as duas rotas de ligação (a catraca não pode passar vazia)", () => {
    expect(doApps.length).toBeGreaterThan(100);
    expect(doApps.map(rel)).toEqual(expect.arrayContaining([rel(ROTA_LISTA), rel(ROTA_DA_LIGACAO)]));
  });

  it("nenhum arquivo de apps/ usa createCall, updateCallStatus, updateCallTranscription nem registrarResultado", () => {
    const usos = doApps.flatMap((f) => escritoresCitados(lerFonte(f), f).map((nome) => `${rel(f)}: ${nome}`));
    expect(usos, `escritor interno de ligação usado em apps/ (ver o comentário no topo deste teste):\n${usos.join("\n")}`).toEqual([]);
  });

  it("POST /api/calls não existe: a rota só lê (GET)", () => {
    expect(metodosExportados(lerFonte(ROTA_LISTA), ROTA_LISTA)).toEqual(["GET"]);
  });

  it("/api/calls/:id só lê (GET) e anota (PATCH)", () => {
    expect(metodosExportados(lerFonte(ROTA_DA_LIGACAO), ROTA_DA_LIGACAO)).toEqual(["GET", "PATCH"]);
  });

  it("o PATCH valida pela lista de permissão e grava só por anotarCamposDaLigacao", () => {
    const cs = chamadas(lerFonte(ROTA_DA_LIGACAO), ROTA_DA_LIGACAO);
    expect(cs.map((c) => c.quem)).toContain("anotarLigacaoApiSchema.parse");
    const anotar = cs.filter((c) => c.quem === "anotarCamposDaLigacao");
    expect(anotar).toHaveLength(1);
    // O corpo cru nunca vai direto ao serviço: o 2º argumento é o resultado do schema estrito.
    expect(anotar[0]!.args[1], "o 2º argumento de anotarCamposDaLigacao tem de ser anotarLigacaoApiSchema.parse(...)").toMatch(
      /^anotarLigacaoApiSchema\s*\.parse\(/,
    );
  });
});

describe("os detectores da catraca (auto-teste)", () => {
  it("pega a importação simples, em várias linhas, com apelido, pelo namespace e a dinâmica", () => {
    expect(escritoresCitados(`import { createCall } from "@crmagro/core";`)).toEqual(["createCall"]);
    expect(escritoresCitados(`import {\n  listCalls,\n  updateCallStatus,\n} from "@crmagro/core";`)).toEqual(["updateCallStatus"]);
    expect(escritoresCitados(`import { registrarResultado as r } from "@crmagro/core";`)).toEqual(["registrarResultado"]);
    expect(escritoresCitados(`import * as core from "@crmagro/core";\ncore.updateCallTranscription(id, x);`)).toEqual(["updateCallTranscription"]);
    expect(escritoresCitados(`const { createCall } = await import("@crmagro/core");`)).toEqual(["createCall"]);
    expect(escritoresCitados(`core["updateCallStatus"](id, x)`)).toEqual(["updateCallStatus"]);
    expect(escritoresCitados(`import { updateCallStatusSchema, updateCallTranscriptionSchema } from "@crmagro/core";`)).toEqual([
      "updateCallStatusSchema",
      "updateCallTranscriptionSchema",
    ]);
  });

  it("não confunde com nomes parecidos nem conta comentário", () => {
    expect(escritoresCitados(`import { createCallbackUrl, listCalls, getCall, anotarCamposDaLigacao, createManualCall } from "@crmagro/core";`)).toEqual([]);
    expect(escritoresCitados(`// createCall(x) saiu\n/* updateCallStatus */\nconst a = 1;`)).toEqual([]);
    expect(escritoresCitados(`const url = "https://exemplo.invalid/a"; const b = 2;`)).toEqual([]);
  });

  it("uma string com `/*` não esconde código real (o furo do tira-comentário por regex)", () => {
    const furo = 'const a = "src/**";\nimport { createCall } from "@crmagro/core";\nconst b = "**/x";';
    expect(escritoresCitados(furo)).toEqual(["createCall"]);
    expect(metodosExportados('const a = "src/**";\nexport async function POST() {}\nconst b = "**/x";')).toEqual(["POST"]);
  });

  it("lê arquivo TSX e chamada dentro de template", () => {
    expect(escritoresCitados("export default function P() { return <a href=\"/x\">{createCall()}</a>; }", "p.tsx")).toEqual(["createCall"]);
    expect(escritoresCitados("const x = `${updateCallStatus(id, d)}`;")).toEqual(["updateCallStatus"]);
  });

  it("lista as chamadas sem contar comentário", () => {
    const cs = chamadas("// foo(1)\nconst a = bar.baz(x, y);\n/* qux() */");
    expect(cs).toEqual([{ quem: "bar.baz", args: ["x", "y"] }]);
  });

  it("lista os métodos HTTP exportados de qualquer forma", () => {
    expect(metodosExportados(`export async function GET() {}\nexport async function POST() {}`)).toEqual(["GET", "POST"]);
    expect(metodosExportados(`export function PATCH() {}`)).toEqual(["PATCH"]);
    expect(metodosExportados(`export const DELETE = async () => {};`)).toEqual(["DELETE"]);
    expect(metodosExportados(`export { handler as POST, outra as GET } from "./x";`)).toEqual(["GET", "POST"]);
    expect(metodosExportados(`export const { GET, POST: criar } = handlers;`)).toEqual(["GET"]);
    expect(metodosExportados(`const POST = 1;\n// export async function PUT() {}\nexport const runtime = "nodejs";`)).toEqual([]);
  });
});
