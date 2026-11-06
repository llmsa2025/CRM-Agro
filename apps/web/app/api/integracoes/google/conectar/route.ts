import { NextResponse } from "next/server";
import { runWithTeam } from "@crmagro/db";
import { iniciarConexaoGoogle, logger } from "@crmagro/core";
import { currentUser, identidade } from "@/lib/tenant";
import {
  codigoDoErroGoogle,
  COOKIE_GOOGLE_AGENDA,
  destinoDaVolta,
  detalheDoErroGoogle,
  OPCOES_COOKIE_GOOGLE_AGENDA,
  origemPublica,
  type TelaDeVolta,
  valorCookieGoogleAgenda,
} from "@/lib/google-agenda";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Conectar minha Agenda Google": manda a pessoa para a tela de consentimento
 * do Google. O `state` vai assinado e amarrado à sessão; o nonce e o
 * verificador PKCE ficam num cookie httpOnly deste navegador (10 min).
 * A permissão (membro, tela Agenda ou Integrações) é conferida no core.
 *
 * `?volta=` diz de onde a pessoa saiu (`agenda`, `canais` ou `integracoes`; o resto
 * vira `integracoes`). `?recurso=gmail` pede o `gmail.send` em cima da Agenda (E7).
 */
export async function GET(req: Request) {
  const base = origemPublica(req);
  const parametros = new URL(req.url).searchParams;
  const pedida = parametros.get("volta");
  const volta: TelaDeVolta = pedida === "agenda" || pedida === "canais" ? pedida : "integracoes";
  const recurso = parametros.get("recurso") === "gmail" ? "gmail" : undefined;
  const user = await currentUser();
  if (!user) {
    const login = new URL("/login", base);
    login.searchParams.set("next", destinoDaVolta(volta));
    return NextResponse.redirect(login);
  }
  try {
    const r = await runWithTeam(user.teamId, () => iniciarConexaoGoogle({ volta, ...(recurso ? { recurso } : {}) }), identidade(user));
    const res = NextResponse.redirect(r.url);
    res.cookies.set(COOKIE_GOOGLE_AGENDA, valorCookieGoogleAgenda({ nonce: r.nonce, verificador: r.verificador, volta }), {
      ...OPCOES_COOKIE_GOOGLE_AGENDA,
      maxAge: 600,
    });
    return res;
  } catch (e) {
    const codigo = codigoDoErroGoogle(e);
    if (codigo === "falhou" || codigo === "configuracao") logger.warn({ err: detalheDoErroGoogle(e), codigo }, "[agenda-google] não iniciei a conexão");
    return NextResponse.redirect(new URL(destinoDaVolta(volta, codigo), base));
  }
}
