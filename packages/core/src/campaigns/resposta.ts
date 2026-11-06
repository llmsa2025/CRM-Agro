import type { RecipientStatus } from "@prisma/client";
import { db } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";

/**
 * O que a campanha precisa saber DEPOIS do envio (produto §A.2):
 * - recibo ✓✓ do WhatsApp → `delivered`/`read` (funil "entregues → lidas");
 * - resposta do contato → `replied` e o fluxo "Pós-resposta" da campanha.
 *
 * Chamados do inbound (`applyStatusUpdate`, `receiveInbound`) já no contexto do
 * time (`runAsSystem`). Nunca derrubam o inbound: erro vira aviso no log.
 * A classificação da resposta e o opt-out (A.5) entram a partir de
 * `registrarRespostaDeCampanha`.
 */

/** Ordem do funil: recibo nunca faz o destinatário andar para trás. */
const ANTERIORES: Record<"delivered" | "read", RecipientStatus[]> = {
  delivered: ["sent"],
  read: ["sent", "delivered"],
};

/**
 * Recibo do WhatsApp da mensagem de campanha (pelo id no WhatsApp). `failed`
 * (o WhatsApp recusou depois de aceitar — ex.: 463) marca o destinatário como
 * falha e conta no freio de falhas seguidas da campanha.
 */
export async function aplicarReciboDeCampanha(
  providerMessageId: string,
  status: "sent" | "delivered" | "read" | "failed" | null,
): Promise<void> {
  if (status !== "delivered" && status !== "read" && status !== "failed") return;
  try {
    requireCan("campaigns.write");
    const prisma = db();
    if (status === "failed") {
      const alvo = await prisma.campaignRecipient.findFirst({
        where: { providerMessageId, status: { in: ["sent", "delivered"] } },
        select: { id: true, campaignId: true },
      });
      if (!alvo) return;
      const { count } = await prisma.campaignRecipient.updateMany({
        where: { id: alvo.id, status: { in: ["sent", "delivered"] } },
        data: { status: "failed", motivo: "o WhatsApp recusou a mensagem (recibo de erro)" },
      });
      if (count === 1) {
        await prisma.campaign.updateMany({ where: { id: alvo.campaignId }, data: { falhasSeguidas: { increment: 1 } } });
      }
      return;
    }
    await prisma.campaignRecipient.updateMany({
      where: { providerMessageId, status: { in: ANTERIORES[status] } },
      data: { status },
    });
  } catch (e) {
    logger.warn({ providerMessageId, err: e instanceof Error ? e.message : String(e) }, "[campanha] falha ao aplicar recibo");
  }
}

/** Resposta até 30 dias depois do envio conta para a campanha. */
const JANELA_RESPOSTA_MS = 30 * 86_400_000;

/**
 * O contato respondeu: marca `replied` no destinatário de campanha mais recente
 * dele (enviado/entregue/lido, até 30 dias) e dispara o fluxo "Pós-resposta" da
 * campanha. IDEMPOTENTE: a transição é condicional (`updateMany` com o status
 * de origem), então a 2ª mensagem do mesmo contato — ou a reentrega da mesma —
 * não dispara o fluxo de novo. Devolve o destinatário marcado (ou null).
 */
export async function registrarRespostaDeCampanha(
  contactId: string,
  msg: { messageId: string; texto: string | null },
  agora = new Date(),
): Promise<{ recipientId: string; campaignId: string } | null> {
  try {
    requireCan("campaigns.write");
    const prisma = db();
    const alvo = await prisma.campaignRecipient.findFirst({
      where: {
        contactId,
        status: { in: ["sent", "delivered", "read"] },
        sentAt: { gte: new Date(agora.getTime() - JANELA_RESPOSTA_MS) },
      },
      orderBy: { sentAt: "desc" },
      select: { id: true, campaignId: true, campaign: { select: { flowId: true } } },
    });
    if (!alvo) return null;
    const { count } = await prisma.campaignRecipient.updateMany({
      where: { id: alvo.id, status: { in: ["sent", "delivered", "read"] } },
      data: { status: "replied", repliedAt: agora },
    });
    if (count !== 1) return null; // outra entrega já marcou
    // Classificação da resposta pela IA (A.5, #116): não lança, prazo de 3 s.
    const { agendarClassificacaoDaResposta } = await import("./classificacao");
    await agendarClassificacaoDaResposta({ recipientId: alvo.id, messageId: msg.messageId });
    const flowId = alvo.campaign.flowId;
    if (flowId) {
      try {
        const { enroll } = await import("../flows/service");
        // Cascata do motor (item 1.4): a resposta é evento externo, profundidade 0.
        await enroll(contactId, flowId);
      } catch (e) {
        // Fluxo pausado/arquivado ou contato já inscrito: não trava a resposta.
        logger.info({ contactId, flowId, err: e instanceof Error ? e.message : String(e) }, "[campanha] fluxo pós-resposta não inscreveu");
      }
    }
    return { recipientId: alvo.id, campaignId: alvo.campaignId };
  } catch (e) {
    logger.warn({ contactId, err: e instanceof Error ? e.message : String(e) }, "[campanha] falha ao registrar resposta");
    return null;
  }
}
