import { NextResponse } from "next/server";
import { runWithTeam } from "@crmagro/db";
import { iniciarConexaoLinkedin, logger } from "@crmagro/core";
import { currentUser, identidade } from "@/lib/tenant";
import { origemPublica } from "@/lib/google-agenda";
import {
  codigoDoErroLinkedin,
  COOKIE_LINKEDIN,
  destinoDaVoltaLinkedin,
  detalheDoErroLinkedin,
  OPCOES_COOKIE_LINKEDIN,
  type TelaDeVoltaLinkedin,
  valorCookieLinkedin,
} from "@/lib/linkedin-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Entrar com LinkedIn": manda a pessoa para a tela de permissão do LinkedIn. O `state` vai assinado e
 * amarrado à sessão; o nonce fica num cookie httpOnly deste navegador (10 min). A permissão (membro, tela
 * Integrações) é conferida no core.
 *
 * `?volta=` diz de onde a pessoa saiu (`canais` ou `integracoes`; o resto vira `canais`).
 */
export async function GET(req: Request) {
  const base = origemPublica(req);
  const pedida = new URL(req.url).searchParams.get("volta");
  const volta: TelaDeVoltaLinkedin = pedida === "integracoes" ? "integracoes" : "canais";
  const user = await currentUser();
  if (!user) {
    const login = new URL("/login", base);
    login.searchParams.set("next", destinoDaVoltaLinkedin(volta));
    return NextResponse.redirect(login);
  }
  try {
    const r = await runWithTeam(user.teamId, async () => iniciarConexaoLinkedin({ volta }), identidade(user));
    const res = NextResponse.redirect(r.url);
    res.cookies.set(COOKIE_LINKEDIN, valorCookieLinkedin({ nonce: r.nonce, volta }), { ...OPCOES_COOKIE_LINKEDIN, maxAge: 600 });
    return res;
  } catch (e) {
    const codigo = codigoDoErroLinkedin(e);
    if (codigo === "falhou" || codigo === "configuracao") logger.warn({ err: detalheDoErroLinkedin(e), codigo }, "[linkedin] não iniciei a conexão");
    return NextResponse.redirect(new URL(destinoDaVoltaLinkedin(volta, codigo), base));
  }
}
