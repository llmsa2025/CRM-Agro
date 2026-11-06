import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A CSP no middleware: um nonce por requisição de PÁGINA, o mesmo valor na REQUISIÇÃO (de onde o Next o lê
 * para os scripts dele) e na RESPOSTA (o que o navegador aplica), e nada de CSP no que não é página.
 * O comportamento antigo (redirecionar sem sessão, 429, 403) tem de seguir idêntico.
 */
const getToken = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown> | null> => ({ teamId: "t1", role: "owner" })));
// Só o getToken é falso (sessão do CRM); encode/decode ficam reais.
vi.mock("next-auth/jwt", async (importOriginal) => ({ ...(await importOriginal<typeof import("next-auth/jwt")>()), getToken }));

const { middleware } = await import("../middleware");

const RELATORIO = "content-security-policy-report-only";
const APLICADA = "content-security-policy";

function pedir(caminho: string, cab: Record<string, string> = {}, metodo = "GET") {
  return middleware(
    new NextRequest(`https://app.crmagro.example${caminho}`, {
      method: metodo,
      headers: { "sec-fetch-dest": "document", accept: "text/html", host: "app.crmagro.example", ...cab },
    }),
  );
}

/** Nonce que o middleware entregou ao Next (cabeçalho da requisição, via override). */
const nonceDaRequisicao = (r: Response) => r.headers.get("x-middleware-request-x-nonce");
const nonceDoCabecalho = (valor: string | null) => /'nonce-([^']+)'/.exec(valor ?? "")?.[1] ?? null;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CSP_MODO", "");
  vi.stubEnv("AUTH_URL", "https://app.crmagro.example");
  vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
  getToken.mockResolvedValue({ teamId: "t1", role: "owner" });
});
afterEach(() => vi.unstubAllEnvs());

describe("modo padrão (relatorio)", () => {
  it("página pública (/login): cabeçalho Report-Only na resposta e o mesmo nonce na requisição do Next", async () => {
    const r = await pedir("/login");
    const csp = r.headers.get(RELATORIO)!;
    expect(csp).toContain("script-src 'nonce-");
    expect(r.headers.get(APLICADA)).toBeNull();
    expect(nonceDoCabecalho(csp)).toBe(nonceDaRequisicao(r));
    expect(r.headers.get("x-middleware-request-content-security-policy-report-only")).toBe(csp);
    expect(r.headers.get("x-middleware-override-headers")).toMatch(/x-nonce/);
    expect(r.headers.get("reporting-endpoints")).toBeNull();
  });

  it("página autenticada: também leva a política, com o Supabase do ambiente", async () => {
    const r = await pedir("/contatos");
    expect(r.status).toBe(200);
    const csp = r.headers.get(RELATORIO)!;
    expect(csp).toContain("img-src 'self' data: blob: https://proj.supabase.co");
    expect(csp).toContain("connect-src 'self' wss://app.crmagro.example");
    expect(csp).not.toContain("frame-ancestors");
  });

  it("um nonce novo a cada requisição", async () => {
    const nonces = new Set<string | null>();
    for (let i = 0; i < 20; i++) nonces.add(nonceDaRequisicao(await pedir("/login")));
    expect(nonces.size).toBe(20);
    expect(nonces.has(null)).toBe(false);
  });

  it("valor inválido em CSP_MODO cai no relatório, nunca no bloqueio", async () => {
    vi.stubEnv("CSP_MODO", "ligada-por-engano");
    const r = await pedir("/login");
    expect(r.headers.get(RELATORIO)).toBeTruthy();
    expect(r.headers.get(APLICADA)).toBeNull();
  });
});

describe("modo aplicada", () => {
  it("manda Content-Security-Policy (e não o Report-Only), com frame-ancestors, e o nonce vai na requisição", async () => {
    vi.stubEnv("CSP_MODO", "aplicada");
    const r = await pedir("/login");
    const csp = r.headers.get(APLICADA)!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get(RELATORIO)).toBeNull();
    expect(r.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(nonceDoCabecalho(csp)).toBe(nonceDaRequisicao(r));
  });
});

