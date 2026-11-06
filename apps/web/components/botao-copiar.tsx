"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { copiarTexto } from "@/lib/copiar";
import { cn } from "@/lib/utils";

/**
 * Botão discreto de copiar (como no chat do Claude): leva `texto` puro para a
 * área de transferência e mostra "Copiado" por 2 s.
 *
 * Visibilidade: por padrão fica transparente e aparece quando o pai com a classe
 * `group` recebe mouse ou foco (Tab); em tela de toque (sem hover) fica sempre
 * visível. `sempreVisivel` mantém o botão visível em qualquer situação.
 *
 * Posição: quem usa decide pelo `className`. Dentro de um balão, use `absolute`
 * (com o balão `relative`) para o botão não ocupar espaço no fluxo do balão.
 */
export function BotaoCopiar({
  texto,
  rotulo = "Copiar mensagem",
  sempreVisivel,
  className,
}: {
  texto: string;
  rotulo?: string;
  sempreVisivel?: boolean;
  className?: string;
}) {
  const [copiado, setCopiado] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Não deixa o timer do "Copiado" vivo depois que o botão sai da tela.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copiar(e: React.MouseEvent<HTMLButtonElement>) {
    // O botão mora dentro de cartões/balões que podem ter clique próprio.
    e.stopPropagation();
    const ok = await copiarTexto(texto);
    if (!ok) {
      toast.error("Não consegui copiar. Selecione o texto e copie manualmente.");
      return;
    }
    setCopiado(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <>
      <button
        type="button"
        onClick={copiar}
        aria-label={copiado ? "Copiado" : rotulo}
        title={rotulo}
        className={cn(
          // Área de clique de pelo menos 24×24 px; o ícone em si é 14 px.
          "inline-flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-md px-1 text-ink-3 transition-[color,opacity] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35",
          sempreVisivel || copiado
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
          className,
        )}
      >
        {copiado ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copiado ? <span className="text-caption">Copiado</span> : null}
      </button>
      {/* Anuncia o resultado para leitor de tela (o botão só troca o rótulo). */}
      <span aria-live="polite" className="sr-only">
        {copiado ? "Mensagem copiada" : ""}
      </span>
    </>
  );
}
