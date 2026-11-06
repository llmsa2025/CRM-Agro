import { ChannelSendFailed, classificarErroDeRede, falhaHttp, isChannelSendFailed } from "../errors";
import type { Channel, SendInput, SendOutput } from "../types";
import { opcoesDoEmail } from "./index";
import { montarMime } from "./mime-saida";

/**
 * Provider de e-mail pela API do Gmail (`users.messages.send`, escopo `gmail.send`).
 * Implementa `Channel`: monta o MESMO MIME que o SMTP mandaria (`opcoesDoEmail` +
 * `montarMime`) e envia pelo HTTPS com o token OAuth da pessoa. O e-mail sai da
 * conta do vendedor e aparece nos Enviados dele.
 *
 * O `accessToken` chega já renovado (quem chama, o core, cuida da renovação); ele
 * nunca é gravado em erro nem em log daqui.
 */
const ENDPOINT_ENVIO = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const TIMEOUT_ENVIO_MS = 20_000;

/**
 * O Google recusou a autorização: token inválido ou vencido (401), Workspace que
 * bloqueia o app (`domainPolicy`) ou escopo insuficiente (403). Não adianta repetir:
 * a pessoa precisa reconectar. Continua sendo uma `ChannelSendFailed` (mesmo `name`),
 * como a `SessaoSocialInvalida`; quem envia desliga a conta ao ver `isGmailSemAutorizacao`.
 */
export class GmailSemAutorizacao extends ChannelSendFailed {
  readonly gmailSemAutorizacao = true;
  constructor(message: string, status?: number) {
    super(message, "not_sent", false, status);
  }
}

export function isGmailSemAutorizacao(e: unknown): e is GmailSemAutorizacao {
  return isChannelSendFailed(e) && (e as { gmailSemAutorizacao?: unknown }).gmailSemAutorizacao === true;
}

/**
 * Motivos de 403 que são LIMITE DE USO e não falta de permissão. O Gmail devolve 403
 * para cota estourada; derrubar a conta por isso seria errado (ela volta sozinha).
 */
const MOTIVOS_DE_LIMITE = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]);

export type GmailApiConfig = {
  accessToken: string;
  from: string; // remetente ("Nome <email@dominio>")
  replyTo?: string;
  headers?: Record<string, string>;
  destinatarioUnico?: boolean;
};

/**
 * Só o `reason` (ou o `status`) do JSON de erro do Google. Nunca o corpo inteiro:
 * ele pode trazer texto que não queremos em log nem na tela.
 */
async function motivoDoErro(res: Response): Promise<string> {
  try {
    const corpo = (await res.json()) as { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown } };
    const reason = corpo?.error?.errors?.[0]?.reason;
    if (typeof reason === "string" && reason) return reason;
    const status = corpo?.error?.status;
    if (typeof status === "string" && status) return status;
  } catch {
    // corpo que não é JSON: cai no código HTTP
  }
  return `HTTP ${res.status}`;
}

/** Erro de HTTP do Gmail → `ChannelSendFailed` classificada (o e-mail NÃO saiu). */
async function erroDoGmail(res: Response): Promise<ChannelSendFailed> {
  const motivo = await motivoDoErro(res);
  if (res.status === 401) return new GmailSemAutorizacao("gmail send 401", 401);
  if (res.status === 403) {
    if (MOTIVOS_DE_LIMITE.has(motivo)) return new ChannelSendFailed(`gmail send 403: ${motivo}`, "not_sent", true, 403);
    // Outro 403: `domainPolicy` (o Workspace bloqueou o app), escopo insuficiente etc.
    return new GmailSemAutorizacao(`gmail send 403: ${motivo}`, 403);
  }
  // 429 e 5xx já saem com retryable: true.
  return falhaHttp(res.status, motivo, "gmail send");
}

/** Copia o erro de rede trocando o token por "***", para ele nunca ir para a mensagem. */
function semToken(e: unknown, token: string): unknown {
  const tirar = (s: unknown) => (typeof s === "string" ? s.split(token).join("***") : s);
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  return {
    name: err?.name,
    code: err?.code,
    message: tirar(err?.message ?? String(e)),
    ...(err?.cause ? { cause: { code: err.cause.code, message: tirar(err.cause.message) } } : {}),
  };
}

export class GmailApiProvider implements Channel {
  private accessToken: string;
  private cfg: Omit<GmailApiConfig, "accessToken">;

  constructor(cfg: GmailApiConfig) {
    this.accessToken = cfg.accessToken;
    this.cfg = { from: cfg.from, replyTo: cfg.replyTo, headers: cfg.headers, destinatarioUnico: cfg.destinatarioUnico };
  }

  async send(input: SendInput): Promise<SendOutput> {
    let montado: Awaited<ReturnType<typeof montarMime>>;
    try {
      montado = await montarMime(opcoesDoEmail(this.cfg, input));
    } catch (e) {
      // Não deu nem para montar (endereço inválido, por exemplo): nada saiu e repetir não resolve.
      throw new ChannelSendFailed(`gmail mime: ${e instanceof Error ? e.message : String(e)}`, "not_sent", false);
    }
    // O SMTP recusa antes de conectar quando não há destinatário (EENVELOPE); aqui o
    // mesmo: sem isto o pedido iria ao Google só para voltar 400.
    if (!montado.envelope.to.length) throw new ChannelSendFailed("gmail mime: sem destinatário válido", "not_sent", false);
    let res: Response;
    try {
      res = await fetch(ENDPOINT_ENVIO, {
        method: "POST",
        headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "message/rfc822" },
        // Uint8Array (cópia): o tipo Buffer do Node não é aceito como BodyInit pelo TypeScript.
        body: new Uint8Array(montado.raw),
        signal: AbortSignal.timeout(TIMEOUT_ENVIO_MS),
      });
    } catch (e) {
      throw classificarErroDeRede(semToken(e, this.accessToken), "gmail send");
    }
    if (!res.ok) throw await erroDoGmail(res);
    // Solta a conexão sem ler a resposta (o id do Gmail não é usado).
    await res.body?.cancel().catch(() => {});
    // O Message-ID é o que o CRM Agro gerou no MIME (a E7a confere se o Gmail o preserva).
    return { providerMessageId: montado.messageId };
  }
}
