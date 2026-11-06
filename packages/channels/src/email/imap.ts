import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { describeMailError } from "./index";
import { analisarBounce, pareceBounce, type BounceInfo } from "./bounce";

/** Config IMAP (recebimento). Chega decifrada do serviço. */
export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
};

export type FetchedEmail = {
  uid: number;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  text: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Cabeçalho `Date:` — escrito pelo cliente de QUEM ENVIOU (relógio dele). */
  date: Date | null;
  /**
   * INTERNALDATE do IMAP: quando o e-mail CHEGOU à caixa, pelo relógio do
   * servidor. É a hora confiável para o motor ("respondeu depois do envio?").
   */
  recebidoEm: Date | null;
  /** Heurística: é um bounce/rejeição (MAILER-DAEMON / delivery status). */
  isBounce: boolean;
  /** Bounce lido (destinatários, permanente ou não, Message-ID original) — item 3.4. */
  bounce: BounceInfo | null;
};

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Cria o cliente IMAP JÁ com ouvinte de "error".
 *
 * Por quê: o ImapFlow é um EventEmitter e, quando a autenticação falha, além de
 * rejeitar a promise ele EMITE "error" ("Already logged out"). Evento "error" sem
 * ouvinte vira exceção não tratada e derruba o PROCESSO inteiro — foi assim que
 * uma única conta com senha errada matou o worker (motor de fluxos, fila de IA,
 * tudo) em loop. A falha real continua chegando pela promise rejeitada; aqui só
 * impedimos que o evento duplicado mate o processo.
 */
function createImapClient(cfg: ImapConfig): ImapFlow {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    // Servidor lento/pendurado não segura o poll (a trava por conta dura 10 min).
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
  client.on("error", () => {});
  return client;
}

/** Cursor da leitura IMAP de uma conta (guardado em `ChannelAccount.meta.imap`). */
export type ImapCursor = { uidValidity: string; lastUid: number };

