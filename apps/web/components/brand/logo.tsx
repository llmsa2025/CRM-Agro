import { cn } from "@/lib/utils";

/**
 * Marca do CRM Agro: um broto (duas folhas douradas sobre a haste e uma linha de solo)
 * e o wordmark "crm agro" em serifa minúscula.
 *
 * `tone="light"` para fundo escuro (menu verde, painel de login);
 * `tone="dark"` para fundo claro (tinta).
 */
export function LogoMark({ className, tone = "light", size = 24 }: { className?: string; tone?: "light" | "dark"; size?: number }) {
  const traco = tone === "light" ? "#FFFFFF" : "#1A1F1C";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M12 19.5V10.5" stroke={traco} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 13.5c0-3.3-2.4-5.3-6-5.3 0 3.3 2.1 5.3 6 5.3z" fill="#D4A13A" />
      <path d="M12 11.2c0-3.5 2.3-5.7 6-5.7 0 3.6-2.3 5.7-6 5.7z" fill="#E8C25F" />
      <rect x="5" y="20.4" width="14" height="1.8" rx="0.9" fill={traco} />
    </svg>
  );
}

export function Logo({
  className,
  tone = "light",
  size = 24,
  wordmark = true,
}: {
  className?: string;
  tone?: "light" | "dark";
  size?: number;
  wordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark tone={tone} size={size} />
      {wordmark && (
        <span
          className={cn(
            "font-serif font-medium leading-none tracking-[-0.015em]",
            tone === "light" ? "text-white" : "text-foreground",
          )}
          style={{ fontSize: Math.round(size * 0.92) }}
        >
          crm agro
        </span>
      )}
    </span>
  );
}
