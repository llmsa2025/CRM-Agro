"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const OPTS = [
  { value: "hoje", label: "Hoje" },
  { value: "semana", label: "Semana" },
  { value: "mes", label: "Mês" },
] as const;

/** Seletor de período do Painel — abas sublinhadas (identidade v2). */
export function PeriodToggle({ current }: { current: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function set(value: string) {
    const params = new URLSearchParams(sp?.toString() ?? "");
    params.set("period", value);
    router.push(`${pathname ?? "/"}?${params.toString()}`);
  }

  return (
    <div role="tablist" aria-label="Período" className="flex gap-5 border-b border-line">
      {OPTS.map((o) => {
        const ativo = current === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={ativo}
            onClick={() => set(o.value)}
            className={cn(
              "-mb-px h-8 border-b-2 text-body transition-colors",
              ativo ? "border-foreground font-medium text-foreground" : "border-transparent text-ink-2 hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
