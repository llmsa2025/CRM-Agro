import { createHash } from "node:crypto";
import { ChannelSendFailed } from "../errors";
import nodemailer, { type Transporter } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import type { Channel, SendInput, SendOutput } from "../types";

/**
 * Provider de E-mail via SMTP (nodemailer). Funciona com qualquer servidor SMTP
 * (Gmail com app password, Zoho, domínio próprio, provedor de cold-email, …).
 * Implementa a interface `Channel`: `send` monta o e-mail (assunto/texto/HTML) e
 * dispara pelo SMTP configurado. As credenciais vêm decifradas do serviço (a
 * senha nunca fica em claro no banco).
 */
export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean; // true = TLS direto (465); false = STARTTLS (587)
  user: string;
  pass: string;
  from: string; // remetente ("Nome <email@dominio>")
  // Com `secure: false` (porta 587): exige o STARTTLS. Sem isto, o nodemailer só
  // sobe o TLS se o servidor anunciar, e um downgrade no caminho entrega o AUTH
  // e o corpo em claro. O remetente da plataforma sempre liga.
  requireTLS?: boolean;
  // Para onde vão as respostas (opcional). O remetente da plataforma
  // (`noreply@`) usa quando PLATFORM_EMAIL_REPLY_TO está definido.
  replyTo?: string;
  // Cabeçalhos extras em todo envio desta conta (ex.: `Auto-Submitted` nos
  // e-mails automáticos da plataforma, para não disparar resposta automática).
  headers?: Record<string, string>;
  // `to` é SEMPRE um endereço só: vai ao nodemailer como `{ name: "", address }`,
  // e ele não interpreta vírgula/ponto e vírgula como lista nem `x: a@b;` como
  // grupo (defesa em profundidade do remetente da plataforma).
  destinatarioUnico?: boolean;
};

/** Traduz erros de SMTP/IMAP para uma mensagem clara pro usuário. */
export function describeMailError(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
  const code = err?.code ?? "";
  const rc = err?.responseCode ?? 0;
  if (code === "EAUTH" || rc === 535 || rc === 534 || /auth/i.test(err?.response ?? "")) {
    return "Autenticação recusada (usuário ou senha). No Gmail, ative a verificação em duas etapas e use uma senha de app. A senha normal não funciona.";
  }
  if (["ECONNECTION", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "EDNS", "ENOTFOUND", "EHOSTUNREACH"].includes(code)) {
    return "Não consegui conectar ao servidor. Confira o host e a porta (SMTP costuma ser 465 c/ SSL ou 587 c/ STARTTLS).";
  }
  if (code === "ETLS" || /tls|ssl|certificate/i.test(err?.message ?? "")) {
    return "Falha de TLS/SSL. Ajuste a opção de SSL/STARTTLS (marque SSL para 465, desmarque para 587).";
  }
  return err?.message ?? "Falha desconhecida na verificação.";
}

type InlineAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
  cid: string;
};

/**
 * Troca `<img src="data:image/...;base64,...">` por `<img src="cid:...">` e
 * devolve os anexos inline correspondentes. Clientes de e-mail não exibem
 * imagens em data URI; anexos com Content-ID (CID) são o padrão que funciona.
 */
function embedDataUriImages(html: string): { html: string; attachments: InlineAttachment[] } {
  const attachments: InlineAttachment[] = [];
  // Captura o src de data URI (aspas simples ou duplas).
  const dataUri = /src\s*=\s*(["'])(data:(image\/[a-z0-9.+-]+);base64,([^"']+))\1/gi;
  const out = html.replace(dataUri, (_m, quote: string, _full: string, mime: string, b64: string) => {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(b64, "base64");
    } catch {
      return _m; // base64 inválido: mantém como está
    }
    const idx = attachments.length + 1;
    const cid = `img${idx}.${Date.now().toString(36)}@crmagro`;
    const ext = mime.split("/")[1]?.split("+")[0] || "png";
    attachments.push({ filename: `imagem-${idx}.${ext}`, content: buffer, contentType: mime, cid });
    return `src=${quote}cid:${cid}${quote}`;
  });
  return { html: out, attachments };
}

/**
 * Transporte SMTP reaproveitado por conta (item 1.7, INT-06). Antes cada e-mail
 * abria um transporte (conexão + TLS + login) novo. Agora: um pool por conta
 * (credenciais iguais = mesmo transporte), UMA conexão por vez (ritmo humano,
 * sem rajada paralela) e até 50 mensagens por conexão. Teto de 200 transportes
 * por processo (o mais antigo é fechado).
 */
const transportes = new Map<string, Transporter>();
const MAX_TRANSPORTES = 200;

export function transporteSmtpPara(cfg: SmtpConfig): Transporter {
  const senha = createHash("sha256").update(cfg.pass ?? "").digest("hex").slice(0, 16);
  const chave = `${cfg.host}:${cfg.port}:${cfg.secure ? 1 : 0}:${cfg.requireTLS ? 1 : 0}:${cfg.user}:${senha}`;
  const existente = transportes.get(chave);
  if (existente) return existente;
  const t = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.requireTLS ? { requireTLS: true } : {}),
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
    // Timeouts (item 1.2/1.7): servidor SMTP travado não segura o worker.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  if (transportes.size >= MAX_TRANSPORTES) {
    const [maisAntiga, velho] = transportes.entries().next().value as [string, Transporter];
    velho.close();
    transportes.delete(maisAntiga);
  }
  transportes.set(chave, t);
  return t;
}

