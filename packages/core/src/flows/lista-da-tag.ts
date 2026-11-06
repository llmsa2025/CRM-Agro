import { db } from "@crmagro/db";
import { escopoDoContato } from "../contacts/escopo";
import { logger } from "../logger/index";
import { enrollManyByTrigger } from "./triggers";
import { NOS_QUE_FALAM_COM_O_CONTATO } from "./tipos";

/** Contatos lidos da tag por vez (a inscrição em si entra em lotes de 100, com freio, em `enrollManyByTrigger`). */
const LOTE_DA_TAG = 2000;

/**
 * Fluxo de gatilho "tag" no ar: joga no fluxo quem JÁ tem a tag e ainda não rodou este fluxo. Sem isto o fluxo
 * só pegava quem recebesse a tag depois de ativado, e uma lista inteira ficava parada. Roda ao ATIVAR e ao SALVAR
 * um fluxo ativo.
 *
 * - Só quem nunca teve inscrição neste fluxo entra: quem já rodou (ou está rodando) não repete, então salvar de
 *   novo não manda tudo outra vez. Para rodar de novo num contato, "Testar".
 * - Mesmas travas do gatilho de sempre (`enrollManyByTrigger`): quem pediu para sair, fluxo exclusivo, janela e
 *   limites. Só os contatos que a pessoa pode alterar (escopo por dono).
 * - Só este fluxo é tocado (`soFluxoId`), não os outros fluxos da mesma tag.
 * - Fluxo que não fala com o contato (só dados e funil) entra sem o espaçamento aleatório de lote; se tiver passo de
 *   mensagem, e-mail, DM ou agente, o espaçamento vale (controle de ritmo).
 *
 * Nunca derruba quem chama (ativar/salvar já deu certo): erro vira aviso no log e conta zero.
 */
export async function inscreverQuemJaTemATag(flowId: string): Promise<{ inscritas: number }> {
  try {
    const prisma = db();
    const flow = await prisma.flow.findFirst({ where: { id: flowId, status: "active", triggerType: "tag_added" }, select: { id: true, triggerConfig: true } });
    const tagId = (flow?.triggerConfig as { tagId?: string } | null)?.tagId;
    if (!flow || !tagId) return { inscritas: 0 };
    const fala = (await prisma.flowNode.count({ where: { flowId, tipo: { in: [...NOS_QUE_FALAM_COM_O_CONTATO] as never[] } } })) > 0;
    let inscritas = 0;
    let ultimo = "";
    for (;;) {
      const lote = await prisma.contactTag.findMany({
        where: { tagId, id: { gt: ultimo }, contact: escopoDoContato({ escrita: true }) },
        orderBy: { id: "asc" },
        take: LOTE_DA_TAG,
        select: { id: true, contactId: true },
      });
      if (lote.length === 0) break;
      ultimo = lote[lote.length - 1]!.id;
      const ids = lote.map((l) => l.contactId);
      const jaRodaram = new Set((await prisma.enrollment.findMany({ where: { flowId, contactId: { in: ids } }, select: { contactId: true } })).map((e) => e.contactId));
      const faltam = ids.filter((id) => !jaRodaram.has(id));
      if (faltam.length === 0) continue;
      const r = await enrollManyByTrigger("tag_added", faltam, { tagId, emLote: fala }, { soFluxoId: flowId });
      inscritas += r.inscritas;
    }
    if (inscritas > 0) logger.info({ flowId, inscritas }, "[flows] quem já tinha a tag entrou no fluxo");
    return { inscritas };
  } catch (err) {
    logger.warn({ flowId, err: err instanceof Error ? err.message : String(err) }, "[flows] não deu para inscrever quem já tinha a tag");
    return { inscritas: 0 };
  }
}
