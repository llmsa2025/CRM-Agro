import type { Canal } from "@prisma/client";
import { normalizePhone } from "./phone";
import { normalizeEmail } from "../normalize/index";
import { valorDe } from "./identificadores-cifra";

/**
 * Identifiers multicanal — cada contato pode ter vários (whatsapp, email,
 * instagram, linkedin...). Adaptador FINO: delega à fachada de normalização
 * (../normalize) por canal:
 *   - whatsapp  → E.164 (normalizePhone / libphonenumber)
 *   - email     → normalizeEmail (trim + lowercase + validação endurecida)
 *   - ig/linkedin → trimmed + lowercased (handle; @ opcional)
 *
 * Retorna null se o valor for inválido pro canal (caller decide descartar).
 */
export function normalizeIdentifier(canal: Canal, valor: string): string | null {
  const v = valor.trim();
  if (!v) return null;
  switch (canal) {
    case "whatsapp":
      return normalizePhone(v);
    case "email":
      return normalizeEmail(v).canonical;
    case "instagram":
    case "linkedin":
      return v.toLowerCase().replace(/^@/, "");
    default:
      return v;
  }
}

/** Shape mínimo de um ChannelIdentifier lido do Prisma. */
export type IdentifierLike = {
  canal: Canal;
  valor: string;
  /** Valor cifrado (CONTATOS_CIFRA). Quem faz `select` deve trazê-lo junto de `valor`: com a cifra ligada é dele que se lê. */
  valorCifrado?: string | null;
  isPrimary: boolean;
};

/**
 * Devolve o valor do identifier primário de um canal pra um contato, ou o
 * primeiro disponível, ou null. Usado pela UI (mostrar telefone/email) e pelo
 * envio (sendMessage precisa do número whatsapp).
 */
export function primaryValor(
  identifiers: IdentifierLike[],
  canal: Canal,
): string | null {
  const ofCanal = identifiers.filter((i) => i.canal === canal);
  if (ofCanal.length === 0) return null;
  const picked = ofCanal.find((i) => i.isPrimary) ?? ofCanal[0];
  return picked ? valorDe(picked) : null;
}

/** Atalhos comuns usados pela UI. */
export function primaryTelefone(identifiers: IdentifierLike[]): string | null {
  return primaryValor(identifiers, "whatsapp");
}

export function primaryEmail(identifiers: IdentifierLike[]): string | null {
  return primaryValor(identifiers, "email");
}

/**
 * Para qual e-mail do contato ENVIAR (item 3.4): o primário, se não estiver
 * marcado inválido por bounce; senão outro válido. Todos inválidos → `null` e o
 * motivo do bounce (o envio pula em vez de insistir num endereço morto).
 */
export function emailParaEnvio(
  identifiers: (IdentifierLike & { invalido?: boolean; invalidoMotivo?: string | null })[],
): { email: string; motivo: null } | { email: null; motivo: string } {
  const emails = identifiers.filter((i) => i.canal === "email");
  if (emails.length === 0) return { email: null, motivo: "contato sem e-mail" };
  const validos = emails.filter((i) => !i.invalido);
  const escolhido = validos.find((i) => i.isPrimary) ?? validos[0];
  if (escolhido) {
    const endereco = valorDe(escolhido);
    if (endereco) return { email: endereco, motivo: null };
    return { email: null, motivo: "não foi possível ler o e-mail do contato" };
  }
  const motivo = emails.find((i) => i.invalidoMotivo)?.invalidoMotivo;
  return { email: null, motivo: `e-mail do contato inválido (bounce)${motivo ? `: ${motivo}` : ""}` };
}
