"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { markTaskDoneAction, undoTaskDoneAction } from "@/app/atividades/actions";

/**
 * Check da tarefa do dia (produto §F). Marcar tira o item da lista de hoje;
 * desfazer traz de volta. O servidor revalida Painel e Atividades.
 */
export function TaskCheck({ chave, feita, label }: { chave: string; feita: boolean; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Checkbox
      checked={feita}
      disabled={pending}
      aria-label={feita ? `Desfazer: ${label}` : `Marcar como feita: ${label}`}
      className="mt-0.5"
      onCheckedChange={(v) => {
        start(async () => {
          const res = v ? await markTaskDoneAction(chave) : await undoTaskDoneAction(chave);
          if (res.error) toast.error("Não deu para marcar", { description: res.error });
          else router.refresh();
        });
      }}
    />
  );
}
