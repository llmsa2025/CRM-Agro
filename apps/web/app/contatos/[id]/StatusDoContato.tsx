"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronDown } from "lucide-react";
import { StatusBadge, RELACIONAMENTO_STATUS } from "@/components/ui/status-badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { setStatusAction } from "../actions";

const MARCAVEIS = ["novo", "ja_conversou", "cliente"] as const;

/**
 * Status do contato na ficha, com a troca ali mesmo (Nunca contatado, Contatado, Cliente). Quem pediu para sair
 * mostra o status sem menu: ele não muda por aqui.
 */
export function StatusDoContato({ contactId, status, podeEditar }: { contactId: string; status: string; podeEditar: boolean }) {
  const router = useRouter();
  const [atual, setAtual] = useState(status);
  if (!podeEditar || atual === "opt_out") return <StatusBadge status={atual} />;

  async function marcar(v: (typeof MARCAVEIS)[number]) {
    if (v === atual) return;
    const anterior = atual;
    setAtual(v);
    const res = await setStatusAction(contactId, v);
    if (res.ok) {
      toast.success(`Status: ${RELACIONAMENTO_STATUS[v]?.label ?? v}`);
      router.refresh();
    } else {
      setAtual(anterior);
      toast.error("Não mudei o status", { description: res.error });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Mudar o status do contato" className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
          <StatusBadge status={atual} />
          <ChevronDown className="h-3.5 w-3.5 text-ink-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {MARCAVEIS.map((s) => (
          <DropdownMenuItem key={s} onSelect={() => marcar(s)}>
            {s === atual ? <Check className="mr-2 h-4 w-4" /> : <span className="mr-2 h-4 w-4" />}
            {RELACIONAMENTO_STATUS[s]?.label ?? s}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
