import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";

/**
 * Monta o e-mail em MIME (RFC 822) sem enviar nada. Serve à API do Gmail
 * (`users.messages.send` recebe a mensagem pronta), que precisa dos MESMOS bytes
 * que o nodemailer mandaria pelo SMTP: assinatura com imagem inline (CID), convite
 * `.ics` e cabeçalhos de resposta na mesma conversa.
 *
 * O transporte de "stream" só escreve a mensagem em memória. Criado uma vez por
 * processo: não abre conexão nem guarda estado. `newline: "windows"` = CRLF, o fim
 * de linha que o e-mail exige.
 */
const montador = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });

/**
 * `envelope.to` traz os destinatários que o nodemailer entendeu. O transporte SMTP
 * recusa a mensagem sem destinatário (EENVELOPE); este não, então quem envia confere.
 */
export async function montarMime(
  opcoes: Mail.Options,
): Promise<{ raw: Buffer; messageId: string; envelope: { from: string | false; to: string[] } }> {
  const info = await montador.sendMail(opcoes);
  return { raw: info.message as Buffer, messageId: info.messageId, envelope: { from: info.envelope.from, to: info.envelope.to } };
}
