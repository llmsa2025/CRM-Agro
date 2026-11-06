import { simpleParser } from "mailparser";
import { analisarBounce, pareceBounce } from "./bounce";
import type { FetchedEmail } from "./imap";

/**
 * E-mail CRU (MIME) → o mesmo `FetchedEmail` que a leitura IMAP produz, mais o HTML
 * (só o encaminhamento do Gmail precisa dele, para achar o link de confirmação).
 *
 * Existe para a entrada por encaminhamento (Gmail → Cloudflare → CRM Agro): lá o
 * e-mail chega inteiro, sem passar pelo IMAP. O `messageId` sai COMO VEM, com os
 * `< >`, igual ao IMAP: é isso que faz o dedupe entre as duas entradas funcionar.
 */

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** Cabeçalho cru: do início até a primeira linha em branco (`\r\n\r\n` ou `\n\n`). */
function cabecalhoCru(texto: string): string {
  const fins = [texto.indexOf("\r\n\r\n"), texto.indexOf("\n\n")].filter((i) => i >= 0);
  return fins.length ? texto.slice(0, Math.min(...fins)) : texto;
}

export async function emailDoMime(raw: Buffer, opts: { recebidoEm: Date }): Promise<{ email: FetchedEmail; html: string | null }> {
  const parsed = await simpleParser(raw);
  const remetente = parsed.from?.value[0];
  const from = remetente?.address?.toLowerCase() ?? null;
  // latin1: o aviso pode ter bytes fora de UTF-8; endereços e IDs são ASCII.
  const latin1 = raw.toString("latin1");
  const isBounce = pareceBounce(from, cabecalhoCru(latin1));
  return {
    email: {
      uid: 0,
      from,
      fromName: remetente?.name || null,
      subject: parsed.subject ?? null,
      text: parsed.text ?? null,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: asArray(parsed.references),
      date: parsed.date ?? null,
      recebidoEm: opts.recebidoEm,
      isBounce,
      bounce: isBounce ? analisarBounce(latin1) : null,
    },
    html: typeof parsed.html === "string" ? parsed.html : null,
  };
}
