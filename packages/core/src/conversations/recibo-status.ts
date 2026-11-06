/**
 * Transição de status de uma mensagem enviada quando chega um recibo do
 * WhatsApp (messages.update). Função PURA — a decisão vive aqui para ser
 * testada sem banco; `applyStatusUpdate` só a aplica.
 */

export type StatusDeEnvio = "sent" | "delivered" | "read" | "failed";

/** Ordem de "avanço" do tique. `failed` fica fora da comparação (tem regra própria). */
const ORDEM: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/**
 * Devolve o status a gravar, ou `null` quando o recibo não muda o status.
 *
 * - Nunca REGRIDE: recibo de entrega atrasado não sobrescreve "lida".
 * - `failed` COM código do servidor (ex.: 463) vence, como sempre: é informação
 *   nova e acionável, mesmo fora de ordem — e é DEFINITIVA (nenhum recibo
 *   posterior a desfaz).
 * - `failed` SEM código (ERROR solto, ou falha nossa de envio) não desfaz uma
 *   entrega/leitura já confirmada: evento fora de ordem, o celular já recebeu.
 * - Sair de `failed`: um recibo de ENTREGA/LEITURA prova que a mensagem chegou,
 *   então promove a falha que não veio com código do servidor. O ✓ simples
 *   (SERVER_ACK) só promove a falha NOSSA, que nunca recebeu recibo
 *   (`statusAt` vazio) — um ✓ atrasado não desfaz um ERROR que o servidor mandou.
 *   Falha que ninguém desmentiu continua falha.
 */
export function statusAposRecibo(
  atual: { status: string; errorCode: string | null; statusAt: Date | null },
  recibo: { status: StatusDeEnvio | null; errorCode: string | null },
): StatusDeEnvio | null {
  const novo = recibo.status;
  if (!novo) return null;

  if (novo === "failed") {
    if (!recibo.errorCode && (atual.status === "delivered" || atual.status === "read")) return null;
    return "failed";
  }

  if (atual.status === "failed") {
    if (atual.errorCode) return null; // recusa do servidor é definitiva
    if (novo === "delivered" || novo === "read") return novo;
    return novo === "sent" && !atual.statusAt ? "sent" : null;
  }

  return (ORDEM[novo] ?? 0) > (ORDEM[atual.status] ?? 0) ? novo : null;
}
