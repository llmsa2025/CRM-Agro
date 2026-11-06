/**
 * Falha de envio CLASSIFICADA (item 1.2 do plano backend — MF-03/INT-03).
 *
 * O motor precisa saber se a mensagem SAIU ou não para decidir:
 * - `not_sent` (certeza de que não saiu): conexão recusada antes de mandar o
 *   corpo, ou o provedor respondeu com erro HTTP/SMTP. `retryable` = vale
 *   tentar de novo (5xx, 429, 4xx do SMTP, rede) ou não (4xx da Evolution como
 *   número inválido, destinatário recusado);
 * - `unknown`: timeout/queda DEPOIS de mandar — pode ter saído. Nunca
 *   reenviar sozinho (duplicaria a mensagem): o motor segura para revisão.
 *
 * Checar com `isChannelSendFailed` (pelo `name`), não com `instanceof`: o
 * pacote pode ser carregado duas vezes (web/worker/testes).
 */
export type DesfechoEnvio = "not_sent" | "unknown";

export class ChannelSendFailed extends Error {
  constructor(
    message: string,
    readonly outcome: DesfechoEnvio,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChannelSendFailed";
  }
}

export function isChannelSendFailed(e: unknown): e is ChannelSendFailed {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "ChannelSendFailed";
}

/** Códigos de rede em que a conexão NEM abriu — o corpo não saiu. */
const SEM_CONEXAO = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Classifica um erro de `fetch` (rede/timeout) numa ChannelSendFailed. */
export function classificarErroDeRede(e: unknown, operacao: string): ChannelSendFailed {
  const err = e as { name?: string; code?: string; cause?: { code?: string; message?: string }; message?: string };
  const codigo = err?.cause?.code ?? err?.code;
  const texto = `${operacao}: ${err?.cause?.message ?? err?.message ?? String(e)}`;
  if (codigo && SEM_CONEXAO.has(codigo)) return new ChannelSendFailed(texto, "not_sent", true);
  // Timeout/abort/reset depois de a conexão abrir: pode ter saído.
  return new ChannelSendFailed(texto, "unknown", false);
}

/** Resposta HTTP de erro do provedor: certeza de que não saiu. */
export function falhaHttp(status: number, corpo: string, operacao: string): ChannelSendFailed {
  const retryable = status >= 500 || status === 429 || status === 408;
  return new ChannelSendFailed(`${operacao} ${status}: ${corpo.slice(0, 300)}`, "not_sent", retryable, status);
}

/**
 * Sessão social (cookie do Instagram/LinkedIn) deslogada: o DM NÃO saiu e a
 * conta precisa ser reconectada (item 1.8, INT-10). Continua sendo uma
 * `ChannelSendFailed` (mesmo `name`) — o motor trata como "não saiu, repete";
 * quem envia pausa a conta ao ver `isSessaoSocialInvalida`.
 */
export class SessaoSocialInvalida extends ChannelSendFailed {
  readonly sessaoInvalida = true;
  constructor(message: string) {
    super(message, "not_sent", true);
  }
}

export function isSessaoSocialInvalida(e: unknown): e is SessaoSocialInvalida {
  return isChannelSendFailed(e) && (e as { sessaoInvalida?: unknown }).sessaoInvalida === true;
}
