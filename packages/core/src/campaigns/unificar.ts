import type { CampaignRecipient, RecipientStatus } from "@prisma/client";
import { db } from "@crmagro/db";

/**
 * Unificar contatos (`mergeContacts`) leva junto os destinatários de campanha
 * do duplicado (auditoria do #106). Antes a cascata do `Contact` os apagava, e
 * com eles `sent`/`replied`/`opted_out`: o "recebeu campanha há N dias", o
 * freio de saídas e o "pediu para sair" perdiam o histórico.
 *
 * Na MESMA campanha só cabe uma linha (único campanha+contato): fica a mais
 * adiantada no funil, e `opted_out` sempre vence — quem pediu para sair não
 * volta a receber. Roda no contexto do time (chamado de dentro do merge).
 */
const PESO: Record<RecipientStatus, number> = {
  opted_out: 100,
  replied: 90,
  read: 80,
  delivered: 70,
  sent: 60,
  sending: 55,
  failed: 40,
  held: 30,
  queued: 20,
  skipped: 10,
};

/** Campos que descrevem o que aconteceu com o destinatário (vão juntos). */
function historicoDe(r: CampaignRecipient) {
  return {
    status: r.status,
    motivo: r.motivo,
    variacao: r.variacao,
    reservadoEm: r.reservadoEm,
    enviandoEm: r.enviandoEm,
    tentativas: r.tentativas,
    providerMessageId: r.providerMessageId,
    messageId: r.messageId,
    scheduledAt: r.scheduledAt,
    sentAt: r.sentAt,
    repliedAt: r.repliedAt,
    classificacao: r.classificacao,
  };
}

export async function moverDestinatariosDeCampanha(keepId: string, dropIds: string[]): Promise<void> {
  if (dropIds.length === 0) return;
  const prisma = db();
  const doMantido = new Map(
    (await prisma.campaignRecipient.findMany({ where: { contactId: keepId } })).map((r) => [r.campaignId, r]),
  );
  const dosDuplicados = await prisma.campaignRecipient.findMany({
    where: { contactId: { in: dropIds } },
    orderBy: { createdAt: "asc" },
  });
  for (const r of dosDuplicados) {
    const ja = doMantido.get(r.campaignId);
    if (!ja) {
      const movido = await prisma.campaignRecipient.update({ where: { id: r.id }, data: { contactId: keepId } });
      doMantido.set(r.campaignId, movido);
      continue;
    }
    if (PESO[r.status] > PESO[ja.status]) {
      const atualizado = await prisma.campaignRecipient.update({ where: { id: ja.id }, data: historicoDe(r) });
      doMantido.set(r.campaignId, atualizado);
    }
    await prisma.campaignRecipient.delete({ where: { id: r.id } });
  }
}