describe("modo desligada: o app se comporta como antes da CSP", () => {
  it("sem cabeçalho de CSP e sem nonce na requisição", async () => {
    vi.stubEnv("CSP_MODO", "desligada");
    for (const caminho of ["/login", "/contatos"]) {
      const r = await pedir(caminho);
      expect(r.status, caminho).toBe(200);
      expect(r.headers.get(RELATORIO), caminho).toBeNull();
      expect(r.headers.get(APLICADA), caminho).toBeNull();
      expect(r.headers.get("x-middleware-override-headers"), caminho).toBeNull();
      expect(nonceDaRequisicao(r), caminho).toBeNull();
    }
  });
});

describe("o que NÃO leva CSP", () => {
  it("API (pública ou protegida), mesmo pedida como documento", async () => {
    expect((await pedir("/api/health")).headers.get(RELATORIO)).toBeNull();
    expect((await pedir("/api/contacts")).headers.get(RELATORIO)).toBeNull();
    expect((await pedir("/api/csp-report", {}, "POST")).headers.get(RELATORIO)).toBeNull();
  });

  it("worker do MapLibre e service worker de push (Sec-Fetch-Dest worker)", async () => {
    const w = await pedir("/maplibre/maplibre-gl-worker.mjs", { "sec-fetch-dest": "worker", accept: "*/*" });
    expect(w.headers.get(RELATORIO)).toBeNull();
    expect(nonceDaRequisicao(w)).toBeNull();
    const sw = await pedir("/sw-push.js", { "sec-fetch-dest": "serviceworker", accept: "*/*" });
    expect(sw.headers.get(RELATORIO)).toBeNull();
  });

  it("navegação do lado do cliente do Next (RSC) e fetch (Sec-Fetch-Dest empty)", async () => {
    expect((await pedir("/contatos", { rsc: "1", "sec-fetch-dest": "empty", accept: "text/x-component" })).headers.get(RELATORIO)).toBeNull();
  });

  it("arquivo estático da raiz", async () => {
    const r = await pedir("/logo.svg", { "sec-fetch-dest": "image", accept: "image/*" });
    expect(r.headers.get(RELATORIO)).toBeNull();
  });

  it("redirecionamento para o login (sem sessão): segue igual, sem CSP", async () => {
    getToken.mockResolvedValue(null);
    const r = await pedir("/contatos");
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("https://app.crmagro.example/login?next=%2Fcontatos");
    expect(r.headers.get(RELATORIO)).toBeNull();
  });

  it("429 das telas de conta segue igual, sem CSP", async () => {
    const cab = { "x-forwarded-for": "198.51.100.77", "sec-fetch-dest": "empty" };
    let ultima: Response | undefined;
    for (let i = 0; i < 12; i++) ultima = await pedir("/esqueci-senha", cab, "POST");
    expect(ultima!.status).toBe(429);
    expect(ultima!.headers.get(RELATORIO)).toBeNull();
  });
});

describe("a política não confia no cabeçalho Host", () => {
  it("host forjado com texto de diretiva não entra na política", async () => {
    vi.stubEnv("AUTH_URL", "");
    const r = await pedir("/login", { "x-forwarded-host": "evil.com; script-src * 'unsafe-inline'", "x-forwarded-proto": "https" });
    const csp = r.headers.get(RELATORIO) ?? "";
    expect(csp).not.toMatch(/evil|\*/);
    expect(/script-src ([^;]*)/.exec(csp)?.[1]).toMatch(/^'nonce-[^']+' 'strict-dynamic' 'self'$/);
  });
});

describe("relatório da CSP", () => {
  it("/api/csp-report segue público: POST passa sem sessão", async () => {
    getToken.mockResolvedValue(null);
    const r = await pedir("/api/csp-report", { "sec-fetch-dest": "empty" }, "POST");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-middleware-next")).toBe("1");
  });
});
