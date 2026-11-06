import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { runWithTeam } from "@crmagro/db";
import { concluirConexaoGoogle, logger } from "@crmagro/core";
import { currentUser, identidade } from "@/lib/tenant";
import {
  codigoDoErroGoogle,
  COOKIE_GOOGLE_AGENDA,
  destinoDaVolta,
  detalheDoErroGoogle,
  lerCookieGoogleAgenda,
  OPCOES_COOKIE_GOOGLE_AGENDA,
  origemPublica,
} from "@/lib/google-agenda";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Volta do Google. Exige a MESMA pessoa da sessão (o `state` é conferido no
 * core contra a sessão e o nonce do cookie) e troca o `code` com o
 * verificador PKCE. Trata tudo no servidor e redireciona para uma URL limpa
 * (sem o `code` na barra de endereço), como o Google recomenda.
 */
export async function GET(req: Request) {
  const base = origemPublica(req);
  const url = new URL(req.url);
  const jar = await cookies();
  const ida = lerCookieGoogleAgenda(jar.get(COOKIE_GOOGLE_AGENDA)?.value);
  const user = await currentUser();
  // Sem sessão: volta ao login e depois para a tela de onde a pessoa saiu (quem
  // só tem a Agenda não cai em Integrações, que daria "sem acesso").
  if (!user) {
    const login = new URL("/login", base);
    login.searchParams.set("next", destinoDaVolta(ida?.volta ?? "integracoes"));
    return NextResponse.redirect(login);
  }

  // Na falha, volta para a tela de onde a pessoa saiu (quem tem só a Agenda
  // não pode cair em Integrações, que o middleware manda para "sem acesso").
  const telaDeErro = ida?.volta ?? "integracoes";
  let destino = destinoDaVolta(telaDeErro, "falhou");
  if (url.searchParams.get("error")) {
    // A pessoa cancelou na tela do Google (access_denied) ou o Google recusou.
    destino = destinoDaVolta(telaDeErro, "cancelado");
  } else {
    try {
      const r = await runWithTeam(
        user.teamId,
        () =>
          concluirConexaoGoogle({
            code: url.searchParams.get("code") ?? "",
            state: url.searchParams.get("state") ?? "",
            nonce: ida?.nonce,
            verificador: ida?.verificador,
          }),
        identidade(user),
      );
      // Com o `gmail.send` (E7), o aviso é outro: o envio pelo Gmail ficou ligado.
      destino = destinoDaVolta(r.volta, r.recurso === "gmail" ? "gmail-conectado" : "conectado");
    } catch (e) {
      const codigo = codigoDoErroGoogle(e);
      // Status e motivo do Google (ex.: "HTTP 401 (invalid_client)") — nunca corpo nem token.
      if (codigo === "falhou" || codigo === "configuracao") logger.warn({ err: detalheDoErroGoogle(e), codigo }, "[agenda-google] a volta do Google falhou");
      destino = destinoDaVolta(telaDeErro, codigo);
    }
  }
  const res = NextResponse.redirect(new URL(destino, base));
  // Vale para uma volta só. Apagar com os MESMOS atributos (senão o navegador ignora o `__Host-`).
  res.cookies.set(COOKIE_GOOGLE_AGENDA, "", { ...OPCOES_COOKIE_GOOGLE_AGENDA, maxAge: 0 });
  return res;
}
