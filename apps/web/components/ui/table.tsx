import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tabela (v2): SEM card em volta; linhas separadas por hairline; cabeçalho
 * 12px em tinta-3, sentence case; linha 52px; hover discreto.
 */
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn("w-full caption-bottom text-body", className)} {...props} />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={cn("[&_tr]:border-b [&_tr:hover]:bg-transparent", className)} {...props} />
  ),
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn("", className)} {...props} />
  ),
);
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot ref={ref} className={cn("border-t font-medium [&>tr]:last:border-b-0", className)} {...props} />
  ),
);
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "border-b border-line transition-colors hover:bg-accent/60 data-[state=selected]:bg-brand-100/60",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

interface TableCellProps<T> extends React.HTMLAttributes<T> {
  /** Célula numérica: alinha à direita e usa numéricos tabulares (colunas de valor). */
  numeric?: boolean;
}

const TableHead = React.forwardRef<HTMLTableCellElement, TableCellProps<HTMLTableCellElement> & React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, numeric, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-10 px-3 text-left align-middle text-caption font-medium text-ink-3 first:pl-0 last:pr-0 [&:has([role=checkbox])]:pr-0",
        numeric && "text-right tabular-nums",
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps<HTMLTableCellElement> & React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, numeric, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        "h-[52px] px-3 align-middle first:pl-0 last:pr-0 [&:has([role=checkbox])]:pr-0",
        numeric && "text-right tabular-nums",
        className,
      )}
      {...props}
    />
  ),
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn("mt-4 text-caption text-ink-3", className)} {...props} />
  ),
);
TableCaption.displayName = "TableCaption";

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
