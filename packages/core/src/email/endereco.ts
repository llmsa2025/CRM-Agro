/**
 * Endereço de e-mail SIMPLES: UM destinatário, sem nome, sem lista e sem grupo.
 *
 * Por que existe: o campo "e-mail" do convite ia inteiro como `to` para o
 * nodemailer, que interpreta vírgula/ponto e vírgula como LISTA, `Nome <x@y>`
 * como nome e `grupo: a@b;` como GRUPO. Com a validação antiga
 * (`/.+@.+\..+/`, sem âncora), um convite só virava N e-mails (furando o limite
 * por hora) ou levava um texto livre ("sua conta será bloqueada, confirme em
 * https://…") para o cabeçalho `To:` e para o corpo do e-mail da plataforma.
 *
 * Aqui: sem espaço, sem `< > , ; : " ( ) [ ] \`, sem caractere de controle,
 * exatamente um `@`, um ponto no domínio e no máximo 254 caracteres (RFC 5321).
 */
export const EMAIL_MAX = 254;

const EMAIL_SIMPLES = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;

/** Tem caractere de controle (0–31 ou 127)? Checado por código, sem regex de escape. */
function temControle(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** `true` se `s` é UM endereço simples (`pessoa@dominio.com`), já sem espaços nas pontas. */
export function ehEmailSimples(s: string): boolean {
  return s.length > 0 && s.length <= EMAIL_MAX && !temControle(s) && EMAIL_SIMPLES.test(s);
}

/** Domínios em que o Gmail ignora os pontos da parte local (e `googlemail.com` = `gmail.com`). */
const DOMINIOS_GMAIL = new Set(["gmail.com", "googlemail.com"]);

/**
 * A CAIXA por trás do endereço, para os LIMITES (nunca para enviar):
 * minúsculas, sem o `+sufixo` e, no Gmail, sem os pontos
 * (`V.itima+1@googlemail.com` → `vitima@gmail.com`). Sem isto, `vitima+1@`,
 * `vitima+2@`, `v.itima@`… eram "destinatários diferentes", cada um com o seu
 * limite, e todos caíam na MESMA caixa. Tirar o `+` de qualquer domínio só
 * junta os limites de endereços que, na prática, são da mesma pessoa.
 */
export function caixaDoEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const arroba = e.lastIndexOf("@");
  if (arroba <= 0) return e;
  let local = e.slice(0, arroba);
  let dominio = e.slice(arroba + 1);
  const mais = local.indexOf("+");
  if (mais > 0) local = local.slice(0, mais);
  if (DOMINIOS_GMAIL.has(dominio)) {
    local = local.replace(/\./g, "");
    dominio = "gmail.com";
  }
  return `${local}@${dominio}`;
}
