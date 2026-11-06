import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pílula de tag (v2): sempre neutra (fundo cinza, texto tinta-2, 12px). A cor
 * da tag, quando existir, vira um ponto de 6px à esquerda — sem blocos de cor.
 * `cor` é um token da paleta ou um hex. Fonte única do visual de tag na UI.
 * Com `onRemove`, ganha o botão "x" (campo de tags); só use em Client Component.
 */
const TOKEN: Record<string, string> = {
  brand: "#1F4A3A",
  amber: "#9A6212",
  emerald: "#2F7A45",
  sky: "#2F5B8A",
  pink: "#A8321E",
  violet: "#5B4A8A",
  slate: "#69706B",
};

export const TAG_COLOR_TOKENS = Object.keys(TOKEN);

export function TagPill({
  nome,
  cor,
  className,
  onRemove,
}: {
  nome: string;
  cor?: string | null;
  className?: string;
  onRemove?: () => void;
}) {
  const hex = cor ? (TOKEN[cor] ?? (cor.startsWith("#") ? cor : null)) : null;
  return (
    <span
      className={cn(
        "inline-flex max-w-[160px] items-center gap-1.5 truncate rounded bg-muted px-1.5 py-0.5 text-caption font-medium text-ink-2",
        className,
      )}
      title={nome}
    >
      {hex && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: hex }} aria-hidden />}
      <span className="truncate">{nome}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remover tag ${nome}`}
          className="-mr-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
    </span>
  );
}
