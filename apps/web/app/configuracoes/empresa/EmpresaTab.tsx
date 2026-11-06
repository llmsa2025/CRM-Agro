"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { EmpresaDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionHeader } from "@/components/ui/page-header";
import { CidadeEstadoCampos } from "@/components/cidade-estado";
import { atualizarEmpresaAction } from "./actions";

/** CNPJ com máscara só para mostrar (o banco guarda os 14 dígitos). */
function cnpjFormatado(c: string | null): string {
  if (!c || c.length !== 14) return c ?? "";
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

/** Configurações → Empresa: os dados da empresa do time. Quem não é master/admin só vê. */
export function EmpresaTab({ empresa, podeEditar }: { empresa: EmpresaDTO; podeEditar: boolean }) {
  const [nome, setNome] = useState(empresa.nome);
  const [cnpj, setCnpj] = useState(cnpjFormatado(empresa.cnpj));
  const [cidade, setCidade] = useState(empresa.cidade ?? "");
  const [estado, setEstado] = useState(empresa.estado ?? "");
  const [pending, start] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const r = await atualizarEmpresaAction({ nome, cnpj, cidade, estado });
      if (!r.ok) return void toast.error("Não deu para salvar", { description: r.error });
      setCnpj(cnpjFormatado(r.empresa.cnpj));
      setEstado(r.empresa.estado ?? "");
      toast.success("Dados da empresa salvos");
    });
  }

  return (
    <form onSubmit={salvar} className="flex max-w-xl flex-col gap-4">
      <SectionHeader title="Empresa" />
      {!podeEditar && <p className="text-small text-ink-2">Só o master e os administradores alteram estes dados.</p>}
      <div className="grid gap-1.5">
        <Label htmlFor="emp-nome">Nome da empresa</Label>
        <Input id="emp-nome" value={nome} onChange={(e) => setNome(e.target.value)} disabled={!podeEditar} maxLength={120} required minLength={2} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="emp-cnpj">CNPJ (opcional)</Label>
        <Input id="emp-cnpj" value={cnpj} onChange={(e) => setCnpj(e.target.value)} disabled={!podeEditar} inputMode="numeric" maxLength={18} placeholder="00.000.000/0000-00" />
      </div>
      <CidadeEstadoCampos
        idPrefix="emp"
        cidade={cidade}
        estado={estado}
        desativado={!podeEditar}
        rotuloEstado="UF"
        onChange={(v) => {
          setCidade(v.cidade);
          setEstado(v.estado);
        }}
      />
      {podeEditar && (
        <div>
          <Button type="submit" disabled={pending || nome.trim().length < 2}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </div>
      )}
    </form>
  );
}
