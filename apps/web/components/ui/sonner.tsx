"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:rounded-md group-[.toaster]:border-line group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:shadow-popover group-[.toaster]:font-sans",
          title: "group-[.toast]:text-body group-[.toast]:font-medium",
          description: "group-[.toast]:text-small group-[.toast]:text-ink-2",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-ink-2",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
