import { NextResponse } from "next/server";
import { runWithTeam } from "@crmagro/db";
import { currentUser } from "@/lib/tenant";
import { xlsxEmStream } from "@/lib/export-xlsx";
import { exportarContatosCsv, exportFiltersSchema, lotesDeContatosParaExportar, resolverBuscaDaExportacao } from "@crmagro/core";

/**
 * GET /api/contatos/export?format=csv|xlsx
 *
 * Exporta TODOS os contatos do time (com filtros opcionais) em CSV ou Excel,
 * em STREAMING (item 2.7, K2): lotes de 1.000 lidos do banco conforme o
 * download avança — memória constante, 1º byte na hora.
 *
 * - CSV: text/csv, com proteção de fórmula (item 3.7);
 * - XLSX: application/vnd.openxmlformats, `WorkbookWriter` do exceljs.
 *
 * Filtros validados na borda (zod): valor inválido → 400, em vez de exportar
 * a base inteira sem o filtro que o usuário pediu.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "NaoAutenticado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const parsed = exportFiltersSchema.safeParse({
    search: url.searchParams.get("search") || undefined,
    status: url.searchParams.get("status") || undefined,
    interesse: url.searchParams.get("interesse") || undefined,
    origem: url.searchParams.get("origem") || undefined,
    tag: url.searchParams.get("tag") || undefined,
    produtor: url.searchParams.get("produtor") || undefined,
    agro: url.searchParams.get("agro") || undefined,
    dono: url.searchParams.get("dono") || undefined,
    // "exportar selecionados": ids passados como lista separada por vírgula.
    ids: url.searchParams.get("ids")?.split(",").filter(Boolean),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "FiltroInvalido", issues: parsed.error.issues }, { status: 400 });
  }
  const identidade = { userId: user.id, role: user.role, modulos: user.modulos, verTudoEm: user.verTudoEm, editarTudoEm: user.editarTudoEm };

  // RBAC (S7): exportar a base inteira é admin — o core recusa (`contacts.export`).
  // O papel e o time são resolvidos AQUI, dentro do runWithTeam; os lotes são
  // lidos depois, enquanto a resposta é enviada.
  let corpo: ReadableStream<Uint8Array>;
  try {
    // A busca por texto é resolvida AQUI (dentro do contexto do time): a planilha traz os mesmos contatos que a tela.
    const filters = await runWithTeam(user.teamId, () => resolverBuscaDaExportacao(parsed.data), identidade);
    corpo = runWithTeam(
      user.teamId,
      () => (format === "xlsx" ? xlsxEmStream(lotesDeContatosParaExportar(filters)) : exportarContatosCsv(filters)),
      identidade,
    );
  } catch (e) {
    if (e instanceof Error && e.name === "ForbiddenError") {
      return NextResponse.json({ error: "ForbiddenError" }, { status: 403 });
    }
    if (e instanceof Error && (e.name === "BuscaGrandeDemais" || e.name === "BuscaMuitoLenta")) {
      return NextResponse.json({ error: e.name, message: e.message.replace(/^[A-Za-z]+: /, "") }, { status: 400 });
    }
    throw e;
  }

  const dateStr = new Date().toISOString().split("T")[0];
  const cabecalhos =
    format === "xlsx"
      ? {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="contatos-${dateStr}.xlsx"`,
        }
      : {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="contatos-${dateStr}.csv"`,
        };
  return new NextResponse(corpo, { status: 200, headers: { ...cabecalhos, "Cache-Control": "no-store" } });
}
