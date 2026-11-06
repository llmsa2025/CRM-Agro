/**
 * Nome exibido de uma conversa — ordem pedida pelo dono (28/09):
 *
 *   1. o contato cadastrado no CRM Agro (`Contact.nome`);
 *   2. o nome que o dono SALVOU NA AGENDA do celular (`Conversation.nomeAgenda`,
 *      sincronizado da Evolution — ver `integrations/whatsapp-nomes.ts`);
 *   3. o nome do perfil da outra pessoa (`Conversation.externalName`, o
 *      pushName), vindo SÓ de mensagem RECEBIDA — nunca da enviada, em que o
 *      pushName é o do próprio dono;
 *   4. só o número.
 *
 * Funções puras: quem grava e quem lê usam as mesmas regras.
 */

/** Rótulo de conversa do histórico sem telefone (`@lid`) e sem nome. */
export const ROTULO_CONVERSA_SEM_NUMERO = "Contato do WhatsApp (sem número)";

/**
 * Rótulo que a importação do histórico gravava no `externalName` das conversas
 * `@lid` sem nome (commit do Codex). Não é o nome de ninguém: é tratado como
 * "sem nome" e limpo pela sincronização de nomes.
 */
export const PREFIXO_ROTULO_LID_ANTIGO = "Conversa do WhatsApp · ";

/** "Você": o que a Evolution grava como pushName de mensagem enviada pela API. */
const NOMES_DO_PROPRIO_DONO = new Set(["você", "voce"]);

/** O identificador é um `@lid` (id anônimo do WhatsApp, não é telefone). */
export function ehLid(numero: string | null | undefined): boolean {
  return !!numero && numero.endsWith("@lid");
}

/**
 * Nome de pessoa utilizável vindo do WhatsApp (pushName ou agenda), ou null.
 * Recusa: vazio, só dígitos/pontuação de telefone (a Evolution põe o número —
 * ou o id do `@lid` — no lugar do nome quando não sabe), "Você" e o rótulo
 * antigo das conversas `@lid`.
 */
export function nomeDePessoaValido(nome: string | null | undefined): string | null {
  const n = (nome ?? "").trim();
  if (!n) return null;
  if (/^[+\d\s().-]*$/.test(n)) return null;
  if (NOMES_DO_PROPRIO_DONO.has(n.toLowerCase())) return null;
  if (n.startsWith(PREFIXO_ROTULO_LID_ANTIGO)) return null;
  return n;
}

export type PartesDoNome = {
  contatoNome: string | null | undefined;
  nomeAgenda: string | null | undefined;
  externalName: string | null | undefined;
  externalNumber: string | null | undefined;
};

/** Nome que a pessoa "é" fora do cadastro (agenda > perfil), para sugerir no cadastro. */
export function nomeSugeridoDaConversa(p: Omit<PartesDoNome, "contatoNome" | "externalNumber">): string | null {
  return nomeDePessoaValido(p.nomeAgenda) ?? nomeDePessoaValido(p.externalName);
}

/**
 * Nome completo do contato: nome e sobrenome juntos. No cadastro eles são campos separados, mas em toda lista
 * e cabeçalho a pessoa lê "Danilo Silva", não só "Danilo".
 */
export function nomeCompleto(nome: string | null | undefined, sobrenome: string | null | undefined): string {
  return [nome, sobrenome].map((p) => p?.trim()).filter(Boolean).join(" ");
}

/** Nome exibido na lista/cabeçalho de Conversas (ordem de 4 níveis acima). */
export function nomeDaConversa(p: PartesDoNome): string {
  const contato = p.contatoNome?.trim();
  if (contato) return contato;
  const sugerido = nomeSugeridoDaConversa(p);
  if (sugerido) return sugerido;
  if (ehLid(p.externalNumber)) return ROTULO_CONVERSA_SEM_NUMERO;
  return p.externalNumber || "Desconhecido";
}
