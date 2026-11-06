import { describe, expect, it } from "vitest";
// A própria função do Next que lê o nonce do cabeçalho: se um upgrade do Next mudar o formato que ele
// aceita, o teste quebra aqui em vez de a página sair sem nonce em produção.
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import {
  ENDPOINT_RELATORIO,
  hostsDoAmbiente,
  modoCsp,
  montarCsp,
  nomeDoCabecalhoCsp,
  novoNonce,
  origemSegura,
  pedidoDeDocumento,
} from "./csp";

const NONCE = "YWJjZGVmZ2hpamtsbW5vcA==";
const SUPABASE = "https://abcd1234.supabase.co";
const HOSTS = { publico: "https://app.crmagro.example", supabase: SUPABASE };

/** Diretiva por nome: `diretivas(p).get("img-src")` devolve os tokens. */
function diretivas(politica: string): Map<string, string[]> {
  const mapa = new Map<string, string[]>();
  for (const parte of politica.split(";")) {
    const [nome, ...fontes] = parte.trim().split(/\s+/);
    if (nome) mapa.set(nome, fontes);
  }
  return mapa;
}

const aplicada = () => diretivas(montarCsp({ nonce: NONCE, modo: "aplicada", hosts: HOSTS }));
const relatorio = () => diretivas(montarCsp({ nonce: NONCE, modo: "relatorio", hosts: HOSTS }));

