"use client";

import { Download, FileText, FileSpreadsheet, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Botão único "Exportar" com menu CSV/Excel (economiza espaço na toolbar). */
export function ExportContactsMenu({ csvHref, xlsxHref }: { csvHref: string; xlsxHref: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="mr-1.5 h-4 w-4" /> Exportar
          <ChevronDown className="ml-1 h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Exportar contatos</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={csvHref} target="_blank" rel="noreferrer">
            <FileText className="mr-2 h-4 w-4" /> Exportar CSV
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={xlsxHref} target="_blank" rel="noreferrer">
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Exportar Excel
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
