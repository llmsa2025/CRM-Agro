/**
 * Primitivo de telefone — vive em `channels` (não em `core`) porque o inbound de
 * WhatsApp (channels) precisa dele e a direção de dependência é
 * config → db → channels → core (channels NÃO pode importar core).
 *
 * Motor: `libphonenumber-js` (server-side apenas — nunca vaza pro bundle do
 * cliente: é importado via @crmagro/channels/@crmagro/core, que a regra
 * `no-node-only-in-client` já barra em "use client").
 *
 * Resolve os buracos do regex antigo: prefixo de tronco "0" (Google Maps entrega
 * `phone:tel:0DD...`), 9º dígito de celular, DDD válido, fixo vs celular, DDI 55
 * e números com lixo/formatação. A fachada de `core` delega aqui.
 */
import { parsePhoneNumberFromString, type PhoneNumber } from "libphonenumber-js";

export type PhoneDetail = {
  /** E.164 canônico p/ ARMAZENAR (+55DDNNNNNNNNN), ou null se inválido. */
  canonical: string | null;
  /** Formato nacional bonito p/ EXIBIR ("(66) 99999-8888"), ou null. */
  display: string | null;
  valid: boolean;
  reason?: string;
  meta?: { tipo?: string; country?: string; ddd?: string };
};

/**
 * Tenta parsear tolerando o prefixo de tronco "0" e o DDI 55 sem "+".
 * libphonenumber sozinho NÃO tira o "0" nacional brasileiro (ele espera o "+55"
 * internacional), então geramos as variantes nacionais na mão antes de validar.
 */
function parseBr(input: string): PhoneNumber | undefined {
  const raw = input.trim();
  // 1) Já tem "+": confia no libphonenumber (internacional explícito).
  if (raw.startsWith("+")) {
    const p = parsePhoneNumberFromString(raw);
    if (p?.isValid()) return p;
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) return undefined;

  // Candidatos de dígitos NACIONAIS (sem DDI), 10 (fixo) ou 11 (celular).
  const candidates = new Set<string>();
  const pushNational = (d: string) => {
    if (d.length === 10 || d.length === 11) candidates.add(d);
  };
  pushNational(digits); // como veio
  // tira DDI 55 (12/13 díg)
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    pushNational(digits.slice(2));
  }
  // tira prefixo de tronco "0" (Google: "0" + DDD + número)
  if (digits.startsWith("0")) {
    pushNational(digits.slice(1));
    if (digits.slice(1).startsWith("55")) pushNational(digits.slice(3));
  }
  // DDI 55 seguido de tronco "0": 55 0 DD ...
  if (digits.startsWith("550")) pushNational(digits.slice(3));

  for (const nat of candidates) {
    const p = parsePhoneNumberFromString(nat, "BR");
    if (p?.isValid()) return p;
  }
  // Última tentativa: deixa o libphonenumber inferir no bruto original.
  const p = parsePhoneNumberFromString(raw, "BR");
  return p?.isValid() ? p : undefined;
}

/**
 * Versão rica — base da fachada de normalização em `core`. Sempre devolve o
 * contrato completo; nunca lança.
 */
export function normalizePhoneDetailed(input: string | null | undefined): PhoneDetail {
  if (!input || !input.trim()) {
    return { canonical: null, display: null, valid: false, reason: "vazio" };
  }
  const p = parseBr(input);
  if (!p) {
    return {
      canonical: null,
      display: null,
      valid: false,
      reason: "não é um telefone válido (BR ou E.164)",
    };
  }
  const country = p.country;
  const nat = p.nationalNumber; // sem DDI
  const ddd = country === "BR" ? nat.slice(0, 2) : undefined;
  return {
    canonical: p.number, // E.164 "+55..."
    display: p.formatNational(),
    valid: true,
    meta: { tipo: p.getType(), country, ddd },
  };
}

/**
 * Assinatura HISTÓRICA mantida (retorna string|null) para não quebrar os imports
 * existentes (inbound WhatsApp, contacts, captação, calls). Agora com o motor do
 * libphonenumber por baixo — o E.164 devolvido é validado de verdade.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  return normalizePhoneDetailed(input).canonical;
}

/**
 * Variantes do MESMO celular brasileiro com e sem o nono dígito.
 *
 * O WhatsApp/Baileys entrega números antigos sem o 9 (`+556699997701`) enquanto
 * o contato pode estar cadastrado com ele (`+5566999997701`) — ou o inverso.
 * Comparar string a string faz o inbound não achar o contato: a conversa nasce
 * "solta" (contactId null), nenhuma Activity é criada e o motor de fluxos fica
 * CEGO para respostas que existiram (quebrava a condição "respondeu?").
 *
 * Regra: BR celular em E.164 é +55 DD 9XXXXXXXX (13 chars). O formato legado é
 * +55 DD XXXXXXXX (12 chars). Só mexe quando o padrão bate — fixo não é tocado.
 * Retorna sempre o próprio número primeiro, sem duplicatas.
 */
export function phoneVariants(e164: string | null | undefined): string[] {
  if (!e164) return [];
  const out = [e164];
  const d = e164.replace(/\D/g, "");
  if (!d.startsWith("55")) return out;
  const ddd = d.slice(2, 4);
  const resto = d.slice(4);
  if (resto.length === 9 && resto.startsWith("9")) {
    // com 9 → sem 9
    out.push(`+55${ddd}${resto.slice(1)}`);
  } else if (resto.length === 8) {
    // sem 9 → com 9 (celular legado)
    out.push(`+55${ddd}9${resto}`);
  }
  return [...new Set(out)];
}
