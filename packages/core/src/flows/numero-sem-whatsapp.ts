import { db, getCurrentTeamId } from "@crmagro/db";
import { ondeIdentificadorExato } from "../contacts/identificadores-cifra";

/**
 * O WhatsApp recusou o envio porque o número não tem conta (Evolution 400 com `exists:false`): marca esse
 * número como inválido no cadastro do contato. Só do motor (roda no contexto do time, como o resto do executor).
 *
 * Efeitos, todos pelo `ChannelIdentifier.invalido` que o CRM Agro já usa para número errado:
 * - a condição "Tem WhatsApp" passa a dar "não" para o contato, e os próximos fluxos desviam em vez de bater no mesmo 400;
 * - campanhas deixam de mandar para esse número;
 * - o contato entra em "Revisar dados", com o motivo escrito, para alguém corrigir o número.
 *
 * Não põe a tag "Número errado" (essa é de quem ligou e ouviu que o número não é da pessoa; fixo é número
 * certo, só não tem WhatsApp) e o motivo não começa com "número errado", então desfazer um resultado de
 * ligação não mexe nesta marca. Corrigir o número no cadastro volta a marca para válido (`contacts/service.ts`).
 */
export const MOTIVO_SEM_WHATSAPP = "sem WhatsApp";

/** Marca só o número que foi enviado, sem variar o nono dígito: a Evolution já testou o número exato. */
export async function marcarNumeroSemWhatsApp(enrollmentId: string, numero: string, agora = new Date()): Promise<boolean> {
  const prisma = db();
  const enr = await prisma.enrollment.findFirst({ where: { id: enrollmentId }, select: { contactId: true } });
  if (!enr) return false;
  const quando = agora.toISOString().slice(0, 10);
  const { count } = await prisma.channelIdentifier.updateMany({
    where: {
      contactId: enr.contactId,
      // Guardado em E.164 com "+"; aceita também sem ele (cadastro antigo).
      ...ondeIdentificadorExato(getCurrentTeamId() ?? "", "whatsapp", [`+${numero}`, numero]),
      invalido: false,
    },
    data: { invalido: true, invalidoMotivo: `${MOTIVO_SEM_WHATSAPP} (o WhatsApp recusou o envio em ${quando})` },
  });
  return count > 0;
}
