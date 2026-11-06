import { describe, expect, it } from "vitest";
import { caminhoSaneado, normalizarRelatorios } from "./csp-relatorio";

/** Relatório no formato antigo (`report-uri`, application/csp-report). */
const legado = (campos: Record<string, unknown>) => ({
  "csp-report": {
    "document-uri": "https://app.crmagro.example/contatos",
    "effective-directive": "img-src",
    "violated-directive": "img-src",
    "blocked-uri": "https://cdn.exemplo.com/foto.png",
    disposition: "report",
    "original-policy": "default-src 'self'; ...",
    ...campos,
  },
});

/** Relatório no formato novo (`report-to`, application/reports+json). */
const novo = (corpo: Record<string, unknown>) => [
  {
    type: "csp-violation",
    age: 10,
    url: "https://app.crmagro.example/contatos",
    user_agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130",
    body: { effectiveDirective: "img-src", blockedURL: "https://cdn.exemplo.com/foto.png", disposition: "report", originalPolicy: "default-src 'self'", ...corpo },
  },
];

describe("normalizarRelatorios: os dois formatos", () => {
  it("formato antigo (csp-report)", () => {
    expect(normalizarRelatorios(legado({}))).toEqual([
      { diretiva: "img-src", bloqueado: "https://cdn.exemplo.com", pagina: "/contatos", disposicao: "report" },
    ]);
  });

  it("formato novo (reports+json)", () => {
    expect(normalizarRelatorios(novo({}))).toEqual([
      { diretiva: "img-src", bloqueado: "https://cdn.exemplo.com", pagina: "/contatos", disposicao: "report" },
    ]);
  });

  it("disposição enforce é mantida", () => {
    expect(normalizarRelatorios(legado({ disposition: "enforce" }))[0]?.disposicao).toBe("enforce");
    expect(normalizarRelatorios(novo({ disposition: "enforce" }))[0]?.disposicao).toBe("enforce");
  });

  it("sem effective-directive, usa a primeira palavra de violated-directive", () => {
    const r = normalizarRelatorios(legado({ "effective-directive": undefined, "violated-directive": "script-src-elem 'nonce-x'" }));
    expect(r[0]?.diretiva).toBe("script-src-elem");
  });

  it("ignora o que não é violação de CSP, lixo e formatos estranhos", () => {
    for (const lixo of [null, undefined, 1, "texto", [], {}, [1, 2], [{ type: "deprecation", body: {} }], { "csp-report": "x" }, { "csp-report": [] }]) {
      expect(normalizarRelatorios(lixo), JSON.stringify(lixo)).toEqual([]);
    }
  });

  it("no máximo 10 relatórios por pedido", () => {
    const muitos = Array.from({ length: 50 }, () => novo({})[0]);
    expect(normalizarRelatorios(muitos)).toHaveLength(10);
  });
});

