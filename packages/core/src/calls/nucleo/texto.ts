import type { DesfechoDeLigacao } from "./desfecho";

/**
 * O TEXTO da ligação no histórico do contato. Função pura.
 * Generaliza `textoDaLigacaoWhatsApp` da branch do WhatsApp. Texto de tela pela §15 do AGENTS.md: frase curta,
 * português do dia a dia, sem travessão.
 */

/** Por onde a ligação foi feita. Só muda a frase; o desfecho é o mesmo. */
export type ViaDoTextoDaLigacao = "telefone" | "whatsapp";

/** Só o que o texto lê do desfecho (o que a Call guarda também serve). */
export type DesfechoParaTextoDaLigacao = Pick<DesfechoDeLigacao, "status" | "outcome" | "motivo" | "duracaoConectadaS">;

/** "45 s" ou "1 min 05 s". */
export function duracaoCurtaDaLigacao(segundos: number): string {
  const s = Math.max(0, Math.round(segundos));
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
}

/**
 * A frase do histórico. Com o desfecho nulo (a ligação acabou de começar), "Ligação iniciada". Resultado que o
 * provedor não confirmou (nulo) leva o motivo na frase seguinte.
 */
export function textoDaLigacao(desfecho: DesfechoParaTextoDaLigacao | null, via: ViaDoTextoDaLigacao = "telefone"): string {
  const pelo = via === "whatsapp" ? " pelo WhatsApp" : "";
  if (desfecho === null) return `Ligação${pelo} iniciada`;

  switch (desfecho.outcome) {
    case "answered":
      return `Ligação${pelo} atendida${desfecho.duracaoConectadaS ? ` (${duracaoCurtaDaLigacao(desfecho.duracaoConectadaS)})` : ""}`;
    case "rejected":
      return `Ligação recusada pelo contato${via === "whatsapp" ? " no WhatsApp" : ""}`;
    case "no_answer":
      return `Ligação${pelo} não atendida`;
    case "busy":
      return `Ligação${pelo} com linha ocupada`;
    case "voicemail":
      return `Ligação${pelo} caiu na caixa postal`;
    case "wrong_number":
      return `Número inexistente, a ligação${pelo} não saiu`;
    default: {
      const abertura = desfecho.status === "failed" ? "não completou" : desfecho.status === "completed" ? "terminou" : "sem resposta";
      return `Ligação${pelo} ${abertura}${desfecho.motivo ? `. ${desfecho.motivo}` : ""}`;
    }
  }
}
