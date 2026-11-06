import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Pílula neutra (v2). A gramática da identidade proíbe pílulas coloridas para
 * STATUS — status é ponto + texto (ver status-dot.tsx). A Badge fica para
 * rótulos de categoria (tag, tipo, contagem): fundo cinza, texto tinta-2.
 * As variantes semânticas continuam existindo para compatibilidade, mas são
 * sóbrias (texto colorido, fundo quase branco), nunca blocos de cor.
 */
const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-caption font-medium",
  {
    variants: {
      variant: {
        default: "bg-brand-100 text-brand-500",
        secondary: "bg-muted text-ink-2",
        neutral: "bg-muted text-ink-2",
        outline: "border border-line-strong text-foreground",
        "outline-muted": "border border-line text-ink-2",
        destructive: "bg-danger-100 text-danger-700",
        success: "bg-success-100 text-success-700",
        warning: "bg-warning-100 text-warning-700",
        info: "bg-info-100 text-info-700",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
