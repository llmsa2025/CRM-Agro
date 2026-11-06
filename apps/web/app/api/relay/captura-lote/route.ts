/**
 * Relay hub: lote de seguidores do Instagram lido PELA EXTENSÃO (tarefa `ig_followers`).
 *
 * A extensão lê a lista no navegador de quem pediu (IP residencial, sessão do Chrome) e manda
 * os perfis em lotes pequenos para cá. A rota grava na fila da Captação (a mesma que o worker usa:
 * `insertDrafts`), atualiza o status do lote que a tela lê e devolve se a busca já terminou.
 *
 * Autenticação: o token da extensão (Bearer), que resolve time, pessoa e papel. Tudo o que decide
 * (lote existe neste time, é desta pessoa, ainda está aberto, limite, dedupe) está em
 * `registrarLoteDaExtensao` (packages/core/src/captacao/instagram-extensao.ts), com teste.
 *
 * O cookie do Instagram NUNCA passa por aqui: a extensão só manda @, nome e bio.
 */
import { ZodError } from "zod";
import { runWithTeam } from "@crmagro/db";
import { ForbiddenError, LoteOcupado, registrarLoteDaExtensao } from "@crmagro/core";
import { authenticate, unauthorized } from "../_auth";
import { origemDoPedidoPermitida } from "@/lib/relay-social";

export const dynamic = "force-dynamic";

/** Um lote é no máximo 100 perfis com bio: bem abaixo disto. */
const MAX_BODY_BYTES = 256 * 1024;

const STATUS_DO_ERRO: Record<string, number> = {
  lote_inexistente: 404,
  lote_de_outra_pessoa: 403,
  lote_encerrado: 409,
};

export async function POST(req: Request): Promise<Response> {
  // Página de OUTRO site chamando esta rota (Origin http(s) fora do CRM Agro): recusa antes de tudo.
  // A extensão fala do service worker (Origin chrome-extension://... ou ausente) e passa.
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const extras = [host ? `${proto}://${host}` : "", process.env.AUTH_URL ?? "", process.env.APP_PUBLIC_URL ?? ""].filter(Boolean);
  if (!origemDoPedidoPermitida(req.headers.get("origin"), { extras, producao: process.env.NODE_ENV === "production" })) {
    return Response.json({ error: "origem_nao_permitida" }, { status: 403 });
  }

  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > MAX_BODY_BYTES) return Response.json({ error: "corpo_grande_demais" }, { status: 413 });
  let bruto: string;
  try {
    bruto = await req.text();
  } catch {
    return Response.json({ error: "corpo inválido" }, { status: 400 });
  }
  if (bruto.length > MAX_BODY_BYTES) return Response.json({ error: "corpo_grande_demais" }, { status: 413 });
  let corpo: unknown;
  try {
    corpo = JSON.parse(bruto);
  } catch {
    return Response.json({ error: "json inválido" }, { status: 400 });
  }

  try {
    // Age com a identidade do dono do token (RBAC): sem papel ou sem pessoa, nada entra.
    const r = await runWithTeam(auth.teamId, () => registrarLoteDaExtensao(corpo), {
      userId: auth.userId ?? undefined,
      role: auth.role ?? undefined,
    });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof ZodError) return Response.json({ error: "lote_invalido" }, { status: 400 });
    if (e instanceof ForbiddenError) return Response.json({ error: "ForbiddenError" }, { status: 403 });
    if (e instanceof LoteOcupado) return Response.json({ error: "lote_ocupado" }, { status: 409 });
    const codigo = e instanceof Error ? (e as { codigo?: string }).codigo : undefined;
    if (codigo && STATUS_DO_ERRO[codigo]) return Response.json({ error: codigo }, { status: STATUS_DO_ERRO[codigo] });
    // Nada de detalhe do erro na resposta (pode citar dado interno).
    return Response.json({ error: "falha" }, { status: 500 });
  }
}