/** INTERNALDATE do ImapFlow (Date ou string) → Date válida ou null. */
function dataValida(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** O que dá para saber de um e-mail só pelo envelope, sem baixar o corpo. */
export type ImapEnvelope = {
  uid: number;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  messageId: string | null;
  /** In-Reply-To e References: casam a resposta com um e-mail NOSSO (item 3.4). */
  inReplyTo: string | null;
  references: string[];
  date: Date | null;
  /** INTERNALDATE (chegada à caixa, relógio do servidor). */
  recebidoEm: Date | null;
  size: number | null;
  /** Heurística: é um bounce/rejeição (MAILER-DAEMON / delivery status). */
  isBounce: boolean;
};

export type ImapLeitura = {
  /** Cursor novo. Gravar DEPOIS de processar os e-mails (se cair no meio, relê). */
  cursor: ImapCursor;
  /** Não havia cursor, ou o UIDVALIDITY da caixa mudou: a leitura recomeçou por data. */
  recomecou: boolean;
  /** UIDs novos examinados neste lote (só envelope). */
  vistos: number;
  /** Os e-mails cujo corpo foi baixado (os que `selecionar` escolheu). */
  emails: FetchedEmail[];
  /** Há mais UIDs novos além do lote: o próximo poll continua de onde parou. */
  restantes: boolean;
};

export const IMAP_LOTE_PADRAO = 200;
/** Teto do corpo baixado por e-mail: texto de resposta cabe folgado; anexo grande não vem. */
export const IMAP_MAX_BYTES_PADRAO = 256 * 1024;

/** Os Message-IDs (`<...>`) do cabeçalho References, já desdobrado. */
function referencesDe(cabecalhos: string): string[] {
  const m = /^references:[ \t]*((?:.*)(?:\r?\n[ \t]+.*)*)/im.exec(cabecalhos);
  return m?.[1]?.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * Lê a INBOX a partir do cursor da conta (auditoria DP-18/INT-05).
 *
 * Antes: `search({ seen: false })` e os 50 PRIMEIROS não lidos, com o e-mail
 * inteiro (anexos inclusive), a cada 2 min. Numa caixa com 50+ não lidos, eram
 * sempre os mesmos 50 antigos: a resposta do lead (UID alto) nunca entrava.
 *
 * Agora:
 * - cursor `{ uidValidity, lastUid }`: busca só `UID lastUid+1:*`, em ordem, em
 *   lotes de `lote`; o estado de lido/não lido da caixa não importa (e não é
 *   alterado: a caixa abre em modo somente leitura);
 * - sem cursor, ou com UIDVALIDITY trocado (os UIDs antigos não valem mais),
 *   recomeça por data (`SINCE desde`);
 * - primeiro só o ENVELOPE (remetente, assunto, Message-ID, tamanho) e dois
 *   cabeçalhos; `selecionar` (no core) diz quais valem o corpo — remetente
 *   conhecido ou bounce — e só esses são baixados, com teto de `maxBytes`.
 *
 * Lança o erro do IMAP (conexão, autenticação): quem chama classifica com
 * `isImapAuthError`. Fecha a conexão sempre.
 */
export async function lerEmailsNovos(
  cfg: ImapConfig,
  cursor: ImapCursor | null,
  opts: {
    desde: Date;
    selecionar: (envelopes: ImapEnvelope[]) => Promise<Set<number>>;
    lote?: number;
    maxBytes?: number;
  },
): Promise<ImapLeitura> {
  const lote = opts.lote ?? IMAP_LOTE_PADRAO;
  const client = createImapClient(cfg);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const caixa = client.mailbox;
      if (!caixa) throw new Error("INBOX não abriu");
      const uidValidity = String(caixa.uidValidity);
      const recomecou = !cursor || cursor.uidValidity !== uidValidity;
      const piso = recomecou ? 0 : cursor.lastUid;

      const achados =
        (await client.search(recomecou ? { since: opts.desde } : { uid: `${piso + 1}:*` }, { uid: true })) || [];
      // `N:*` com N acima do maior UID devolve o ÚLTIMO e-mail (regra do IMAP):
      // o filtro `> piso` descarta esse falso positivo.
      const novos = achados.filter((u) => u > piso).sort((a, b) => a - b);
      const doLote = novos.slice(0, lote);
      const restantes = novos.length > doLote.length;
      // Tudo abaixo do UIDNEXT (lido ao abrir a caixa) já foi coberto pela busca.
      const teto = Number.isFinite(caixa.uidNext) ? caixa.uidNext - 1 : 0;
      const lastUid = restantes ? doLote[doLote.length - 1]! : Math.max(piso, teto, novos[novos.length - 1] ?? 0);
      const leitura: ImapLeitura = {
        cursor: { uidValidity, lastUid },
        recomecou,
        vistos: doLote.length,
        emails: [],
        restantes,
      };
      if (doLote.length === 0) return leitura;

      // 1) Envelope + cabeçalhos de bounce/thread: leve, sem corpo.
      const envelopes: ImapEnvelope[] = [];
      const cabecalhos = new Map<number, string>();
      for await (const msg of client.fetch(
        doLote,
        { uid: true, envelope: true, size: true, internalDate: true, headers: ["references", "x-failed-recipients", "content-type"] },
        { uid: true },
      )) {
        const env = msg.envelope;
        const remetente = env?.from?.[0];
        const from = remetente?.address?.toLowerCase() ?? null;
        const subject = env?.subject ?? null;
        const cab = msg.headers?.toString("utf8") ?? "";
        cabecalhos.set(msg.uid, cab);
        envelopes.push({
          uid: msg.uid,
          from,
          fromName: remetente?.name ?? null,
          subject,
          messageId: env?.messageId || null, // o ImapFlow devolve "" quando não há
          inReplyTo: env?.inReplyTo || null,
          references: referencesDe(cab),
          date: env?.date ?? null,
          recebidoEm: dataValida(msg.internalDate),
          size: msg.size ?? null,
          isBounce: pareceBounce(from, cab),
        });
      }

      // 2) Corpo só do que o core escolheu (remetente conhecido / bounce).
      const escolhidos = await opts.selecionar(envelopes);
      const alvo = envelopes.filter((e) => escolhidos.has(e.uid));
      if (alvo.length === 0) return leitura;
      const porUid = new Map(alvo.map((e) => [e.uid, e]));
      for await (const msg of client.fetch(
        alvo.map((e) => e.uid),
        { uid: true, source: { maxLength: opts.maxBytes ?? IMAP_MAX_BYTES_PADRAO } },
        { uid: true },
      )) {
        const env = porUid.get(msg.uid);
        if (!env || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const isBounce = env.isBounce || pareceBounce(env.from, cabecalhos.get(msg.uid) ?? "");
        leitura.emails.push({
          uid: msg.uid,
          from: env.from,
          fromName: env.fromName,
          subject: env.subject ?? parsed.subject ?? null,
          text: parsed.text ?? null,
          messageId: env.messageId ?? parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? env.inReplyTo,
          references: parsed.references ? asArray(parsed.references) : env.references,
          date: env.date ?? parsed.date ?? null,
          recebidoEm: env.recebidoEm,
          isBounce,
          // latin1: o aviso pode ter bytes fora de UTF-8; endereços e IDs são ASCII.
          bounce: isBounce ? analisarBounce(msg.source.toString("latin1")) : null,
        });
      }
      return leitura;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Falha de AUTENTICAÇÃO do IMAP (senha errada/revogada), não de rede. O ImapFlow
 * marca `authenticationFailed`; alguns servidores só dizem no texto da resposta.
 */
export function isImapAuthError(e: unknown): boolean {
  const err = e as { authenticationFailed?: boolean; serverResponseCode?: string; response?: string; message?: string };
  if (err?.authenticationFailed) return true;
  if (/AUTHENTICATIONFAILED/i.test(err?.serverResponseCode ?? "")) return true;
  return /authenticat(e|ion) failed|invalid credentials|AUTHENTICATIONFAILED/i.test(
    `${err?.response ?? ""} ${err?.message ?? ""}`,
  );
}

/** Verifica conexão/credenciais IMAP (ao conectar a conta). */
export async function verifyImap(cfg: ImapConfig): Promise<boolean> {
  return (await verifyImapDetailed(cfg)).ok;
}

/** Igual a `verifyImap`, mas devolve o motivo da falha (para exibir na UI). */
export async function verifyImapDetailed(cfg: ImapConfig): Promise<{ ok: boolean; error?: string }> {
  const client = createImapClient(cfg);
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeMailError(e) };
  }
}
