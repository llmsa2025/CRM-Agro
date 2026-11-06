"use client";

import { useState, useTransition } from "react";
import { Phone, PhoneCall, Search, UserPlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { loadCallContactsAction } from "./actions";
import type { FunnelOption } from "./ManualDialerDialog";

export type CallContactListItem = {
  id: string;
  nome: string;
  empresa: string | null;
  cargo: string | null;
  telefone: string | null;
  tags: string[];
};

/**
 * Aba Contatos: lista de contatos com telefone, com busca. Cada linha tem um
 * botão Ligar que abre o discador pop-up pré-preenchido com o número do contato.
 */
export function ContatosTab({
  initial,
  funnels: _funnels,
  onCall,
}: {
  initial: { items: CallContactListItem[]; total: number };
  funnels: FunnelOption[];
  onCall: (c: CallContactListItem) => void;
}) {
  const [items, setItems] = useState(initial.items);
  const [total, setTotal] = useState(initial.total);
  const [search, setSearch] = useState("");
  const [loading, startLoad] = useTransition();

  function buscar(next?: string) {
    const q = next ?? search;
    startLoad(async () => {
      const res = await loadCallContactsAction({ search: q || undefined, limit: 50 });
      setItems(res.items);
      setTotal(res.total);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buscar()}
            placeholder="Buscar por nome, empresa ou telefone…"
            className="pl-9"
          />
        </div>
        <Button variant="outline" onClick={() => buscar()} disabled={loading}>
          Buscar
        </Button>
      </div>

      <p className="text-caption text-muted-foreground">
        {total} contato{total === 1 ? "" : "s"} com telefone
      </p>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="Nenhum contato com telefone"
          description="Importe contatos com número de WhatsApp ou cadastre um novo contato para começar a ligar."
        />
      ) : (
        <div className="divide-y rounded-lg border">
          {items.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{c.nome}</span>
                  {c.empresa && (
                    <span className="truncate text-caption text-muted-foreground">{c.empresa}</span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-caption text-muted-foreground">
                  <Phone className="h-3.5 w-3.5" />
                  <span className="tabular-nums">{c.telefone ?? "—"}</span>
                  {c.cargo && <span>· {c.cargo}</span>}
                </div>
                {c.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.tags.slice(0, 4).map((t) => (
                      <Badge key={t} variant="outline-muted" className="text-[10px]">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => onCall(c)}
                disabled={!c.telefone}
                aria-label={`Ligar para ${c.nome}`}
              >
                <PhoneCall className="mr-1.5 h-3.5 w-3.5" /> Ligar
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
