/**
 * Relay hub — conectar conta social (Instagram/LinkedIn) via SESSÃO já logada
 * no navegador do usuário, capturada pela extensão (chrome.cookies), em vez de
 * o usuário colar o cookie na mão.
 *
 * Fluxo:
 *   extensão (chrome.cookies.getAll na allowlist) → POST aqui (Bearer relayToken)
 *   → authenticate() resolve teamId → runWithTeam → connectSocialAccount()
 *   → cookie CIFRADO como ChannelAccount (mesmo caminho da tela manual).
 *
 * A conta fica marcada `origem: "extensao"`: o worker NÃO valida nem usa o cookie dela
 * (a sessão é conferida pela própria extensão, no IP de quem usa). Ver social/verificacao.ts.
 *
 * SEGURANÇA: reusa a criptografia do ChannelAccount (encryptCredentials dentro
 * do connectSocialAccount). O cookie NUNCA é logado aqui. Só redes da allowlist.
 * Quando a conexão vem da tela do CRM Agro (`esperado` + `origemPagina`), confere a
 * origem e que o token é do MESMO usuário da tela (lib/relay-social.ts).
 *
 */
import { runWithTeam } from "@crmagro/db";
import { connectSocialAccount, descreverDonoDoToken } from "@crmagro/core";
import { authenticate, unauthorized } from "../_auth";
import { conferirIdentidadeEsperada, origemDoPedidoPermitida, origemDoCrmAgroPermitida } from "@/lib/relay-social";

export const dynamic = "force-dynamic";

const NETWORKS = new Set(["instagram", "linkedin"]);

interface ConnectSocialBody {
  network?: string;
  cookie?: string;
  cookies?: Record<string, unknown>;
  username?: string;
  label?: string;
  /**
   * Só quando a conexão nasce numa página do CRM Agro (ponte página <-> extensão):
   * o usuário/time da SESSÃO da página e a origem dela. O popup da extensão não manda.
   */
  esperado?: unknown;
  origemPagina?: unknown;
}

/** Origens aceitas além da lista fixa: a deste pedido (atrás do Caddy) e as do .env. */
function origensExtras(req: Request): string[] {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  return [host ? `${proto}://${host}` : "", process.env.AUTH_URL ?? "", process.env.APP_PUBLIC_URL ?? ""].filter(Boolean);
}

/** POST /api/relay/connect-social — recebe o cookie da sessão logada e salva cifrado. */
export async function POST(req: Request): Promise<Response> {
  const opcoesOrigem = { extras: origensExtras(req), producao: process.env.NODE_ENV === "production" };
  // Página de OUTRO site chamando esta rota (Origin http(s) fora do CRM Agro): recusa antes de tudo.
  // A extensão fala do service worker (Origin chrome-extension://… ou ausente) e passa.
  if (!origemDoPedidoPermitida(req.headers.get("origin"), opcoesOrigem)) {
    return Response.json({ error: "origem_nao_permitida" }, { status: 403 });
  }

  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  let body: ConnectSocialBody;
  try {
    body = (await req.json()) as ConnectSocialBody;
  } catch {
    return Response.json({ error: "corpo inválido" }, { status: 400 });
  }

  // Conexão vinda de uma tela do CRM Agro: a origem informada tem de ser do CRM Agro e a
  // identidade da sessão da tela tem de ser a do dono do token da extensão.
  if (body.origemPagina !== undefined) {
    if (typeof body.origemPagina !== "string" || !origemDoCrmAgroPermitida(body.origemPagina, opcoesOrigem)) {
      return Response.json({ error: "origem_nao_permitida" }, { status: 403 });
    }
    // Com origem de página, a identidade é obrigatória (senão a conferência não existe).
    if (body.esperado === undefined || body.esperado === null) {
      return Response.json({ error: "identidade_ausente" }, { status: 400 });
    }
  }
  const identidade = conferirIdentidadeEsperada(body.esperado, { teamId: auth.teamId, userId: auth.userId });
  if (identidade === "invalida") return Response.json({ error: "identidade_invalida" }, { status: 400 });
  if (identidade === "diferente") {
    // O token da extensão é de outro usuário/time que o da tela: nada é gravado.
    return Response.json({ error: "conta_diferente" }, { status: 409 });
  }

  const network = String(body.network ?? "").toLowerCase();
  if (!NETWORKS.has(network)) {
    return Response.json({ error: "network inválida (use instagram|linkedin)" }, { status: 400 });
  }

  const cookie = typeof body.cookie === "string" ? body.cookie.trim() : "";
  if (!cookie) {
    // Extensão não achou a sessão → usuário precisa logar na rede primeiro.
    return Response.json({ error: "sem_sessao" }, { status: 422 });
  }
  // Sanidade: cookie de sessão é opaco/curto-ish; barra payloads absurdos.
  if (cookie.length > 4096) {
    return Response.json({ error: "cookie inválido" }, { status: 400 });
  }

  // Bundle de cookies extras (JSESSIONID, bcookie…): só chaves conhecidas, string,
  // curtas. Nunca logado. A allowlist evita o servidor guardar cookie arbitrário.
  const COOKIE_ALLOW = new Set([
    "sessionid",
    "ds_user_id",
    "csrftoken",
    "mid",
    "li_at",
    "JSESSIONID",
    "bcookie",
    "liap",
  ]);
  const cookies: Record<string, string> = {};
  if (body.cookies && typeof body.cookies === "object") {
    for (const [k, v] of Object.entries(body.cookies)) {
      if (COOKIE_ALLOW.has(k) && typeof v === "string" && v.trim() && v.length <= 4096) {
        cookies[k] = v.trim();
      }
    }
  }

  const username = typeof body.username === "string" ? body.username.trim().slice(0, 120) : "";
  const label =
    (typeof body.label === "string" && body.label.trim()) ||
    (username ? `@${username}` : network === "instagram" ? "Instagram" : "LinkedIn");

  try {
    // Age com a identidade do dono do token (RBAC): conectar rede social é admin.
    const res = await runWithTeam(
      auth.teamId,
      async () =>
        connectSocialAccount(
          {
            canal: network as "instagram" | "linkedin",
            label,
            cookie,
            ...(Object.keys(cookies).length ? { cookies } : {}),
            // @ da sessão: amarra a conta ao navegador certo (item 1.8, INT-08).
            ...(username ? { username } : {}),
          },
          // Conectada pela extensão: o servidor não valida nem reabre esta sessão
          // (o worker pula contas assim; ver contaSoPelaExtensao no core).
          { origem: "extensao" },
        ),
      { userId: auth.userId ?? undefined, role: auth.role ?? undefined },
    );
    // De quem é o token: o popup mostra "no CRM Agro de <nome>" (ver connect/route.ts).
    const usuario = await descreverDonoDoToken(auth.teamId, auth.userId).catch(() => ({ nome: null, time: null }));
    return Response.json({
      ok: true,
      connected: res.connected,
      network,
      username: username || undefined,
      label,
      error: res.connected ? undefined : res.error,
      usuario,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "ForbiddenError") {
      return Response.json({ error: "ForbiddenError" }, { status: 403 });
    }
    // NUNCA incluir o cookie no erro/log.
    return Response.json(
      { error: e instanceof Error ? e.message : "falha ao conectar" },
      { status: 500 },
    );
  }
}
