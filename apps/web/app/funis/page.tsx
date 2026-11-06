import { runAsUser } from "@/lib/tenant";
import Link from "next/link";

import { listFunnelsWithStats } from "@crmagro/core";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBRLCompact } from "@/lib/format";
import { NewFunnelButton } from "./NewFunnelButton";
import { FunnelActions } from "./DeleteFunnelButton";

export const dynamic = "force-dynamic";

const TIPO_LABEL: Record<string, string> = {
  pre_vendas: "Pré-vendas",
  vendas: "Vendas",
  follow_up: "Follow-up",
};

export default async function FunisPage() {
  const funis = await runAsUser(async () => await listFunnelsWithStats());
  const totalDeals = funis.reduce((a, f) => a + f.stages.reduce((b, s) => b + s.deals.length, 0), 0);
  const totalValor = funis.reduce(
    (a, f) => a + f.stages.reduce((b, s) => b + s.deals.reduce((c, d) => c + Number(d.valor), 0), 0),
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Funis"
        subtitle={`${funis.length} ${funis.length === 1 ? "funil" : "funis"} · ${totalDeals} negócios abertos · ${formatBRLCompact(totalValor)} em aberto`}
        actions={<NewFunnelButton />}
      />

      {funis.length === 0 ? (
        <EmptyState
          title="Você ainda não tem funis"
          description="Crie o primeiro funil para mover negócios entre etapas e enxergar onde cada um parou."
          action={<NewFunnelButton />}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Funil</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Etapas</TableHead>
              <TableHead numeric>Negócios</TableHead>
              <TableHead numeric>Em aberto</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {funis.map((f) => {
              const deals = f.stages.flatMap((s) => s.deals);
              const total = deals.reduce((acc, d) => acc + Number(d.valor), 0);
              return (
                <TableRow key={f.id}>
                  <TableCell>
                    <Link href={`/funis/${f.id}`} className="font-medium text-foreground hover:underline">
                      {f.nome}
                    </Link>
                  </TableCell>
                  <TableCell className="text-ink-2">{TIPO_LABEL[f.tipo] ?? f.tipo}</TableCell>
                  <TableCell className="truncate text-ink-2">
                    {f.stages.map((s) => s.nome).join(" → ")}
                  </TableCell>
                  <TableCell numeric className="text-ink-2">
                    {deals.length}
                  </TableCell>
                  <TableCell numeric className="font-medium">
                    {deals.length ? formatBRLCompact(total) : "—"}
                  </TableCell>
                  <TableCell>
                    <FunnelActions id={f.id} nome={f.nome} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
