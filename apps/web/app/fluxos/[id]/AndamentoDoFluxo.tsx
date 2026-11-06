"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { andamentoDoFluxoAction, retomarSeguradasAction } from "../actions";

/** O que a tela mostra do andamento (espelha `AndamentoDoFluxo` do core, sem importar o servidor no cliente). */
export type Andamento = {
  fluxoStatus: string;
  total: number;
  executando: number;
  aguardando: number;
  aguardandoResposta: number;
  naFilaSocial: number;
  seguradasPelaPausa: number;
  seguradasParaRevisao: number;
  concluidas: number;
  falhas: number;
};

const ATUALIZA_A_CADA_MS = 15_000;

/**
 * Andamento do fluxo por estado, com contadores (incidente de 02/10/2026: sem isto, um fluxo grande parecia parado e a
 * pessoa pausava e ativava de novo). Atualiza sozinho enquanto há gente andando. Com seguradas pela pausa:
 * - fluxo pausado: avisa que voltam ao ativar;
 * - fluxo no ar: botão "Retomar as seguradas" (o que sobrou para trás volta ao passo em que parou).
 */
export function AndamentoDoFluxo({ flowId, inicial }: { flowId: string; inicial: Andamento }) {
  const [a, setA] = useState<Andamento>(inicial);
  const [retomando, iniciarRetomada] = useTransition();

  useEffect(() => setA(inicial), [inicial]);

  // Enquanto o fluxo está no ar e tem gente andando, lê de novo a cada 15 s (aba visível). Falha ao ler: mantém o que tem.
  const andando = a.fluxoStatus === "active" && a.executando + a.aguardando + a.aguardandoResposta + a.naFilaSocial > 0;
  useEffect(() => {
    if (!andando) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void andamentoDoFluxoAction(flowId).then((r) => {
        if (r.andamento) setA(r.andamento);
      });
    }, ATUALIZA_A_CADA_MS);
    return () => clearInterval(id);
  }, [andando, flowId]);

  if (a.total === 0) return null;

  const itens: Array<{ tone: StatusTone; n: number; texto: string }> = [
    { tone: "ok", n: a.executando, texto: "rodando" },
    { tone: "info", n: a.aguardando, texto: "aguardando a hora" },
    { tone: "info", n: a.aguardandoResposta, texto: "esperando resposta" },
    { tone: "info", n: a.naFilaSocial, texto: "DM na fila" },
    { tone: "attention", n: a.seguradasPelaPausa, texto: a.seguradasPelaPausa === 1 ? "segurada pela pausa" : "seguradas pela pausa" },
    { tone: "attention", n: a.seguradasParaRevisao, texto: "para revisar (aba Histórico)" },
    { tone: "done", n: a.concluidas, texto: a.concluidas === 1 ? "concluída" : "concluídas" },
    { tone: "error", n: a.falhas, texto: a.falhas === 1 ? "falhou (aba Histórico)" : "falharam (aba Histórico)" },
  ];

  function retomar() {
    iniciarRetomada(async () => {
      const r = await retomarSeguradasAction(flowId);
      if (!r.ok) {
        toast.error("Não deu para retomar", { description: r.error });
        return;
      }
      const n = r.retomadas ?? 0;
      toast.success(n > 0 ? `${n} ${n === 1 ? "inscrição continuou" : "inscrições continuaram"} de onde parou` : "Não havia inscrição segurada");
      const novo = await andamentoDoFluxoAction(flowId);
      if (novo.andamento) setA(novo.andamento);
    });
  }

  return (
    <section aria-label="Andamento do fluxo" className="rounded-lg border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-body font-medium">Andamento</h2>
        <span className="text-caption text-muted-foreground">
          {a.total} {a.total === 1 ? "pessoa" : "pessoas"} no fluxo
        </span>
        {a.seguradasPelaPausa > 0 && a.fluxoStatus === "active" ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={retomar} disabled={retomando}>
            {retomando ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Retomar as seguradas
          </Button>
        ) : null}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
        {itens
          .filter((i) => i.n > 0)
          .map((i) => (
            <li key={i.texto}>
              <StatusDot tone={i.tone}>
                <span className="tabular-nums font-medium text-foreground">{i.n}</span> {i.texto}
              </StatusDot>
            </li>
          ))}
      </ul>
      {a.seguradasPelaPausa > 0 && a.fluxoStatus !== "active" ? (
        <p className="mt-2 text-caption text-muted-foreground">
          O fluxo está pausado: {a.seguradasPelaPausa} {a.seguradasPelaPausa === 1 ? "inscrição parou" : "inscrições pararam"} onde estavam e continuam de lá quando você ativar.
        </p>
      ) : null}
      {a.seguradasPelaPausa > 0 && a.fluxoStatus === "active" ? (
        <p className="mt-2 text-caption text-muted-foreground">
          {a.seguradasPelaPausa} {a.seguradasPelaPausa === 1 ? "inscrição ficou parada" : "inscrições ficaram paradas"} por uma pausa anterior. O CRM Agro retoma sozinho em poucos minutos; para continuar agora, use Retomar as seguradas.
        </p>
      ) : null}
    </section>
  );
}
