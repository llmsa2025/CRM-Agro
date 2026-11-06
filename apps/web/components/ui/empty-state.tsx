import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
}

/**
 * Estado vazio que ENSINA, não apenas avisa: diagnóstico + ação.
 * Identidade v2: sem caixa tracejada nem ícone em bolha — texto centrado com
 * respiro, ação secundária + primária.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}
      {...props}
    >
      {Icon && <Icon className="mb-4 h-5 w-5 text-ink-3" strokeWidth={1.5} aria-hidden />}
      <p className="font-serif text-h2 text-foreground">{title}</p>
      {description && <p className="mt-2 max-w-md text-body text-ink-2">{description}</p>}
      {(action || secondaryAction) && (
        <div className="mt-5 flex items-center gap-2">
          {secondaryAction}
          {action}
        </div>
      )}
    </div>
  );
}
