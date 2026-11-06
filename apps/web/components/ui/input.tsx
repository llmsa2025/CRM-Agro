import * as React from "react";
import { cn } from "@/lib/utils";

/** Campo de texto (v2): 36px, borda linha-forte, raio 6, foco = anel verde fino. */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-line-strong bg-background px-3 py-1 text-body text-foreground transition-colors file:border-0 file:bg-transparent file:text-body file:font-medium placeholder:text-ink-3 focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
