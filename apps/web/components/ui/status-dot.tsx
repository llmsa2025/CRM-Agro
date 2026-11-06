import { cn } from "@/lib/utils";

/**
 * Status = ponto de 6px + texto 13px (dicionário único da identidade v2).
 *
 *   ok        #2F7A45  Enviando / Ativo / Respondeu / Cliente / Conectado
 *   info      #2F5B8A  Agendada / Pediu para depois / Contatado
 *   attention #9A6212  Rascunho / Pausado / Segurado / Parado / Dúvida
 *   error     #A8321E  Falhou / Não quer contato / Saiu da lista
 *   done      #69706B  Concluída / Arquivado
 *   empty     anel vazado — Nunca contatado / Não avaliado
 */
export type StatusTone = "ok" | "info" | "attention" | "error" | "done" | "empty" | "brand";

const DOT: Record<StatusTone, string> = {
  ok: "bg-success-500",
  info: "bg-info-500",
  attention: "bg-warning-500",
  error: "bg-danger-500",
  done: "bg-ink-3",
  brand: "bg-brand-500",
  empty: "border-[1.5px] border-ink-3 bg-transparent",
};

export function StatusDot({
  tone,
  children,
  className,
  size = "sm",
}: {
  tone: StatusTone;
  children?: React.ReactNode;
  className?: string;
  /** sm = 13px (tabelas/listas) · md = 14px (cabeçalhos). */
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[7px] whitespace-nowrap text-ink-2",
        size === "sm" ? "text-small" : "text-body",
        className,
      )}
    >
      <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", DOT[tone])} aria-hidden />
      {children}
    </span>
  );
}
