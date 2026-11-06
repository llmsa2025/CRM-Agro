import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Estados embutidos da tabela (carregando/vazio) para o padrão canônico da
 * plataforma. Coexistem com <Table>; são as peças que as próximas fases
 * (Contatos/Funis/Fluxos) usam para não deixar tabela vazia crua nem "pular"
 * o layout durante o carregamento.
 */

/** Linhas-fantasma com a forma da tabela — nunca spinner solto. */
export function DataTableSkeleton({
  rows = 8,
  columns,
}: {
  rows?: number;
  columns: number;
}) {
  return (
    <TableBody>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r} className="hover:bg-transparent">
          {Array.from({ length: columns }).map((_, c) => (
            <TableCell key={c}>
              {/* Primeira coluna um pouco mais larga (nome/rótulo). */}
              <Skeleton className={c === 0 ? "h-4 w-40" : "h-4 w-16"} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

/** Estado vazio ocupando a largura toda da tabela, com ícone + ação. */
export function DataTableEmpty({
  columns,
  icon,
  title,
  description,
  action,
}: {
  columns: number;
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <TableBody>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={columns} className="h-auto p-0">
          <EmptyState
            icon={icon}
            title={title}
            description={description}
            action={action}
            className="border-0"
          />
        </TableCell>
      </TableRow>
    </TableBody>
  );
}
