/**
 * Apoio das rotas do OAuth da Agenda Google (conectar/callback).
 *
 * O cookie guarda o `nonce` do `state` e o verificador PKCE entre a ida ao
 * Google e a volta: httpOnly, 10 min, `sameSite=lax` (a volta do Google é uma
 * navegação GET de outro site) e `__Host-` em produção (só HTTPS, só este
 * host, path /). Sem ele, a volta é recusada (anti-CSRF).
 */
export const COOKIE_GOOGLE_AGENDA = process.env.NODE_ENV === "production" ? "__Host-crmagro_google_agenda" : "crmagro_google_agenda";

export const OPCOES_COOKIE_GOOGLE_AGENDA = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export type TelaDeVolta = "integracoes" | "agenda" | "canais";

/**
 * Para onde a pessoa volta depois do Google (e para onde o login a devolve). `canais`
 * é a aba E-mail de Integrações, Canais (a conexão do envio pelo Gmail); sem este mapa,
 * `/${volta}` daria `/canais`, que não existe. Com `codigo`, acrescenta `google=<código>`
 * (o resultado que a tela mostra uma vez) ao fim da URL, com `?` ou `&` conforme o caso.
 */
export function destinoDaVolta(volta: TelaDeVolta, codigo?: string): string {
  const base = volta === "agenda" ? "/agenda" : volta === "canais" ? "/integracoes/canais?canal=email" : "/integracoes";
  if (!codigo) return base;
  const [caminho = base, consulta = ""] = base.split("?");
  const parametros = new URLSearchParams(consulta);
  parametros.set("google", codigo);
  return `${caminho}?${parametros.toString()}`;
}

/** Valor do cookie da ida: nonce, verificador PKCE e a tela de onde a pessoa saiu. */
export function valorCookieGoogleAgenda(ida: { nonce: string; verificador: string; volta: TelaDeVolta }): string {
  return JSON.stringify({ n: ida.nonce, v: ida.verificador, r: ida.volta });
}

/**
 * Lê o cookie da ida (nonce + verificador + tela de volta); qualquer coisa
 * estranha = sem cookie. A tela de volta só decide para ONDE voltar quando a
 * conexão falha (quem tem só a Agenda não cai em "sem acesso"); o sucesso usa
 * a tela que veio no `state` assinado.
 */
export function lerCookieGoogleAgenda(valor: string | undefined): { nonce: string; verificador: string; volta: TelaDeVolta } | null {
  if (!valor) return null;
  try {
    const j = JSON.parse(valor) as { n?: unknown; v?: unknown; r?: unknown };
    if (typeof j.n !== "string" || typeof j.v !== "string" || j.n.length > 128 || j.v.length > 128) return null;
    return { nonce: j.n, verificador: j.v, volta: j.r === "agenda" ? "agenda" : j.r === "canais" ? "canais" : "integracoes" };
  } catch {
    return null;
  }
}

/**
 * Origem PÚBLICA do app para os redirecionamentos (atrás do Caddy o pedido
 * chega com o host interno): AUTH_URL/APP_PUBLIC_URL, senão os cabeçalhos do proxy.
 */
export function origemPublica(req: Request): string {
  const base = process.env.AUTH_URL ?? process.env.APP_PUBLIC_URL;
  if (base) return base.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

/**
 * Cliente OAuth mal configurado (secret copiado errado, cliente apagado ou de
 * outro tipo): o Google responde `invalid_client`/`deleted_client`/
 * `unauthorized_client` na troca do code. Não é falha passageira.
 */
const MOTIVOS_DE_CONFIGURACAO = new Set(["invalid_client", "deleted_client", "unauthorized_client"]);

/** Código curto do resultado, lido pela tela (`?google=...`). Nunca a mensagem crua. */
export function codigoDoErroGoogle(e: unknown): string {
  const nome = e instanceof Error ? e.name : "";
  const motivo = (e as { motivo?: unknown } | null)?.motivo;
  if (nome === "GoogleApiErro" && typeof motivo === "string" && MOTIVOS_DE_CONFIGURACAO.has(motivo)) return "configuracao";
  switch (nome) {
    case "GoogleAgendaIndisponivel":
      return "indisponivel";
    case "ForbiddenError":
      return "sem-permissao";
    case "EstadoOAuthInvalido":
      return "expirou";
    case "PermissaoDaAgendaNegada":
      return "sem-agenda";
    case "AgendaGoogleDeOutraPessoa":
      return "outra-pessoa";
    case "AgendaGoogleNaoLiberada":
      return "nao-liberada";
    // Envio pelo Gmail (E7): os erros que voltam para a aba E-mail de Canais.
    case "AgendaGoogleNecessaria":
      return "agenda-antes";
    case "PermissaoDoGmailNegada":
      return "sem-gmail";
    case "CaixaJaConectadaComSenha":
      return "caixa-com-senha";
    case "GmailEmOutraConta":
      return "gmail-outra-conta";
    case "EnvioPeloGmailDesligado":
      return "gmail-desligado";
    default:
      return "falhou";
  }
}

/** Erros cuja mensagem foi feita para o log (status HTTP + motivo curto; nunca corpo nem token). */
const COM_MENSAGEM_SEGURA = new Set(["GoogleApiErro", "GoogleAutorizacaoInvalida", "RespostaDoGoogleInvalida", "EstadoOAuthInvalido", "PermissaoDaAgendaNegada"]);

/** O que vai para o log quando a conexão falha: a mensagem dos erros do Google (status e motivo), senão só o nome. */
export function detalheDoErroGoogle(e: unknown): string {
  if (!(e instanceof Error)) return "erro";
  return COM_MENSAGEM_SEGURA.has(e.name) ? e.message.slice(0, 200) : e.name;
}
