import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { ipDoPedido, tentativaNaBorda, TELAS_DE_CONTA } from "@/lib/limite-borda";
import { telaDoCaminho, temTela } from "@/lib/telas";
import { PUBLICO } from "@/lib/rotas-publicas";
import { hostsDoAmbiente, modoCsp, montarCsp, nomeDoCabecalhoCsp, novoNonce, pedidoDeDocumento } from "@/lib/csp";

/**
 * Porta de entrada: exige sessão em tudo, com exceções explícitas.
 *
 * Lista de permitidos (allow-list, não deny-list) — o padrão é NEGAR.
 *
 * O webhook do WhatsApp NÃO passa por aqui: a Evolution não tem sessão.
 * Ele é protegido pelo WHATSAPP_WEBHOOK_TOKEN validado na própria rota.
 *
 * IMPLEMENTAÇÃO: Usa getToken (somente JWT, sem Prisma) em vez de auth()
 * para evitar puxar @crmagro/db (que importa node:crypto) no Edge Runtime.
 *
 * CSP: aqui nasce o nonce de cada página. O modo vem de CSP_MODO, lido de process.env a cada pedido
 * (trocar = reiniciar o web, sem rebuild).
 */


function origemPublica(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}` : req.nextUrl.origin;
}

/**
 * Arquivo estático na RAIZ (ex.: /logo.svg, /icon.png, /manifest.webmanifest),
 * só em GET/HEAD. Antes o matcher pulava o middleware para QUALQUER caminho com
 * extensão: `POST /funis/x.png` com o header Next-Action casava com a rota
 * `funis/[id]` e executava a server action SEM passar pela sessão (S10).
 * Agora só escapa o que é de fato arquivo público na raiz; aninhado ou com outro
 * método passa pela regra de sessão. Asset público que precise ficar fora do
 * login em subpasta: ponha na raiz de public/ ou acrescente ao PUBLICO.
 * Os ícones da aba (app/icon.svg e app/apple-icon.png) também saem por aqui, sem
 * sessão, porque a tela de login precisa deles. O /favicon.ico nem chega ao
 * middleware, porque o matcher já o exclui.
 */
const ESTATICO_RAIZ = /^\/[^/]+\.(?:png|jpe?g|gif|svg|ico|webp|css|js|map|txt|xml|woff2?|webmanifest)$/i;

type CspDoPedido = { nonce: string; cabecalho: string; valor: string };

/**
 * CSP desta requisição, ou null (modo desligado, requisição que não é de página, ou qualquer falha).
 * Nunca lança: a CSP é uma camada a mais, e um defeito nela não pode derrubar o app.
 */
function cspDoPedido(req: NextRequest): CspDoPedido | null {
  try {
    const modo = modoCsp(process.env.CSP_MODO);
    const cabecalho = nomeDoCabecalhoCsp(modo);
    if (!cabecalho || !pedidoDeDocumento(req.headers, req.nextUrl.pathname)) return null;
    const dev = process.env.NODE_ENV !== "production";
    const nonce = novoNonce();
    const valor = montarCsp({ nonce, modo, dev, hosts: hostsDoAmbiente(process.env, origemPublica(req), dev) });
    return { nonce, cabecalho, valor };
  } catch {
    return null;
  }
}

/**
 * `NextResponse.next()` com a CSP. O cabeçalho vai na REQUISIÇÃO (é de lá que o Next lê o nonce e o põe nos
 * scripts dele; o `x-nonce` leva o mesmo valor ao layout, para o next-themes) e na RESPOSTA (é o que o
 * navegador aplica). Sem CSP, é o `next()` de sempre.
 */
function proximo(req: NextRequest, csp: CspDoPedido | null) {
  if (!csp) return NextResponse.next();
  const cabecalhos = new Headers(req.headers);
  cabecalhos.set("x-nonce", csp.nonce);
  cabecalhos.set(csp.cabecalho, csp.valor);
  const resposta = NextResponse.next({ request: { headers: cabecalhos } });
  resposta.headers.set(csp.cabecalho, csp.valor);
  return resposta;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Telas de conta sem sessão: o POST (server action) roda bcrypt — limite por
  // IP antes de chegar nele (auditoria do #52). Ver lib/limite-borda.ts.
  if (req.method === "POST" && TELAS_DE_CONTA.has(pathname)) {
    const t = tentativaNaBorda(pathname, ipDoPedido(req.headers));
    if (!t.permitido) {
      return new NextResponse("Muitas tentativas. Aguarde alguns minutos e tente de novo.", {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(t.retryAfterMs / 1000)), "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }
  const csp = cspDoPedido(req);
  if (PUBLICO.some((re) => re.test(pathname))) return proximo(req, csp);
  if ((req.method === "GET" || req.method === "HEAD") && ESTATICO_RAIZ.test(pathname)) {
    return NextResponse.next();
  }

  // Atrás do Caddy, o request interno chega em HTTP, então o getToken sozinho
  // procuraria o cookie sem prefixo (`authjs.session-token`). Mas o login grava
  // `__Secure-authjs.session-token` (o NextAuth usa cookie seguro quando AUTH_URL
  // é https). Sem alinhar isso, o middleware nunca acha a sessão e devolve todo
  // mundo pro /login — o loop de login. `secureCookie` espelha o AUTH_URL.
  // No Edge Runtime o getToken não lê o AUTH_SECRET do ambiente sozinho — precisa
  // ser passado. Sem ele, assim que o cookie certo é encontrado, estoura
  // MissingSecret (500). Antes isso ficava escondido porque o cookie nunca era achado.
  const secureCookie = (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "").startsWith("https://");
  const token = await getToken({ req, secureCookie, secret: process.env.AUTH_SECRET });
  if (!token?.teamId) {
    const url = new URL("/login", origemPublica(req));
    if (pathname !== "/") url.searchParams.set("next", pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // Telas por pessoa (F2b): sem a tela, a página vai para /sem-acesso e a API
  // responde 403 — inclusive as leituras, que não passam pelo `requireCan`.
  const tela = telaDoCaminho(pathname);
  if (tela && !temTela(typeof token.role === "string" ? token.role : null, Array.isArray(token.modulos) ? token.modulos : null, tela)) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "ForbiddenError" }, { status: 403 });
    return NextResponse.redirect(new URL(`/sem-acesso?tela=${tela}`, origemPublica(req)));
  }

  return proximo(req, csp);
}

export const config = {
  // Só os artefatos do build ficam fora. Caminho com "extensão" NÃO escapa mais
  // (ver ESTATICO_RAIZ acima).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
