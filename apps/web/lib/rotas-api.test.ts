import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLICO } from "./rotas-publicas";

/**
 * Trava de regressão da autenticação das rotas de API (auditoria de 01/10/2026).
 *
 * O middleware (`middleware.ts`) exige sessão em tudo, menos nas rotas de `PUBLICO`. Este teste varre
 * TODA `route.ts` de `app/api` e confere as duas pontas:
 *  - rota PÚBLICA (liberada no middleware): tem de estar em `PUBLICAS` abaixo, dizendo como ela se
 *    autentica sozinha, e o código da rota tem de mostrar esse mecanismo;
 *  - rota PROTEGIDA: o código tem de exigir a sessão por conta própria (defesa em profundidade, caso o
 *    middleware seja contornado), por `withTeam`, `auth()` ou `currentUser()`.
 * Criou uma rota nova? Se o teste quebrou, é de propósito: classifique a rota (e, se for pública, justifique).
 */
const RAIZ_API = join(__dirname, "..", "app", "api");

function rotasDeApi(dir: string): string[] {
  const achadas: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) achadas.push(...rotasDeApi(caminho));
    else if (nome === "route.ts") achadas.push(caminho);
  }
  return achadas;
}

/** `/api/calls/[id]/route.ts` → `/api/calls/[id]` */
const caminhoDaRota = (arquivo: string) => `/api/${relative(RAIZ_API, arquivo).replace(/\\/g, "/").replace(/\/?route\.ts$/, "")}`.replace(/\/$/, "");
/** O que o middleware vê: o parâmetro dinâmico vira um valor qualquer. */
const comoPedido = (caminho: string) => caminho.replace(/\[\.\.\.\w+\]/g, "x").replace(/\[\w+\]/g, "00000000-0000-0000-0000-000000000000");

/** Rotas públicas: o mecanismo próprio de cada uma, e o trecho que prova que ele está no código. */
const PUBLICAS: Record<string, { como: string; prova: RegExp[] }> = {
  "/api/auth/[...nextauth]": { como: "NextAuth (login, callback e sessão)", prova: [/handlers/] },
  "/api/health": { como: "só status e latência, sem dado nem mensagem de erro interna", prova: [/health/i] },
  "/api/email/track/[id]": { como: "pixel de abertura: id não adivinhável, só marca 'aberto' e devolve um GIF", prova: [/markEmailOpened/, /image\/gif/] },
  "/api/relay/captura-lote": { como: "Bearer token da extensão (hash no banco) + limite por IP", prova: [/authenticate\(req\)/, /unauthorized\(\)/] },
  "/api/relay/connect": { como: "Bearer token da extensão (hash no banco) + limite por IP", prova: [/authenticate\(req\)/, /unauthorized\(\)/] },
  "/api/relay/connect-social": { como: "Bearer token da extensão (hash no banco) + limite por IP", prova: [/authenticate\(req\)/, /unauthorized\(\)/] },
  "/api/relay/enqueue-test": { como: "Bearer token da extensão (hash no banco) + limite por IP", prova: [/authenticate\(req\)/, /unauthorized\(\)/] },
  "/api/relay/poll": { como: "Bearer token da extensão (hash no banco) + limite por IP", prova: [/authenticate\(req\)/, /unauthorized\(\)/] },
  "/api/relay/result": { como: "Bearer token da extensão (hash no banco) + limite por IP", prova: [/authenticate\(req\)/, /unauthorized\(\)/] },
  "/api/integracoes/google/notificacao": { como: "canal e token HMAC conferidos no core; só enfileira a sincronização", prova: [/receberAvisoDoGoogle/] },
  "/api/csp-report": { como: "sem sessão (o navegador posta o relatório sozinho): só POST, limite por IP, corpo máximo de 8 KB, só escreve no log campos saneados e não grava no banco", prova: [/rateLimit/, /normalizarRelatorios/] },
  "/api/webhooks/email-entrada": { como: "assinatura HMAC do Worker do Cloudflare, carimbo, endereço e limite", prova: [/aceitarEmailEncaminhado/] },
  "/api/webhooks/flow/[token]": {
    como: "token do fluxo na URL (único, gerado no servidor, só o hash no banco) + limite por token (chave com o hash, nunca o token) e por IP",
    prova: [/enrollByWebhook/, /rateLimit/, /chaveDoLimiteDoWebhook\(token\)/],
  },
  "/api/webhooks/voopi": { como: "assinatura HMAC do callback ou VOOPI_WEBHOOK_TOKEN; sem token em produção recusa", prova: [/autenticarWebhookVoopi/] },
  "/api/webhooks/whatsapp": { como: "token da instância da Evolution, conferido contra a instância do corpo", prova: [/autenticarWebhookWhatsApp/] },
};

/** Rotas protegidas que não leem dado do time (informativas): o middleware já exige sessão. */
const PROTEGIDAS_SEM_DADO = new Set(["/api/socket/io"]);

/** A rota exige a sessão sozinha (defesa em profundidade). */
const EXIGE_SESSAO = /withTeam\(|await auth\(\)|currentUser\(\)/;

const rotas = rotasDeApi(RAIZ_API).map((arquivo) => ({
  arquivo,
  caminho: caminhoDaRota(arquivo),
  codigo: readFileSync(arquivo, "utf8"),
}));
const ehPublica = (caminho: string) => PUBLICO.some((re) => re.test(comoPedido(caminho)));

describe("autenticação das rotas de API", () => {
  it("encontra as rotas (o teste não pode passar vazio)", () => {
    expect(rotas.length).toBeGreaterThanOrEqual(40);
  });

  it("toda rota pública do middleware está justificada, e só ela", () => {
    const publicas = rotas.filter((r) => ehPublica(r.caminho)).map((r) => r.caminho).sort();
    expect(publicas).toEqual(Object.keys(PUBLICAS).sort());
  });

  it.each(rotas.filter((r) => ehPublica(r.caminho)).map((r) => [r.caminho, r] as const))(
    "pública %s mostra no código o mecanismo que declarou",
    (caminho, rota) => {
      const decl = PUBLICAS[caminho];
      expect(decl, `${caminho} é pública mas não está em PUBLICAS`).toBeDefined();
      for (const prova of decl!.prova) {
        expect(rota.codigo, `${caminho}: não achei ${prova} (${decl!.como})`).toMatch(prova);
      }
    },
  );

  it.each(rotas.filter((r) => !ehPublica(r.caminho)).map((r) => [r.caminho, r] as const))(
    "protegida %s exige a sessão por conta própria",
    (caminho, rota) => {
      if (PROTEGIDAS_SEM_DADO.has(caminho)) return;
      expect(rota.codigo, `${caminho} não chama withTeam, auth() nem currentUser()`).toMatch(EXIGE_SESSAO);
    },
  );

  it("as rotas públicas de API da lista do middleware são exatamente as justificadas", () => {
    // Um padrão novo em PUBLICO que cubra /api/... sem rota correspondente também precisa aparecer aqui.
    const padroesDeApi = PUBLICO.filter((re) => re.source.startsWith("^\\/api")).map((re) => re.source);
    expect(padroesDeApi.sort()).toEqual(
      [
        "^\\/api\\/auth(\\/|$)",
        "^\\/api\\/webhooks(\\/|$)",
        "^\\/api\\/health$",
        "^\\/api\\/email\\/track(\\/|$)",
        "^\\/api\\/relay(\\/|$)",
        "^\\/api\\/integracoes\\/google\\/notificacao$",
        "^\\/api\\/csp-report$",
      ].sort(),
    );
  });
});
