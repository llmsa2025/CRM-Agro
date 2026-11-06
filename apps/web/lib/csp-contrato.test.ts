import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTS_DO_LOGIN, HOSTS_DO_MAPA, montarCsp, novoNonce } from "./csp";

/**
 * Contrato entre o CÓDIGO do app e a política de CSP.
 *
 * A política só funciona porque o app NÃO faz certas coisas (script em linha sem nonce, eval, iframe, página
 * estática que ficaria sem nonce) e porque os hosts externos que ele usa estão na lista. Este teste varre o
 * código do web e quebra quando alguém quebra uma dessas premissas: é de propósito. Quebrou? Ou ajuste o
 * código, ou revise a política (lib/csp.ts), o doc e a lista abaixo. Não é para "fazer o teste passar".
 */
const RAIZ_WEB = join(__dirname, "..");
const PASTAS = ["app", "components", "lib"];

function arquivos(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) achados.push(...arquivos(caminho));
    else if (/\.(ts|tsx)$/.test(nome)) achados.push(caminho);
  }
  return achados;
}

const codigo = PASTAS.flatMap((p) => arquivos(join(RAIZ_WEB, p)))
  .map((arquivo) => ({ caminho: relative(RAIZ_WEB, arquivo).replace(/\\/g, "/"), texto: readFileSync(arquivo, "utf8") }))
  // Testes, o ambiente simulado da extensão e a própria política não contam.
  .filter((a) => !/\.test\.tsx?$/.test(a.caminho) && !a.caminho.startsWith("lib/extensao/") && !/^lib\/csp(-relatorio)?\.ts$/.test(a.caminho));

describe("contrato código x CSP", () => {
  it("o teste enxerga o código (não pode passar vazio)", () => {
    expect(codigo.length).toBeGreaterThan(100);
  });

  it("nada que a política barra por construção: script em linha, eval, iframe, objeto embutido", () => {
    const proibidos: [string, RegExp][] = [
      ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
      ["<script (tag de script no JSX)", /<script[\s>]/],
      ["next/script", /from ["']next\/script["']/],
      ["eval(", /(^|[^.\w])eval\(/],
      ["new Function(", /new Function\(/],
      ["<iframe", /<iframe[\s>]/],
      ["<embed / <object", /<(embed|object)[\s>]/],
      ["srcDoc", /\bsrcDoc\b/],
      ["document.write", /document\.write\(/],
    ];
    const achados: string[] = [];
    for (const a of codigo) for (const [nome, re] of proibidos) if (re.test(a.texto)) achados.push(`${a.caminho}: ${nome}`);
    expect(achados, "a CSP bloquearia isso (frame-src, object-src, script-src com nonce)").toEqual([]);
  });

  it("nenhuma página estática: ela sairia sem nonce e quebraria com a política aplicada", () => {
    const estaticos: [string, RegExp][] = [
      ["force-static", /force-static/],
      ["revalidate no módulo", /export const revalidate\b/],
      ["generateStaticParams", /generateStaticParams/],
    ];
    const achados: string[] = [];
    for (const a of codigo) for (const [nome, re] of estaticos) if (re.test(a.texto)) achados.push(`${a.caminho}: ${nome}`);
    expect(achados).toEqual([]);
  });

  it("todo ThemeProvider do layout raiz recebe o nonce", () => {
    const layout = codigo.find((a) => a.caminho === "app/layout.tsx")!.texto;
    const tags = layout.match(/<ThemeProvider\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThanOrEqual(1);
    for (const tag of tags) expect(tag, tag).toContain("nonce={nonce}");
  });

  it("innerHTML= só onde já foi revisado (o editor de assinatura); lugar novo pede revisão da política", () => {
    const revisados = new Set(["app/integracoes/canais/RichEditor.tsx"]);
    const achados = codigo.filter((a) => /\.innerHTML\s*=/.test(a.texto) && !revisados.has(a.caminho)).map((a) => a.caminho);
    expect(achados).toEqual([]);
  });

  it("todo host externo escrito no código está na política, ou é só link ou placeholder (lista abaixo)", () => {
    // Hosts que aparecem no código mas NÃO são carregados pela página (link clicado, texto de exemplo,
    // origem do próprio app). Acrescentar aqui é dizer: "conferi, não é recurso da página".
    const SO_LINK_OU_TEXTO = new Set([
      "myaccount.google.com", // link "Ativar verificação em duas etapas" (navegação, fora da CSP)
      "support.google.com", // link de ajuda
      "mail.google.com", // link "abrir o Gmail" (navegação)
      "docs.google.com", // placeholder de campo de texto
      "www.w3.org", // namespace xmlns do SVG do pino do mapa (não é requisição)
      "app.crmagro.example", // o próprio app (origens aceitas pela ponte da extensão)
      "legacy.crmagro.example", // domínios antigos do app
      "legacy-ip.crmagro.example",
      "oauth2.googleapis.com", // troca do código do login com Google: fetch do SERVIDOR, o navegador não chama
      "127.0.0.1", // desenvolvimento (nomes sem ponto, como localhost, nem entram na varredura)
    ]);
    const politica = montarCsp({ nonce: novoNonce(), modo: "aplicada", hosts: { publico: "https://app.crmagro.example" } });
    const naPolitica = new Set([...HOSTS_DO_MAPA, ...HOSTS_DO_LOGIN].map((o) => new URL(o).host));
    const achados: string[] = [];
    for (const a of codigo) {
      for (const m of a.texto.matchAll(/https?:\/\/([A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+)/g)) {
        const host = m[1]!;
        if (SO_LINK_OU_TEXTO.has(host)) continue;
        if (naPolitica.has(host) && politica.includes(`://${host}`)) continue;
        achados.push(`${a.caminho}: ${host}`);
      }
    }
    expect(achados, "host novo no código: ele precisa entrar na política (lib/csp.ts) ou na lista de só-link").toEqual([]);
  });
});
