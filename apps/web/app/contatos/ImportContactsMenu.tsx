"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileSpreadsheet, Download, Loader2, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { importCasaDosDadosAction } from "./actions";

/** Mesma ordem do cadastro: pessoa (nome a cargo) e empresa (empresa, cnpj, ie). */
const COLUNAS = ["nome", "sobrenome", "cpf", "telefone", "email", "cidade", "estado", "cargo", "empresa", "cnpj", "ie", "telefone2", "email2"];

/** Botão único "Importar" com menu: planilha (CSV ou Excel, com prévia), Casa dos Dados e baixar modelo. */
export function ImportContactsMenu() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const casaRef = useRef<HTMLInputElement>(null);

  async function enviar(file: File) {
    setBusy(true);
    const fd = new FormData();
    fd.set("file", file);
    const res = await importCasaDosDadosAction(undefined, fd);
    setBusy(false);
    if (res.error) toast.error("Falha ao importar", { description: res.error });
    else {
      toast.success("Importação concluída", { description: res.summary });
      router.refresh();
    }
  }

  function baixarModelo() {
    // Modelo com uma linha de exemplo (BOM UTF-8 p/ abrir certo no Excel).
    const exemplo = ["Maria", "Silva", "012.345.678-90", "(66) 99999-8888", "maria@empresa.com", "Sorriso", "MT", "Compras", "Empresa X", "01.234.567/0001-95", "123456789", "(66) 3333-7703", "financeiro@empresa.com"];
    const csv = "﻿" + COLUNAS.join(",") + "\n" + exemplo.map((v) => `"${v}"`).join(",") + "\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "modelo-contatos.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <input
        ref={casaRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void enviar(f);
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
            Importar
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Importar contatos</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => router.push("/contatos/importar")}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Importar planilha
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => casaRef.current?.click()}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Importar Casa dos Dados
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={baixarModelo}>
            <Download className="mr-2 h-4 w-4" /> Baixar modelo
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
