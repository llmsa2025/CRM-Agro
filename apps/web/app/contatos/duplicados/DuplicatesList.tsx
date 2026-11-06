"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Merge, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import type { DuplicateGroup } from "@crmagro/core";
import { mergeContactsAction, deleteContactsBulkAction } from "../actions";

export function DuplicatesList({ groups }: { groups: DuplicateGroup[] }) {
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <GroupCard key={g.contacts.map((c) => c.id).join("-")} group={g} />
      ))}
    </div>
  );
}

function GroupCard({ group }: { group: DuplicateGroup }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [keepId, setKeepId] = useState(group.contacts[0]?.id ?? "");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const radioName = `keep-${group.contacts[0]?.id}`;

  function toggle(id: string) {
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function unificar() {
    const drops = group.contacts.map((c) => c.id).filter((id) => id !== keepId);
    if (!keepId || drops.length === 0) {
      toast.error("Escolha qual contato manter");
      return;
    }
    start(async () => {
      const res = await mergeContactsAction(keepId, drops);
      if (res.ok) {
        toast.success("Contatos unificados");
        router.refresh();
      } else {
        toast.error("Falha ao unificar", { description: res.error });
      }
    });
  }

  function excluir() {
    const ids = [...checked];
    if (ids.length === 0) {
      toast.error("Marque ao menos um contato");
      return;
    }
    if (!confirm(`Excluir ${ids.length} contato(s)? Esta ação não pode ser desfeita.`)) return;
    start(async () => {
      const res = await deleteContactsBulkAction({ ids });
      if (res.ok) {
        toast.success(`${res.deleted ?? ids.length} excluído(s)`);
        router.refresh();
      } else {
        toast.error("Falha ao excluir", { description: res.error });
      }
    });
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-body font-semibold">{group.contacts[0]?.nome}</span>
        {group.reasons.map((r) => (
          <Badge key={r} variant="outline-muted">
            {r}
          </Badge>
        ))}
        <span className="text-caption text-muted-foreground">· {group.contacts.length} contatos</span>
      </div>

      <div className="space-y-2">
        {group.contacts.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-md border p-2.5">
            <input
              type="checkbox"
              checked={checked.has(c.id)}
              onChange={() => toggle(c.id)}
              aria-label={`Selecionar ${c.nome}`}
              className="h-4 w-4"
            />
            <label className="flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground">
              <input
                type="radio"
                name={radioName}
                checked={keepId === c.id}
                onChange={() => setKeepId(c.id)}
                className="h-4 w-4"
              />
              manter
            </label>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium">{c.nome}</div>
              <div className="truncate text-caption text-muted-foreground">
                {[c.telefone, c.email, c.empresa, c.cidade].filter(Boolean).join(" · ") || "sem dados"}
                {" · criado "}
                {formatDate(c.createdAt)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={excluir} disabled={pending}>
          <Trash2 className="mr-1.5 h-4 w-4" /> Excluir selecionados
        </Button>
        <Button size="sm" onClick={unificar} disabled={pending}>
          <Merge className="mr-1.5 h-4 w-4" /> Unificar no marcado
        </Button>
      </div>
    </div>
  );
}
