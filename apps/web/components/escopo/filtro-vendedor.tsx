"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Pessoa do time como a tela recebe (espelho de `PessoaDoTime` do core). */
export type PessoaLite = { id: string; nome: string; ativo: boolean };

const TODOS = "__todos__";

/**
 * "Por vendedor" (F3d/F4): só aparece para quem vê o time todo (master, admin,
 * "ver tudo") — a tela manda a lista de pessoas só nesse caso. O estado mora na
 * URL (`?<param>=<userId>`), então o filtro sobrevive ao recarregar e ao voltar.
 */
export function FiltroVendedor({ pessoas, param = "dono", rotuloTodos = "Vendedor: todos" }: { pessoas: PessoaLite[]; param?: string; rotuloTodos?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  if (pessoas.length < 2) return null;
  const atual = sp?.get(param) ?? "";

  function escolher(v: string) {
    const params = new URLSearchParams(sp?.toString() ?? "");
    if (v && v !== TODOS) params.set(param, v);
    else params.delete(param);
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <Select value={atual || TODOS} onValueChange={escolher}>
      <SelectTrigger className="h-9 w-[190px]" aria-label="Vendedor">
        <SelectValue placeholder="Vendedor" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TODOS}>{rotuloTodos}</SelectItem>
        {pessoas.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.nome}
            {p.ativo ? "" : " (desativado)"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
