import { db } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { assertOwned, assertOwnedMany } from "../tenancy/assert-owned";
import { FlowNotActive, FlowNotFound, InvalidGraphError, SelecaoGrandeDemais } from "./errors";
import { escopoFluxo } from "./escopo";
import { NOS_QUE_FALAM_COM_O_CONTATO } from "./tipos";
import { enrollManyByTrigger } from "./triggers";

/**
 * Gatilho "Contatos selecionados" (`triggerType = contacts_selected`): o fluxo não dispara sozinho. Quem decide é a
 * pessoa, que seleciona contatos na tela de Contatos e manda rodar o fluxo neles ("Rodar fluxo").
 *
 * Não é o gatilho Manual. O Manual continua servindo ao "Testar" (um contato) e à troca de fluxo (`switch_flow`);
 * este é a inscrição em lote feita por uma pessoa.
 */

/**
 * Contatos que cabem numa chamada. A inscrição roda dentro da requisição da tela, em lotes de 100 e com freio
 * (`pressao.ts`); acima disto o pedido pode estourar o tempo da requisição, então a pessoa roda em partes.
 */
export const MAX_CONTATOS_POR_VEZ = 1000;

export type FluxoParaSelecionados = { id: string; nome: string };

/** Fluxos no ar com este gatilho que a pessoa pode rodar (os que ela altera). Alimenta o menu "Rodar fluxo" de Contatos. */
export async function listarFluxosParaContatosSelecionados(): Promise<FluxoParaSelecionados[]> {
  const prisma = db();
  return prisma.flow.findMany({
    where: { AND: [{ triggerType: "contacts_selected", status: "active", tipo: { not: "marketing" } }, escopoFluxo({ escrita: true })] },
    orderBy: { nome: "asc" },
    select: { id: true, nome: true },
  });
}

/**
 * Inscreve os contatos escolhidos no fluxo. Mesmas travas do gatilho de sempre (`enrollManyByTrigger`): quem pediu
 * para sair não entra, quem já está percorrendo o fluxo é pulado, fluxo exclusivo e reentrada valem.
 *
 * - O id do fluxo e os ids dos contatos vêm do cliente: todos passam por `assertOwned`/`assertOwnedMany` antes de
 *   qualquer escrita (um id alheio derruba a chamada inteira).
 * - Fluxo que fala com o contato e mais de um contato: entra com o espaçamento aleatório de lote (controle de ritmo), como a
 *   tag em massa. Um contato só entra na hora.
 *
 * `ignorados` = os que o motor barrou (já no fluxo, pediu para sair, reentrada, exclusivo).
 */
export async function inscreverContatosSelecionados(
  flowId: string,
  contactIds: readonly string[],
): Promise<{ inscritas: number; ignorados: number }> {
  requireCan("flows.write");
  const prisma = db();
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) throw new InvalidGraphError("selecione ao menos um contato");
  if (ids.length > MAX_CONTATOS_POR_VEZ) throw new SelecaoGrandeDemais(MAX_CONTATOS_POR_VEZ, ids.length);

  const flow = await prisma.flow.findFirst({
    where: { AND: [{ id: flowId }, escopoFluxo()] },
    select: { id: true, status: true, triggerType: true, tipo: true },
  });
  if (!flow) throw new FlowNotFound(flowId);
  await assertOwned("flow", flowId); // escrita: com "Ver de todos" em Fluxos, lê o do colega mas não roda
  if (flow.status !== "active") throw new FlowNotActive(flowId);
  if (flow.triggerType !== "contacts_selected") throw new InvalidGraphError("o gatilho deste fluxo não é Contatos selecionados");
  if (flow.tipo === "marketing") throw new InvalidGraphError("fluxo de Marketing não recebe contatos");
  await assertOwnedMany("contact", ids);

  const [nos, falam] = await Promise.all([
    prisma.flowNode.count({ where: { flowId } }),
    prisma.flowNode.count({ where: { flowId, tipo: { in: [...NOS_QUE_FALAM_COM_O_CONTATO] as never[] } } }),
  ]);
  if (nos === 0) throw new InvalidGraphError("fluxo sem nós");

  const { inscritas } = await enrollManyByTrigger("contacts_selected", ids, { emLote: falam > 0 && ids.length > 1 }, { soFluxoId: flowId });
  return { inscritas, ignorados: ids.length - inscritas };
}