/**
 * Monta as opções do nodemailer para um e-mail (remetente, destino, assunto,
 * texto/HTML com as imagens `data:` viradas anexo inline, convite `.ics` e thread).
 * É o MESMO caminho para o SMTP (`EmailProvider`) e para o envio pela API do Gmail
 * (`GmailApiProvider`, que só monta o MIME e manda pelo HTTPS): o e-mail que sai
 * é igual, mude o transporte.
 */
export function opcoesDoEmail(
  cfg: { from: string; replyTo?: string; headers?: Record<string, string>; destinatarioUnico?: boolean },
  input: SendInput,
): Mail.Options {
  const { to, content } = input;
  // Imagens embutidas como data URI (ex.: da assinatura) NÃO são renderizadas
  // pela maioria dos clientes (Gmail/Outlook bloqueiam `<img src="data:...">`).
  // Convertemos para anexos inline (CID), a forma padrão e confiável.
  const { html, attachments } = content.html
    ? embedDataUriImages(content.html)
    : { html: undefined as string | undefined, attachments: [] as InlineAttachment[] };
  return {
    from: cfg.from,
    to: cfg.destinatarioUnico === true ? { name: "", address: to } : to,
    ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
    ...(cfg.headers && Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}),
    subject: content.subject ?? "(sem assunto)",
    text: content.text,
    ...(html ? { html } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(content.icsEvent
      ? { icalEvent: { method: "REQUEST", content: content.icsEvent } }
      : {}),
    ...(content.inReplyTo ? { inReplyTo: content.inReplyTo } : {}),
    ...(content.references?.length ? { references: content.references } : {}),
  };
}

export class EmailProvider implements Channel {
  private transporter: Transporter;
  private from: string;
  private replyTo: string | undefined;
  private headers: Record<string, string> | undefined;
  private destinatarioUnico: boolean;

  constructor(cfg: SmtpConfig) {
    this.from = cfg.from || cfg.user;
    this.replyTo = cfg.replyTo || undefined;
    this.headers = cfg.headers && Object.keys(cfg.headers).length ? cfg.headers : undefined;
    this.destinatarioUnico = cfg.destinatarioUnico === true;
    this.transporter = transporteSmtpPara(cfg);
  }

  async send(input: SendInput): Promise<SendOutput> {
    // Fora do try, como antes: só o erro do transporte vira ChannelSendFailed.
    const opcoes = opcoesDoEmail(
      { from: this.from, replyTo: this.replyTo, headers: this.headers, destinatarioUnico: this.destinatarioUnico },
      input,
    );
    let info: { messageId: string };
    try {
      info = await this.transporter.sendMail(opcoes);
    } catch (e) {
      throw classificarErroSmtp(e);
    }
    return { providerMessageId: info.messageId };
  }

  /** Verifica a conexão/credenciais SMTP (usado ao conectar a conta). */
  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  /** Igual a `verify`, mas devolve o motivo da falha (para exibir na UI). */
  async verifyDetailed(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: describeMailError(e) };
    }
  }
}

/**
 * Erro do nodemailer → `ChannelSendFailed` (item 1.2): o motor precisa saber se
 * o e-mail saiu.
 * - não conectou / autenticação: `not_sent`, vale tentar de novo;
 * - destinatário recusado (EENVELOPE) ou resposta 5xx: `not_sent`, sem retry;
 * - resposta 4xx (greylisting, limite temporário): `not_sent`, com retry;
 * - timeout/queda durante o DATA: `unknown` (pode ter saído).
 */
export function classificarErroSmtp(e: unknown): ChannelSendFailed {
  const err = e as { code?: string; command?: string; responseCode?: number; message?: string };
  const texto = `SMTP: ${err?.message ?? String(e)}`;
  if (typeof err?.responseCode === "number") {
    const c = err.responseCode;
    return new ChannelSendFailed(texto, "not_sent", c >= 400 && c < 500, c);
  }
  if (err?.code === "EENVELOPE") return new ChannelSendFailed(texto, "not_sent", false);
  if (err?.code === "ECONNECTION" || err?.code === "EDNS" || err?.code === "EAUTH" || err?.command === "CONN") {
    return new ChannelSendFailed(texto, "not_sent", true);
  }
  return new ChannelSendFailed(texto, "unknown", false);
}
