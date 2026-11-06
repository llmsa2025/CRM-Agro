"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, Users } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Compartilhar com o time" / "Só eu" (F4). Quem pode mudar (o dono ou quem vê
 * o time todo) vê o botão; os outros, só o rótulo. `acao` é a server action da
 * tela (o core confere de novo quem pode).
 */
export function BotaoCompartilhar({
  compartilhado,
  podeMudar,
  acao,
  rotulo = "registro",
}: {
  compartilhado: boolean;
  podeMudar: boolean;
  acao: (compartilhado: boolean) => Promise<{ ok?: boolean; error?: string }>;
  /** "fluxo", "campanha"… — só para a mensagem. */
  rotulo?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const Icone = compartilhado ? Users : Lock;
  const texto = compartilhado ? "Time" : "Só o dono";
  if (!podeMudar) {
    return (
      <span className="inline-flex items-center gap-1 text-small text-ink-2" title={compartilhado ? "Compartilhado com o time" : "Só o dono vê"}>
        <Icone className="h-3.5 w-3.5" />
        {texto}
      </span>
    );
  }
  return (
    <Button
      variant="ghost-subtle"
      size="sm"
      disabled={pending}
      title={compartilhado ? "Compartilhado com o time. Clique para deixar só com o dono" : "Só o dono vê. Clique para compartilhar com o time"}
      onClick={() =>
        start(async () => {
          const r = await acao(!compartilhado);
          if (r.ok) {
            toast.success(!compartilhado ? `O time agora vê este ${rotulo}` : `Só o dono vê este ${rotulo}`);
            router.refresh();
          } else toast.error("Não deu para mudar", { description: r.error });
        })
      }
    >
      <Icone className="mr-1 h-3.5 w-3.5" />
      {texto}
    </Button>
  );
}
