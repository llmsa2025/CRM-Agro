import { runAsUser } from "@/lib/tenant";
import { notFound } from "next/navigation";

import { FunnelNotFound, can, getFunnelBoard, listarPessoasDoTime } from "@crmagro/core";
import { KanbanBoard } from "./KanbanBoard";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ dono?: string }>;

/**
 * Kanban paginado (item 2.4): só os negócios ABERTOS, 50 por etapa na primeira
 * carga; o resto vem por "Carregar mais" (`/api/funnels/:id/deals`). Contagem
 * e valor por etapa vêm do banco (não do tamanho da página).
 */
export default async function FunilPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  // F3d: "por vendedor" (o core só aplica o filtro para quem vê o time todo).
  const dono = (await searchParams).dono || undefined;

  let board;
  let pessoas;
  let podeTransferir;
  try {
    [board, pessoas, podeTransferir] = await runAsUser(async () =>
      Promise.all([getFunnelBoard(id, { dono }), listarPessoasDoTime("funis"), Promise.resolve(can("records.transfer"))]),
    );
  } catch (e) {
    if (e instanceof FunnelNotFound) notFound();
    throw e;
  }

  const funnelProp = {
    id: board.id,
    nome: board.nome,
    fechados: board.fechados,
    stages: board.stages.map((s) => ({
      id: s.id,
      nome: s.nome,
      cor: s.cor,
      total: s.total,
      valor: s.valor,
      nextCursor: s.nextCursor,
      deals: s.deals.map((d) => ({
        id: d.id,
        valor: d.valor,
        enteredStageAt: d.enteredStageAt,
        contact: d.contact,
      })),
    })),
  };

  const pessoasLite = pessoas.map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo }));
  return (
    <KanbanBoard
      funnel={funnelProp}
      pessoas={pessoasLite}
      transferirPara={podeTransferir ? pessoasLite.filter((p) => p.ativo) : []}
      dono={dono}
    />
  );
}
