import { db, getCurrentTeamId } from "@crmagro/db";
import { phoneVariants } from "@crmagro/channels";
import { logger } from "../logger/index";
import { enfileirarLimpezaDeMidia } from "../storage/limpeza";
import { ondeConversaPorNumero, ondeLidPorTelefone, valorDe } from "./identificadores-cifra";

/**
 * Exclusão de contatos que apaga TUDO da pessoa (item 3.7, S15 — LGPD art. 18).
 *
 * O cascade do banco já levava atividades, conversas/mensagens, negócios,
 * identificadores e inscrições. Ficavam para trás:
 *  - `EnrichmentFact` (IE, CNAE, evidências com URLs): `targetId` sem FK, órfão;
 *  - as mídias no Storage (áudio, imagem, documento, anexo de negócio).
 * Agora, na ordem:
 *  1. lista as mídias (mensagens + atividades) e as empresas vinculadas;
 *  2. ENFILEIRA a limpeza do Storage (job atrasado, com retry, que só apaga o
 *     que ninguém mais usa) — se a fila não aceitar, nada é apagado e o erro
 *     sobe (o usuário tenta de novo);
 *  3. apaga os fatos de enriquecimento dos contatos e a coordenada copiada
 *     para as visitas da Agenda;
 *  4. apaga a conversa "sem número" (@lid) da pessoa e o par @lid → telefone dela (mapa da
 *     unificação de conversas do WhatsApp) e os contatos (cascade);
 *  5. apaga os fatos das empresas que ficaram sem nenhum contato.
 * Registro de auditoria sem PII: só contagens e o time.
 *
 * Não confere papel: quem chama (`remove`/`removeMany`) já fez o `requireCan`.
 */

/** Lote por consulta — "selecionar todos" pode trazer milhares de ids. */
const LOTE = 500;

export async function excluirContatos(ids: string[]): Promise<{ deleted: number }> {
  const prisma = db();
  const teamId = getCurrentTeamId()!;
  let deleted = 0;
  let midias = 0;
  let fatos = 0;
  let conversasLid = 0;
  const unicos = [...new Set(ids)];
  for (let i = 0; i < unicos.length; i += LOTE) {
    const lote = unicos.slice(i, i + LOTE);
    // Só os do time (a extensão filtra): id de outro time some aqui.
    const alvo = (await prisma.contact.findMany({ where: { id: { in: lote } }, select: { id: true } })).map((c) => c.id);
    if (alvo.length === 0) continue;

    // Números de WhatsApp da pessoa (as duas formas, com e sem o 9º dígito) e os códigos
    // anônimos (@lid) que o CRM Agro ligou a eles. A conversa "sem número" da MESMA pessoa
    // não tem FK para o contato (só o @lid), então sai pelo par guardado no mapa.
    const numeros = await prisma.channelIdentifier.findMany({
      where: { contactId: { in: alvo }, canal: "whatsapp" },
      select: { valor: true, valorCifrado: true },
    });
    const telefones = [...new Set(numeros.flatMap((n) => phoneVariants(valorDe(n))))];
    // Par @lid → telefone pelo telefone (texto, ou índice cego com a cifra dos contatos em indice/ligada).
    const doTelefone = ondeLidPorTelefone(teamId, telefones);
    const lids = telefones.length
      ? (await prisma.whatsAppLid.findMany({ where: doTelefone, select: { lid: true } })).map((l) => l.lid)
      : [];
    const semNumero = { contactId: null, canal: "whatsapp" as const, ...ondeConversaPorNumero(teamId, lids) };
    const convs = await prisma.conversation.findMany({
      where: { OR: [{ contactId: { in: alvo } }, ...(lids.length ? [semNumero] : [])] },
      select: { id: true },
    });
    const [msgs, acts, vinculos] = await Promise.all([
      convs.length
        ? prisma.message.findMany({
            where: { conversationId: { in: convs.map((c) => c.id) }, mediaPath: { not: null } },
            select: { mediaPath: true },
          })
        : Promise.resolve([]),
      prisma.activity.findMany({ where: { contactId: { in: alvo }, mediaPath: { not: null } }, select: { mediaPath: true } }),
      prisma.contactCompany.findMany({ where: { contactId: { in: alvo } }, select: { companyId: true } }),
    ]);
    const paths = [...msgs, ...acts].map((r) => r.mediaPath).filter((p): p is string => !!p);
    if (paths.length) midias += await enfileirarLimpezaDeMidia(teamId, paths);

    fatos += (await prisma.enrichmentFact.deleteMany({ where: { targetType: "contact", targetId: { in: alvo } } })).count;
    // Visita (Agenda §E) guarda a coordenada copiada do endereço da pessoa; a
    // FK só zera o contactId, então a coordenada sai aqui.
    await prisma.appointment.updateMany({
      where: { contactId: { in: alvo }, OR: [{ latitude: { not: null } }, { longitude: { not: null } }] },
      data: { latitude: null, longitude: null },
    });
    // Convidado de compromisso (Agenda, decisão 8): o e-mail da pessoa sai dos
    // convites — pelo vínculo com o contato e pelo endereço (convite avulso
    // com o mesmo e-mail). Colega do time com o mesmo endereço fica.
    const emails = (
      await prisma.channelIdentifier.findMany({ where: { contactId: { in: alvo }, canal: "email" }, select: { valor: true, valorCifrado: true } })
    ).flatMap((i) => {
      const v = valorDe(i);
      return v ? [v.toLowerCase()] : [];
    });
    await prisma.appointmentAttendee.deleteMany({
      where: { OR: [{ contactId: { in: alvo } }, ...(emails.length ? [{ email: { in: emails }, userId: null }] : [])] },
    });
    if (emails.length) {
      // Coluna antiga (obsoleta), até a próxima migration.
      await prisma.appointment.updateMany({ where: { convidadoEmail: { in: emails, mode: "insensitive" } }, data: { convidadoEmail: null } });
    }
    // Par "@lid → telefone" (mapa da unificação de conversas do WhatsApp): guarda o
    // telefone da pessoa, e o cascade do contato não o alcança (a linha é do time).
    // Sai junto, com a conversa "sem número" (@lid) dela (mensagens por cascade; as
    // mídias já foram para a fila de limpeza acima).
    if (lids.length) conversasLid += (await prisma.conversation.deleteMany({ where: semNumero })).count;
    if (telefones.length) await prisma.whatsAppLid.deleteMany({ where: doTelefone });
    deleted += (await prisma.contact.deleteMany({ where: { id: { in: alvo } } })).count;

    // Empresa que ficou sem contato: os fatos dela eram sobre esta pessoa também.
    const companyIds = [...new Set(vinculos.map((v) => v.companyId))];
    if (companyIds.length) {
      const orfas = await prisma.company.findMany({
        where: { id: { in: companyIds }, contatos: { none: {} } },
        select: { id: true },
      });
      if (orfas.length) {
        fatos += (
          await prisma.enrichmentFact.deleteMany({
            where: { targetType: "company", targetId: { in: orfas.map((o) => o.id) } },
          })
        ).count;
      }
    }
  }
  if (deleted > 0) logger.info({ teamId, contatos: deleted, fatos, midias, conversasLid }, "[lgpd] contatos excluídos");
  return { deleted };
}
