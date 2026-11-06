/**
 * Leitura de BOUNCE (aviso de não entrega) — item 3.4 (INT-21).
 *
 * Antes o bounce só era casado pelo In-Reply-To/References, que os DSNs do
 * Postfix e do Exchange não trazem: o Message-ID do e-mail original fica DENTRO
 * do aviso (parte `text/rfc822-headers` ou `message/rfc822`). E o endereço nunca
 * era marcado: o próximo `send_email` do fluxo mandava de novo para o mesmo
 * endereço morto (reputação do domínio).
 *
 * Aqui lemos o texto cru do aviso (sem depender de como o mailparser junta as
 * partes — ele mistura `message/delivery-status` no texto):
 * - blocos do DSN (RFC 3464): `Final-Recipient`, `Action`, `Status`,
 *   `Diagnostic-Code`, um por destinatário;
 * - cabeçalho `X-Failed-Recipients` (Exim, Gmail);
 * - o `Message-ID` do original, que é o primeiro depois dos cabeçalhos do aviso.
 *
 * Permanente = `Status: 5.x.x`/`Action: failed`, ou `X-Failed-Recipients` sem
 * DSN dizendo o contrário. `4.x.x`/`Action: delayed` é temporário: o provedor
 * ainda tenta entregar, então não marca nada.
 */

export type BounceDestinatario = {
  email: string;
  permanente: boolean;
  status: string | null;
  diagnostico: string | null;
};

export type BounceInfo = {
  destinatarios: BounceDestinatario[];
  /** Message-ID do e-mail que voltou (o nosso `providerMessageId`). */
  messageIdOriginal: string | null;
  /** Sem DSN nem X-Failed-Recipients, mas o texto diz "não existe" (5.1.1...). */
  permanenteSemDestinatario: boolean;
};

/** Junta as linhas de continuação (cabeçalho "dobrado" em várias linhas). */
function desdobrar(texto: string): string {
  return texto.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
}

function campo(bloco: string, nome: string): string | null {
  const m = new RegExp(`^${nome}:[ \\t]*(.*)$`, "im").exec(bloco);
  return m?.[1]?.trim() || null;
}

function enderecoDe(valor: string | null): string | null {
  if (!valor) return null;
  // "rfc822; fulano@x.com" ou "rfc822;<fulano@x.com>"
  const m = /([^\s<>;"]+@[^\s<>;"]+)/.exec(valor);
  return m?.[1]?.toLowerCase() ?? null;
}

const TEXTO_PERMANENTE =
  /\b5\.1\.[0-9]{1,2}\b|\b550\b|user unknown|unknown user|no such user|does not exist|doesn't exist|address not found|mailbox unavailable|mailbox not found|recipient address rejected|invalid recipient|endere[çc]o n[ãa]o encontrado|n[ãa]o existe/i;

export function analisarBounce(fonte: string): BounceInfo {
  const texto = fonte.replace(/\r\n/g, "\n");
  const fimCabecalho = texto.indexOf("\n\n");
  const cabecalhos = desdobrar(fimCabecalho >= 0 ? texto.slice(0, fimCabecalho) : texto);
  const corpo = fimCabecalho >= 0 ? texto.slice(fimCabecalho + 2) : "";
  const corpoDesdobrado = desdobrar(corpo);

  const porEmail = new Map<string, BounceDestinatario>();

  // 1) Blocos do DSN: um por destinatário, separados por linha em branco.
  for (const bloco of corpoDesdobrado.split(/\n\s*\n/)) {
    const email = enderecoDe(campo(bloco, "Final-Recipient") ?? campo(bloco, "Original-Recipient"));
    if (!email) continue;
    const action = campo(bloco, "Action")?.toLowerCase() ?? null;
    const status = campo(bloco, "Status")?.match(/[245]\.\d{1,3}\.\d{1,3}/)?.[0] ?? null;
    const permanente = status ? status.startsWith("5") : action === "failed";
    porEmail.set(email, { email, permanente, status, diagnostico: campo(bloco, "Diagnostic-Code")?.slice(0, 300) ?? null });
  }

  // 2) X-Failed-Recipients: só entra quem o DSN não descreveu.
  const falhos = campo(cabecalhos, "X-Failed-Recipients");
  for (const parte of falhos?.split(",") ?? []) {
    const email = enderecoDe(parte);
    if (email && !porEmail.has(email)) porEmail.set(email, { email, permanente: true, status: null, diagnostico: null });
  }

  // 3) O original: o primeiro Message-ID do CORPO (o do topo é do próprio aviso).
  const original = /^Message-ID:[ \t]*(<[^>\s]+>)/im.exec(corpoDesdobrado)?.[1] ?? null;

  return {
    destinatarios: [...porEmail.values()],
    messageIdOriginal: original,
    permanenteSemDestinatario: porEmail.size === 0 && TEXTO_PERMANENTE.test(corpo),
  };
}

/**
 * Remetente de aviso AUTOMÁTICO do servidor (não uma pessoa): MAILER-DAEMON,
 * postmaster, o remetente de NDR do Exchange/Microsoft 365.
 */
export function remetenteDeAviso(from: string | null): boolean {
  return /^(mailer-daemon|mailerdaemon|mail-daemon|postmaster)@|^microsoftexchange[0-9a-f]{32}@/i.test((from ?? "").trim());
}

/**
 * Parece aviso de não entrega? Só com prova ESTRUTURAL: remetente de sistema,
 * `X-Failed-Recipients` ou `Content-Type: multipart/report; report-type=
 * delivery-status`. O ASSUNTO sozinho não basta (auditoria do 3.4): um lead que
 * responde "Pedido não entregue" era tratado como bounce — a resposta sumia e o
 * e-mail DELE virava inválido. Na dúvida, é resposta: perder resposta é pior
 * que deixar de marcar um bounce.
 */
export function pareceBounce(from: string | null, cabecalhos: string): boolean {
  return (
    remetenteDeAviso(from) ||
    /^x-failed-recipients:/im.test(cabecalhos) ||
    /^content-type:[^\n]*multipart\/report[^\n]*delivery-status/im.test(desdobrar(cabecalhos))
  );
}
