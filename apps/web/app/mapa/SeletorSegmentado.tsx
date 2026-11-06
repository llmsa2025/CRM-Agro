"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { proximoIndiceRadio } from "./modo-pontos";

/**
 * Seletor segmentado do canto do Mapa (Mapa | Satélite, Agrupar | Pontos).
 * Um `radiogroup` de verdade: só a opção marcada entra na ordem do Tab e as
 * setas (Home/End também) trocam a opção — o foco vai junto. O anel de foco é
 * interno (`ring-inset`) porque a caixa tem `overflow-hidden` e cortaria o
 * contorno padrão do navegador.
 */
export function SeletorSegmentado<V extends string>({
  rotulo,
  valor,
  opcoes,
  onChange,
}: {
  /** Nome do grupo para leitor de tela. */
  rotulo: string;
  valor: V;
  opcoes: readonly { valor: V; rotulo: string; /** Dica ao pairar o mouse. */ dica?: string }[];
  onChange: (valor: V) => void;
}) {
  const botoes = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="radiogroup" aria-label={rotulo} className="flex overflow-hidden rounded-md border border-line bg-background text-caption shadow-sm">
      {opcoes.map((o, i) => {
        const marcado = valor === o.valor;
        return (
          <button
            key={o.valor}
            ref={(el) => {
              botoes.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={marcado}
            title={o.dica}
            tabIndex={marcado ? 0 : -1}
            onClick={() => onChange(o.valor)}
            onKeyDown={(e) => {
              const j = proximoIndiceRadio(i, opcoes.length, e.key);
              if (j === null) return;
              e.preventDefault();
              onChange(opcoes[j]!.valor);
              botoes.current[j]?.focus();
            }}
            className={cn(
              "h-7 px-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset",
              marcado ? "bg-brand-500 text-white focus-visible:ring-white" : "text-ink-2 hover:bg-accent hover:text-foreground focus-visible:ring-ring",
            )}
          >
            {o.rotulo}
          </button>
        );
      })}
    </div>
  );
}
