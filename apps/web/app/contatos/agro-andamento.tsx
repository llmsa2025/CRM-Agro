"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { AndamentoAgro } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { andamentoAgroAction, cancelarAgroAction } from "./actions";

/**
 * Andamento da verificação do agro em segundo plano (botão "Verificar agro" com "Selecionar todos do filtro").
 * Aparece enquanto o lote anda, consulta a cada poucos segundos e, quando termina, avisa e atualiza a lista.
 * Sobrevive a sair da tela: o estado vem do servidor (Redis), não desta aba.
 */

const INTERVALO_MS = 4000;
const numero = (n: number) => n.toLocaleString("pt-BR");

function fraseDoFim(a: AndamentoAgro): string {
  const partes = [`${numero(a.total)} ${a.total === 1 ? "contato" : "contatos"}.`];
  if (a.naFila) partes.push(`${numero(a.naFila)} foto(s) esperam a leitura do Claude.`);
  if (a.manuais) partes.push(`${numero(a.manuais)} ajustado(s) à mão ficaram como estavam.`);
  if (a.falhas) partes.push(`${numero(a.falhas)} não deu para verificar.`);
  return partes.join(" ");
}

export function AgroAndamento({ inicial }: { inicial: AndamentoAgro | null }) {
  const router = useRouter();
  const [a, setA] = useState<AndamentoAgro | null>(inicial);
  const [pending, startTransition] = useTransition();
  const andando = a?.estado === "andando";
  const loteId = a?.loteId;

  // A página renderizou de novo (por exemplo, logo depois de começar um lote): vale o que o servidor mandou.
  useEffect(() => setA(inicial), [inicial]);

  useEffect(() => {
    if (!andando) return;
    let vivo = true;
    const timer = setInterval(async () => {
      const novo = await andamentoAgroAction();
      if (!vivo) return;
      if (novo && novo.loteId === loteId && novo.estado === "andando") {
        setA(novo);
        return;
      }
      // Terminou, foi cancelado ou sumiu: para de consultar.
      setA(novo && novo.loteId === loteId ? novo : null);
      if (novo?.estado === "concluido") toast.success("Verificação do agro concluída", { description: fraseDoFim(novo) });
      if (novo?.estado === "cancelado") toast.message("Verificação do agro cancelada", { description: "O que já foi verificado ficou." });
      router.refresh();
    }, INTERVALO_MS);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [andando, loteId, router]);

  if (!a || a.estado !== "andando") return null;

  const nosNomes = a.cadastro < a.total;
  const feitos = nosNomes ? a.cadastro : a.fotos;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line px-3 py-2 text-small text-ink-2">
      <Loader2 className="h-4 w-4 animate-spin text-ink-3" aria-hidden />
      <span>
        {nosNomes ? "Verificando o agro, nomes e empresas" : "Procurando as fotos do WhatsApp"}: <span className="num font-medium text-foreground">{numero(feitos)}</span> de{" "}
        <span className="num">{numero(a.total)}</span>.
      </span>
      <span className="text-ink-3">Pode sair da tela, o CRM Agro continua em segundo plano.</span>
      <Button
        variant="ghost-subtle"
        size="sm"
        className="ml-auto"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await cancelarAgroAction();
            if (r.error) toast.error("Não deu para cancelar", { description: r.error });
            else router.refresh();
          })
        }
      >
        Cancelar
      </Button>
    </div>
  );
}
