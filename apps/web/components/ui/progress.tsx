import * as React from "react";
import { cn } from "@/lib/utils";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Percentual preenchido (0–100). Valores fora do intervalo são clampados. */
  value?: number;
  /** Cor da barra preenchida. Default: verde-mata. */
  indicatorClassName?: string;
}

/**
 * Barra de progresso (v2): 3px de altura, trilho #F0F2F1, preenchimento
 * verde-mata. Acessível via `role="progressbar"`.
 */
const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, indicatorClassName, ...props }, ref) => {
    const clamped = Math.min(100, Math.max(0, value));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        className={cn("relative h-[3px] w-full overflow-hidden rounded-full bg-muted", className)}
        {...props}
      >
        <div
          className={cn("h-full rounded-full bg-brand-500 transition-[width]", indicatorClassName)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    );
  },
);
Progress.displayName = "Progress";

export { Progress };
