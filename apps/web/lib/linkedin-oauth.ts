/**
 * Apoio das rotas do OAuth do LinkedIn oficial (conectar/callback).
 *
 * O cookie guarda o `nonce` do `state` entre a ida ao LinkedIn e a volta: httpOnly, 10 min,
 * `sameSite=lax` (a volta do LinkedIn é uma navegação GET de outro site) e `__Host-` em produção
 * (só HTTPS, só este host, path /). Sem ele, a volta é recusada (anti-CSRF).
 */
export const COOKIE_LINKEDIN = process.env.NODE_ENV === "production" ? "__Host-crmagro_linkedin" : "crmagro_linkedin";

export const OPCOES_COOKIE_LINKEDIN = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export type TelaDeVoltaLinkedin = "canais" | "integracoes";

/**
 * Para onde a pessoa volta depois do LinkedIn (e para onde o login a devolve). Com `codigo`, acrescenta
 * `linkedin=<código>` (o resultado que a tela mostra uma vez) ao fim da URL.
 */
export function destinoDaVoltaLinkedin(volta: TelaDeVoltaLinkedin, codigo?: string): string {
  const [caminho, consulta] = (volta === "integracoes" ? "/integracoes" : "/integracoes/canais?canal=linkedin").split("?");
  const parametros = new URLSearchParams(consulta ?? "");
  if (codigo) parametros.set("linkedin", codigo);
  const q = parametros.toString();
  return q ? `${caminho}?${q}` : caminho!;
}

/** Valor do cookie da ida: o nonce e a tela de onde a pessoa saiu. */
export function valorCookieLinkedin(ida: { nonce: string; volta: TelaDeVoltaLinkedin }): string {
  return JSON.stringify({ n: ida.nonce, r: ida.volta });
}

/** Lê o cookie da ida; qualquer coisa estranha = sem cookie. */
export function lerCookieLinkedin(valor: string | undefined): { nonce: string; volta: TelaDeVoltaLinkedin } | null {
  if (!valor) return null;
  try {
    const j = JSON.parse(valor) as { n?: unknown; r?: unknown };
    if (typeof j.n !== "string" || j.n.length > 128) return null;
    return { nonce: j.n, volta: j.r === "integracoes" ? "integracoes" : "canais" };
  } catch {
    return null;
  }
}

/** O LinkedIn recusou o app (chave errada, app desativado): não é falha passageira. */
const MOTIVOS_DE_CONFIGURACAO = new Set(["invalid_client", "unauthorized_client", "access_denied_app"]);

/** Código curto do resultado, lido pela tela (`?linkedin=...`). Nunca a mensagem crua. */
export function codigoDoErroLinkedin(e: unknown): string {
  const nome = e instanceof Error ? e.name : "";
  const motivo = (e as { motivo?: unknown } | null)?.motivo;
  if (nome === "LinkedinApiErro" && typeof motivo === "string" && MOTIVOS_DE_CONFIGURACAO.has(motivo)) return "configuracao";
  switch (nome) {
    case "LinkedinIndisponivel":
      return "indisponivel";
    case "ForbiddenError":
      return "sem-permissao";
    case "EstadoLinkedinInvalido":
      return "expirou";
    case "PermissaoDePublicarNegada":
      return "sem-publicar";
    case "LinkedinDeOutraPessoa":
      return "outra-pessoa";
    default:
      return "falhou";
  }
}

/** O que vai para o log quando a conexão falha: o nome do erro e, nos do LinkedIn, status e motivo curtos. */
export function detalheDoErroLinkedin(e: unknown): string {
  if (!(e instanceof Error)) return "erro";
  return e.name === "LinkedinApiErro" ? e.message.slice(0, 200) : e.name;
}
