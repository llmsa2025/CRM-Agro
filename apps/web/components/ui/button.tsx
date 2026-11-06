import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Botões (identidade v2): altura 34px, raio 6, 14px peso 500.
 *   default   → primário: fundo verde-mata, texto branco (UMA ação primária por tela)
 *   outline   → secundário: fundo branco, borda linha-forte
 *   ghost     → fantasma: sem borda, texto tinta-2
 *   destructive → só em confirmação de exclusão
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-brand-600",
        destructive: "bg-danger-500 text-danger-foreground hover:bg-danger-700",
        success: "bg-success-500 text-success-foreground hover:bg-success-700",
        warning: "bg-warning-500 text-warning-foreground hover:bg-warning-700",
        outline: "border border-line-strong bg-background text-foreground hover:bg-accent",
        secondary: "border border-line-strong bg-background text-foreground hover:bg-accent",
        ghost: "text-ink-2 hover:bg-accent hover:text-foreground",
        "ghost-subtle": "text-ink-2 hover:bg-accent hover:text-foreground",
        link: "h-auto px-0 text-brand-500 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[34px] px-3.5",
        sm: "h-8 px-3 text-small",
        xs: "h-7 px-2.5 text-caption",
        lg: "h-10 px-5",
        icon: "h-[34px] w-[34px]",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