describe("montarCsp: cada diretiva da política", () => {
  it("default-src só da própria origem", () => {
    expect(aplicada().get("default-src")).toEqual(["'self'"]);
  });

  it("script-src: nonce e strict-dynamic, sem unsafe-inline nem unsafe-eval", () => {
    const script = aplicada().get("script-src")!;
    expect(script).toContain(`'nonce-${NONCE}'`);
    expect(script).toContain("'strict-dynamic'");
    expect(script).toContain("'self'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("*");
    expect(script.some((s) => s.startsWith("http"))).toBe(false);
  });

  it("style-src: unsafe-inline (inevitável hoje: sonner, react-style-singleton, next-themes e style={})", () => {
    expect(aplicada().get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("img-src: próprio, data:, blob: e o Supabase Storage", () => {
    expect(aplicada().get("img-src")).toEqual(["'self'", "data:", "blob:", SUPABASE]);
  });

  it("media-src: próprio, blob: (anexo local) e o Supabase Storage", () => {
    expect(aplicada().get("media-src")).toEqual(["'self'", "blob:", SUPABASE]);
  });

  it("font-src: só o próprio (next/font serve as fontes do build)", () => {
    expect(aplicada().get("font-src")).toEqual(["'self'"]);
  });

  it("connect-src: próprio, wss do host público e os tiles do mapa", () => {
    expect(aplicada().get("connect-src")).toEqual([
      "'self'",
      "wss://app.crmagro.example",
      "https://tiles.openfreemap.org",
      "https://server.arcgisonline.com",
    ]);
  });

  it("worker-src: próprio e blob: (worker do MapLibre e service worker de push)", () => {
    expect(aplicada().get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("object-src e frame-src: nenhum", () => {
    expect(aplicada().get("object-src")).toEqual(["'none'"]);
    expect(aplicada().get("frame-src")).toEqual(["'none'"]);
  });

  it("base-uri: só o próprio; form-action: próprio e o Google (redirect do login)", () => {
    expect(aplicada().get("base-uri")).toEqual(["'self'"]);
    expect(aplicada().get("form-action")).toEqual(["'self'", "https://accounts.google.com"]);
  });

  it("manifest-src: só o próprio", () => {
    expect(aplicada().get("manifest-src")).toEqual(["'self'"]);
  });

  it("frame-ancestors 'none' só quando aplicada (em relatório o navegador ignora e avisa no console)", () => {
    expect(aplicada().get("frame-ancestors")).toEqual(["'none'"]);
    expect(relatorio().has("frame-ancestors")).toBe(false);
  });

  it("relatórios vão para o endpoint do app por report-uri (e não por report-to: com ele o Chrome ignora o report-uri)", () => {
    expect(aplicada().get("report-uri")).toEqual([ENDPOINT_RELATORIO]);
    expect(aplicada().has("report-to")).toBe(false);
    expect(relatorio().get("report-uri")).toEqual([ENDPOINT_RELATORIO]);
  });

  it("relatório e aplicada têm as mesmas diretivas de conteúdo (só frame-ancestors muda)", () => {
    const a = aplicada();
    const r = relatorio();
    a.delete("frame-ancestors");
    expect([...r.keys()]).toEqual([...a.keys()]);
    for (const [nome, fontes] of r) expect(a.get(nome), nome).toEqual(fontes);
  });

  it("não usa upgrade-insecure-requests nem report-sample (nada de trecho de código no relatório)", () => {
    const texto = montarCsp({ nonce: NONCE, modo: "aplicada", hosts: HOSTS });
    expect(texto).not.toContain("upgrade-insecure-requests");
    expect(texto).not.toContain("report-sample");
  });

  it("modo desligada não monta política", () => {
    expect(montarCsp({ nonce: NONCE, modo: "desligada", hosts: HOSTS })).toBe("");
  });
});

describe("montarCsp: ordem, dev e extras", () => {
  it("script-src vem antes de qualquer script-src-elem ou script-src-attr (o Next lê a primeira que começa com script-src)", () => {
    const nomes = [...aplicada().keys()];
    expect(nomes.filter((n) => n.startsWith("script-src"))).toEqual(["script-src"]);
    expect(nomes.indexOf("script-src")).toBeLessThan(nomes.indexOf("style-src"));
  });

  it("o Next acha o nonce no cabeçalho montado (protege contra mudança no Next)", () => {
    for (const modo of ["relatorio", "aplicada"] as const) {
      expect(getScriptNonceFromHeader(montarCsp({ nonce: NONCE, modo, hosts: HOSTS })), modo).toBe(NONCE);
    }
    const gerado = novoNonce();
    expect(getScriptNonceFromHeader(montarCsp({ nonce: gerado, modo: "aplicada", hosts: HOSTS }))).toBe(gerado);
  });

  it("dev: unsafe-eval no script e ws:/wss: na conexão; produção nunca", () => {
    const dev = diretivas(montarCsp({ nonce: NONCE, modo: "relatorio", hosts: HOSTS, dev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toEqual(expect.arrayContaining(["ws:", "wss:"]));
    expect(aplicada().get("script-src")).not.toContain("'unsafe-eval'");
    expect(aplicada().get("connect-src")).not.toContain("ws:");
  });

  it("sem Supabase (ou com valor inválido): img-src e media-src ficam sem host externo", () => {
    for (const supabase of [undefined, null, "", "isso não é url", "http://x.supabase.co", "ftp://x.com"]) {
      const d = diretivas(montarCsp({ nonce: NONCE, modo: "aplicada", hosts: { ...HOSTS, supabase } }));
      expect(d.get("img-src"), String(supabase)).toEqual(["'self'", "data:", "blob:"]);
      expect(d.get("media-src"), String(supabase)).toEqual(["'self'", "blob:"]);
    }
  });

  it("sem origem pública: connect-src fica só com 'self' e os tiles (sem wss solto)", () => {
    const d = diretivas(montarCsp({ nonce: NONCE, modo: "aplicada", hosts: { supabase: SUPABASE } }));
    expect(d.get("connect-src")).toEqual(["'self'", "https://tiles.openfreemap.org", "https://server.arcgisonline.com"]);
  });

  it("app em http (teste local em loopback): ws:// do próprio host", () => {
    const d = diretivas(montarCsp({ nonce: NONCE, modo: "aplicada", hosts: { publico: "http://127.0.0.1:3991" } }));
    expect(d.get("connect-src")).toContain("ws://127.0.0.1:3991");
  });

  it("extras (ex.: camada CAR do Mapa) entram em connect-src e img-src, e são validados", () => {
    const d = diretivas(montarCsp({ nonce: NONCE, modo: "aplicada", hosts: { ...HOSTS, extras: ["https://geoserver.car.gov.br/ows?x=1", "javascript:alert(1)"] } }));
    expect(d.get("connect-src")).toContain("https://geoserver.car.gov.br");
    expect(d.get("img-src")).toContain("https://geoserver.car.gov.br");
    expect(montarCsp({ nonce: NONCE, modo: "aplicada", hosts: { ...HOSTS, extras: ["javascript:alert(1)"] } })).not.toContain("javascript");
  });

  it("nonce em formato inválido nunca vira política (injeção de diretiva)", () => {
    for (const ruim of ["", "curto", "abc; script-src *", "a b c d e f g h i j k l m n o p", "'nonce-x'", "x".repeat(15), "áéíóúáéíóúáéíóúáéíóú"]) {
      expect(() => montarCsp({ nonce: ruim, modo: "aplicada", hosts: HOSTS }), ruim).toThrow();
    }
  });
});

describe("origemSegura: nada que venha do ambiente ou do Host vira diretiva", () => {
  it("devolve só a origem (sem caminho, query nem fragmento)", () => {
    expect(origemSegura("https://abcd.supabase.co/storage/v1/object/sign/x?token=segredo#f")).toBe("https://abcd.supabase.co");
    expect(origemSegura("https://exemplo.com:8443/x")).toBe("https://exemplo.com:8443");
  });

  it("recusa o que carrega separador de diretiva, aspas, espaço, curinga ou credencial", () => {
    const maus = [
      "https://x.com; script-src *",
      "https://x.com script-src *",
      "https://x.com'",
      'https://x.com"',
      "https://*.supabase.co",
      "https://u:p@x.com",
      "https://x.com,https://y.com",
      "https://",
      "//x.com",
      "x.com",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "https://x_y.com",
      "https://[::1]",
    ];
    for (const m of maus) {
      const origem = origemSegura(m);
      if (origem === null) continue;
      // Se aceitou, o resultado tem de ser uma origem limpa, sem nada que quebre a política.
      expect(origem, m).toMatch(/^https:\/\/[a-z0-9.-]+(:\d+)?$/);
    }
    for (const m of ["https://x.com; script-src *", 'https://x.com"', "https://*.supabase.co", "https://u:p@x.com", "javascript:alert(1)", "x.com", "https://x_y.com", "https://[::1]"]) {
      expect(origemSegura(m), m).toBeNull();
    }
  });

  it("http só em dev ou em loopback", () => {
    expect(origemSegura("http://x.supabase.co")).toBeNull();
    expect(origemSegura("http://x.supabase.co", true)).toBe("http://x.supabase.co");
    expect(origemSegura("http://127.0.0.1:3991")).toBe("http://127.0.0.1:3991");
    expect(origemSegura("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("valor malicioso em qualquer entrada do ambiente não acrescenta diretiva à política", () => {
    const maliciosos = ["https://x.com; script-src * 'unsafe-inline'", "https://x.com\nscript-src *", "https://a.com https://b.com"];
    for (const m of maliciosos) {
      const hosts = hostsDoAmbiente({ SUPABASE_URL: m, AUTH_URL: m, APP_PUBLIC_URL: m }, m, false);
      const texto = montarCsp({ nonce: NONCE, modo: "aplicada", hosts: { ...hosts, extras: [m], mapa: [m], login: [m] } });
      expect(texto, m).not.toMatch(/\*/);
      expect(texto, m).not.toContain("'unsafe-inline' https");
      expect(diretivas(texto).get("script-src"), m).toEqual([`'nonce-${NONCE}'`, "'strict-dynamic'", "'self'"]);
    }
  });
});

describe("hostsDoAmbiente", () => {
  it("lê a origem do Supabase e a pública do ambiente", () => {
    expect(hostsDoAmbiente({ SUPABASE_URL: "https://proj.supabase.co/rest/v1", AUTH_URL: "https://app.crmagro.example" }, "https://outro.com", false)).toEqual({
      publico: "https://app.crmagro.example",
      supabase: "https://proj.supabase.co",
    });
  });

  it("sem AUTH_URL, usa APP_PUBLIC_URL e depois a origem do pedido", () => {
    expect(hostsDoAmbiente({ APP_PUBLIC_URL: "https://app.crmagro.example" }, "https://x.com", false).publico).toBe("https://app.crmagro.example");
    expect(hostsDoAmbiente({}, "https://app.crmagro.example", false)).toEqual({ publico: "https://app.crmagro.example", supabase: null });
    expect(hostsDoAmbiente({}, "https://evil.com; script-src *", false).publico).toBeNull();
  });

  it("trocar SUPABASE_URL (banco novo) muda a política sem mexer no código", () => {
    const antes = montarCsp({ nonce: NONCE, modo: "aplicada", hosts: hostsDoAmbiente({ SUPABASE_URL: "https://velho.supabase.co" }, null, false) });
    const depois = montarCsp({ nonce: NONCE, modo: "aplicada", hosts: hostsDoAmbiente({ SUPABASE_URL: "https://novo.supabase.co" }, null, false) });
    expect(antes).toContain("https://velho.supabase.co");
    expect(antes).not.toContain("novo.supabase.co");
    expect(depois).toContain("https://novo.supabase.co");
    expect(depois).not.toContain("velho.supabase.co");
  });
});

describe("novoNonce", () => {
  it("128 bits em base64, diferente a cada chamada, no formato que o Next lê", () => {
    const a = novoNonce();
    const b = novoNonce();
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(16);
    expect(a).toMatch(/^[A-Za-z0-9+/_-]{16,}={0,2}$/);
  });
});

describe("modoCsp (CSP_MODO)", () => {
  it("ausente, vazio ou lixo = relatorio (o padrão, nunca liga o bloqueio por engano)", () => {
    for (const v of [undefined, null, "", "   ", "lixo", "1", "true", "on", "ligada", "sim", "x".repeat(500)]) {
      expect(modoCsp(v), String(v)).toBe("relatorio");
    }
  });

  it("reconhece os três modos e os apelidos, sem ligar maiúscula ou espaço", () => {
    expect(modoCsp("desligada")).toBe("desligada");
    expect(modoCsp(" DESLIGADA ")).toBe("desligada");
    expect(modoCsp("desligado")).toBe("desligada");
    expect(modoCsp("off")).toBe("desligada");
    expect(modoCsp("relatorio")).toBe("relatorio");
    expect(modoCsp("relatório")).toBe("relatorio");
    expect(modoCsp("report-only")).toBe("relatorio");
    expect(modoCsp("aplicada")).toBe("aplicada");
    expect(modoCsp("Aplicada")).toBe("aplicada");
    expect(modoCsp("enforce")).toBe("aplicada");
  });

  it("nomes herdados do Object (constructor, toString, __proto__) não viram modo", () => {
    for (const v of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(modoCsp(v), v).toBe("relatorio");
  });
});

describe("nomeDoCabecalhoCsp", () => {
  it("um cabeçalho por modo", () => {
    expect(nomeDoCabecalhoCsp("desligada")).toBeNull();
    expect(nomeDoCabecalhoCsp("relatorio")).toBe("Content-Security-Policy-Report-Only");
    expect(nomeDoCabecalhoCsp("aplicada")).toBe("Content-Security-Policy");
  });
});

describe("pedidoDeDocumento", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it("navegação de página (Sec-Fetch-Dest: document) recebe CSP", () => {
    expect(pedidoDeDocumento(h({ "sec-fetch-dest": "document" }), "/contatos")).toBe(true);
    expect(pedidoDeDocumento(h({ "sec-fetch-dest": "document" }), "/login")).toBe(true);
  });

  it("worker, fetch, script, imagem e iframe não recebem", () => {
    for (const dest of ["worker", "serviceworker", "empty", "script", "image", "style", "iframe", "audio", "font"]) {
      expect(pedidoDeDocumento(h({ "sec-fetch-dest": dest, accept: "text/html" }), "/maplibre/maplibre-gl-worker.mjs"), dest).toBe(false);
    }
  });

  it("sem Sec-Fetch-Dest (curl, Safari antigo): vale o Accept", () => {
    expect(pedidoDeDocumento(h({ accept: "text/html,application/xhtml+xml" }), "/login")).toBe(true);
    expect(pedidoDeDocumento(h({ accept: "*/*" }), "/login")).toBe(false);
    expect(pedidoDeDocumento(h({}), "/login")).toBe(false);
  });

  it("API e requisição RSC do Next (navegação do lado do cliente) nunca recebem", () => {
    expect(pedidoDeDocumento(h({ "sec-fetch-dest": "document", accept: "text/html" }), "/api/health")).toBe(false);
    expect(pedidoDeDocumento(h({ accept: "text/html" }), "/api")).toBe(false);
    expect(pedidoDeDocumento(h({ accept: "text/html", rsc: "1" }), "/contatos")).toBe(false);
    expect(pedidoDeDocumento(h({ "sec-fetch-dest": "document", rsc: "1" }), "/contatos")).toBe(false);
  });
});
