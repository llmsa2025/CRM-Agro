/**
 * Texto de uma falha de envio para quem lê o log do fluxo. A mensagem crua do canal
 * (`Evolution sendText 400: {"status":400,...}`) é útil para quem mexe no servidor, mas não diz
 * nada para quem usa o CRM Agro. O texto técnico continua no log do processo (pm2).
 */

/** Telefone em E.164 sem o "+": "556633337702" → "+55 66 3333-7702". Fora do padrão BR, só ganha o "+". */
export function formatarNumeroDoLog(digitos: string): string {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digitos);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${digitos}`;
}

/** Fixo brasileiro: DDD + 8 dígitos começando em 2 a 5. Celular tem 9 dígitos começando em 9 (ou 6 a 9, no formato antigo). */
export function pareceTelefoneFixoBR(digitos: string): boolean {
  return /^55\d{2}[2-5]\d{7}$/.test(digitos);
}

/**
 * A Evolution recusa o envio com 400 e `exists:false` quando o número não tem conta no WhatsApp.
 * Devolve `null` para qualquer outro erro; senão, o número recusado (só dígitos, como foi enviado), ou
 * `null` nele quando o texto veio cortado e não dá para ter certeza dos dígitos.
 */
export function lerNumeroSemWhatsApp(msg: string): { numero: string | null } | null {
  if (!/^Evolution send\w* 400:/.test(msg) || !/"exists"\s*:\s*false/.test(msg)) return null;
  // O corpo vem cortado em 300 caracteres: leio por padrão, não por JSON.parse. O número só vale inteiro
  // (fecha com aspas, vírgula ou chave); cortado no meio, mostrar (ou marcar no cadastro) seria um número errado.
  return { numero: /"number"\s*:\s*"?(\d{8,15})(?:"|,|\})/.exec(msg)?.[1] ?? null };
}

/** Qualquer erro que não seja "número sem WhatsApp" volta como veio. */
export function descreverFalhaDeEnvio(msg: string): string {
  const semZap = lerNumeroSemWhatsApp(msg);
  if (!semZap) return msg;
  if (!semZap.numero) return "Esse número não tem WhatsApp. Passo pulado.";
  const fixo = pareceTelefoneFixoBR(semZap.numero) ? " (parece telefone fixo)" : "";
  return `Número sem WhatsApp: ${formatarNumeroDoLog(semZap.numero)}${fixo}. Passo pulado.`;
}
