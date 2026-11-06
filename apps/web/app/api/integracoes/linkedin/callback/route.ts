import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { runWithTeam } from "@crmagro/db";
import { concluirConexaoLinkedin, logger } from "@crmagro/core";
import { currentUser, identidade } from "@/lib/tenant";
import { origemPublica } from "@/lib/google-agenda";
import {
  codigoDoErroLinkedin,
  COOKIE_LINKEDIN,
  destinoDaVoltaLinkedin,
  detalheDoErroLinkedin,
  lerCookieLinkedin,
  OPCOES_COOKIE_LINKEDIN,
} from "@/lib/linkedin-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Volta do LinkedIn. Exige a MESMA pessoa da sessão (o `state` é conferido no core contra a sessão e o
 * nonce do cookie) e troca o `code` pelo token. Trata tudo no servidor e redireciona para uma URL limpa
 * (sem o `code` na barra de endereço).
 */
export async function GET(req: Request) {
  const base = origemPublica(req);
  const url = new URL(req.url);
  const jar = await cookies();
  const ida = lerCookieLinkedin(jar.get(COOKIE_LINKEDIN)?.value);
  const volta = ida?.volta ?? "canais";
  const user = await currentUser();
  // Sem sessão: volta ao login e depois para a tela de onde a pessoa saiu.
  if (!user) {
    const login = new URL("/login", base);
    login.searchParams.set("next", destinoDaVoltaLinkedin(volta));
    return NextResponse.redirect(login);
  }

  let destino = destinoDaVoltaLinkedin(volta, "falhou");
  const recusa = url.searchParams.get("error");
  if (recusa) {
    // A pessoa cancelou na tela do LinkedIn (`user_cancelled_*`) ou o LinkedIn recusou o pedido.
    const cancelou = recusa.startsWith("user_cancelled");
    if (!cancelou) logger.warn({ motivo: recusa.slice(0, 80) }, "[linkedin] o LinkedIn recusou o pedido de conexão");
    destino = destinoDaVoltaLinkedin(volta, cancelou ? "cancelado" : "falhou");
  } else {
    try {
      const r = await runWithTeam(
        user.teamId,
        async () =>
          concluirConexaoLinkedin({
            code: url.searchParams.get("code") ?? "",
            state: url.searchParams.get("state") ?? "",
            nonce: ida?.nonce,
          }),
        identidade(user),
      );
      destino = destinoDaVoltaLinkedin(r.volta, "conectado");
    } catch (e) {
      const codigo = codigoDoErroLinkedin(e);
      // Status e motivo do LinkedIn (ex.: "HTTP 401 (invalid_client)"): nunca corpo nem token.
      if (codigo === "falhou" || codigo === "configuracao") logger.warn({ err: detalheDoErroLinkedin(e), codigo }, "[linkedin] a volta do LinkedIn falhou");
      destino = destinoDaVoltaLinkedin(volta, codigo);
    }
  }
  const res = NextResponse.redirect(new URL(destino, base));
  // Vale para uma volta só. Apagar com os MESMOS atributos (senão o navegador ignora o `__Host-`).
  res.cookies.set(COOKIE_LINKEDIN, "", { ...OPCOES_COOKIE_LINKEDIN, maxAge: 0 });
  return res;
}