describe("normalizarRelatorios: o que NUNCA vai para o log", () => {
  it("remove query e fragmento da página, do bloqueado e do arquivo", () => {
    const r = normalizarRelatorios(
      legado({
        "document-uri": "https://app.crmagro.example/redefinir-senha?token=SEGREDO123&email=a@b.com#frag",
        "blocked-uri": "https://app.crmagro.example/api/x?token=SEGREDO456",
        "source-file": "https://app.crmagro.example/_next/static/chunks/app.js?v=SEGREDO789#x",
      }),
    );
    const texto = JSON.stringify(r);
    expect(texto).not.toMatch(/SEGREDO|token|a@b\.com|frag|\?/);
    expect(r[0]).toMatchObject({ pagina: "/redefinir-senha", bloqueado: "/api/x", arquivo: "/_next/static/chunks/app.js" });
  });

  it("URL assinada do Supabase vira só o host (o caminho leva id de time e nome de arquivo)", () => {
    const r = normalizarRelatorios(legado({ "blocked-uri": "https://abc.supabase.co/storage/v1/object/sign/conversas-midia/time-123/arquivo-do-cliente.ogg?token=eyJabc" }));
    expect(r[0]?.bloqueado).toBe("https://abc.supabase.co");
  });

  it("ids no caminho da página viram :id (contato, conversa, token longo, número)", () => {
    expect(caminhoSaneado("/contatos/123e4567-e89b-42d3-a456-426614174000")).toBe("/contatos/:id");
    expect(caminhoSaneado("/fluxos/clx1234567890abcdefghijk/editar")).toBe("/fluxos/:id/editar");
    expect(caminhoSaneado("/funis/12345")).toBe("/funis/:id");
    expect(caminhoSaneado("/contatos")).toBe("/contatos");
    expect(caminhoSaneado("/")).toBe("/");
    expect(caminhoSaneado("")).toBe("/");
    expect(caminhoSaneado("/_next/static/chunks/page-0a1b2c3d.js")).toBe("/_next/static/chunks/page-0a1b2c3d.js");
  });

  it("não leva o trecho de código, a política, o user-agent nem o referrer", () => {
    const r = normalizarRelatorios(
      novo({ sample: "alert('dado do usuario')", referrer: "https://x.com/?q=segredo", statusCode: 200, lineNumber: 4, columnNumber: 9 }),
    );
    const texto = JSON.stringify(r);
    expect(texto).not.toMatch(/dado do usuario|segredo|Mozilla|default-src|referrer|sample/i);
    expect(Object.keys(r[0]!).sort()).toEqual(["bloqueado", "diretiva", "disposicao", "pagina"]);
  });

  it("data: e blob: viram só a palavra (o conteúdo pode ter dado)", () => {
    expect(normalizarRelatorios(legado({ "blocked-uri": "data:image/svg+xml;base64,AAAA" }))[0]?.bloqueado).toBe("data");
    expect(normalizarRelatorios(legado({ "blocked-uri": "blob:https://app.crmagro.example/123e4567-e89b-42d3-a456-426614174000" }))[0]?.bloqueado).toBe("blob");
  });

  it("palavras da CSP (inline, eval) passam", () => {
    expect(normalizarRelatorios(legado({ "effective-directive": "script-src-elem", "blocked-uri": "inline" }))[0]?.bloqueado).toBe("inline");
    expect(normalizarRelatorios(legado({ "effective-directive": "script-src", "blocked-uri": "eval" }))[0]?.bloqueado).toBe("eval");
  });

  it("diretiva com formato estranho vira 'desconhecida' (nada de texto livre no log)", () => {
    expect(normalizarRelatorios(legado({ "effective-directive": "x".repeat(500) }))[0]?.diretiva).toBe("desconhecida");
    expect(normalizarRelatorios(legado({ "effective-directive": "script-src; dado pessoal" }))[0]?.diretiva).toBe("desconhecida");
  });

  it("valores que não são texto não quebram nem passam", () => {
    const r = normalizarRelatorios(legado({ "blocked-uri": { x: 1 }, "document-uri": 42, "source-file": ["a"] }));
    expect(r[0]).toMatchObject({ bloqueado: "(vazio)", pagina: "(sem página)" });
  });
});

describe("normalizarRelatorios: ruído de extensão do navegador é descartado", () => {
  it("blocked-uri de extensão", () => {
    for (const esquema of ["chrome-extension", "moz-extension", "safari-extension", "safari-web-extension"]) {
      expect(normalizarRelatorios(legado({ "blocked-uri": `${esquema}://abcdef/script.js` })), esquema).toEqual([]);
      expect(normalizarRelatorios(novo({ blockedURL: `${esquema}://abcdef/script.js` })), esquema).toEqual([]);
    }
  });

  it("source-file de extensão", () => {
    expect(normalizarRelatorios(legado({ "blocked-uri": "inline", "source-file": "chrome-extension://abcdef/content.js" }))).toEqual([]);
    expect(normalizarRelatorios(novo({ blockedURL: "inline", sourceFile: "moz-extension://abcdef/content.js" }))).toEqual([]);
  });
});
