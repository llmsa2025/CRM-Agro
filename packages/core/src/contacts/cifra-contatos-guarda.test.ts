import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Teste-guarda da cifra de e-mail e telefone dos contatos (CONTATOS_CIFRA). Varre o código de produção e
 * quebra se alguém:
 *  - gravar um dos 5 models com telefone ou e-mail por `basePrisma` (não passa pela extensão do `db()` e
 *    deixaria a linha sem cifrado e sem índice);
 *  - criar identificadores por create ANINHADO (`identifiers: { create }`, também não passa pela extensão);
 *  - voltar a comparar telefone ou e-mail por texto à mão (`valor: { in }`, `telefone: { in }`...) fora dos
 *    construtores de `where` de `contacts/identificadores-cifra.ts`.
 * As listas de permitidos são uma CATRACA: só podem encolher. Cada arquivo nelas tem a razão escrita ao lado.
 */
const RAIZ = join(__dirname, "..", "..", "..", "..");

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (["node_modules", ".next", "dist", "migrations", ".git"].includes(nome)) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
    else if (/\.(ts|tsx|mjs|js)$/.test(nome) && !/\.test\.tsx?$/.test(nome) && !caminho.includes("test-support")) saida.push(caminho);
  }
  return saida;
}

const fontes = ["apps", "packages"]
  .flatMap((d) => arquivos(join(RAIZ, d)))
  .map((f) => ({ rel: relative(RAIZ, f).replace(/\\/g, "/"), codigo: readFileSync(f, "utf8") }));

const semComentarios = (codigo: string) =>
  codigo
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("código: nada escapa da cifra de e-mail e telefone", () => {
  it("encontra o código (o teste não pode passar vazio)", () => {
    expect(fontes.length).toBeGreaterThan(200);
  });

  it("nenhum arquivo grava os 5 models por basePrisma, a não ser os que preenchem cifrado e índice à mão", () => {
    const ESCRITA = /basePrisma\s*\.\s*(channelIdentifier|conversation|whatsAppLid|call|campaignRecipient)\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert)\b/;
    const PERMITIDOS = new Set<string>([
      // Script que corrige o telefone gravado: passa por comCamposCifrados (checado abaixo).
    ]);
    const achados = fontes.filter((f) => ESCRITA.test(semComentarios(f.codigo))).map((f) => f.rel);
    expect(achados.filter((r) => !PERMITIDOS.has(r))).toEqual([]);
  });

  it("os pontos que gravam por basePrisma, tx ou cliente recebido chamam comCamposCifrados", () => {
    for (const rel of [
      "packages/core/src/conversations/lid-mapa.ts",
      "packages/core/src/integrations/whatsapp-historico.ts",
    ]) {
      const f = fontes.find((x) => x.rel === rel);
      expect(f, rel).toBeDefined();
      expect(f!.codigo, rel).toContain("comCamposCifrados(");
    }
  });

  it("nenhum código de produção cria identificadores por create aninhado", () => {
    const ANINHADO = /identifiers\s*:\s*\{\s*(create|createMany)\b/;
    // Seed de demonstração da base de TESTE (nunca roda em produção).
    const PERMITIDOS = new Set(["packages/db/scripts/seed-demo.mjs"]);
    const achados = fontes.filter((f) => ANINHADO.test(semComentarios(f.codigo)) && !PERMITIDOS.has(f.rel)).map((f) => f.rel);
    expect(achados).toEqual([]);
  });

  it("telefone e e-mail não são comparados por texto à mão (valor/externalNumber/telefone: { in })", () => {
    // Catraca: o que ainda compara por texto. Cada um tem o motivo; quando for convertido, saia da lista.
    const PENDENTES = new Set([
      "packages/core/src/calls/resultado.ts", // Call.phoneNumber e CampaignRecipient.telefone: sem índice, o filtro vira comparação em memória na etapa que apaga o texto
    ]);
    const COMPARACAO = /\b(valor|externalNumber|telefone|phoneNumber)\s*:\s*\{\s*in\s*:/;
    const dentroDoModulo = new Set(["packages/core/src/contacts/identificadores-cifra.ts", "packages/db/src/contatos-cifra.ts", "packages/db/src/contatos-cifra-lotes.ts"]);
    const achados = fontes
      .filter((f) => !dentroDoModulo.has(f.rel) && COMPARACAO.test(semComentarios(f.codigo)))
      .map((f) => f.rel);
    expect(achados.filter((r) => !PENDENTES.has(r))).toEqual([]);
  });

  it("a escrita pelo db() está ligada nos dois clients (simples e via RLS)", () => {
    const client = fontes.find((f) => f.rel === "packages/db/src/client.ts")!.codigo;
    expect(client.match(/\.\$extends\(contatosCifraExtension\(teamId\)\)/g)?.length).toBe(2);
  });

  it("nenhuma rota REST devolve a linha do contato sem passar por contatoParaNavegador", () => {
    for (const rel of ["apps/web/app/api/contacts/route.ts", "apps/web/app/api/contacts/[id]/route.ts"]) {
      const f = fontes.find((x) => x.rel === rel)!;
      expect(f.codigo, rel).toContain("contatoParaNavegador");
    }
  });
});
