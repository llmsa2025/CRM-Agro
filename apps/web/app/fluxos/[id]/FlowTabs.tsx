"use client";

import { useState } from "react";

type Tab = "fluxo" | "historico" | "logs";

/**
 * Abas do editor de fluxo: Fluxo (editor visual) / Histórico (contatos que
 * precisam de atenção — travados/falhados) / Logs (execuções recentes). Recebe
 * cada aba já renderizada como slot para manter o server component enxuto.
 */
export function FlowTabs({
  fluxo,
  historico,
  logs,
  revisar,
}: {
  fluxo: React.ReactNode;
  historico: React.ReactNode;
  logs: React.ReactNode;
  revisar: number;
}) {
  const [tab, setTab] = useState<Tab>("fluxo");
  const item = (t: Tab, label: string, badge?: number) => (
    <button
      type="button"
      onClick={() => setTab(t)}
      className={`relative rounded-md px-3 py-1.5 text-body font-medium transition-colors ${
        tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
      {badge != null && badge > 0 && (
        <span className="ml-1.5 rounded-full bg-warning-500/15 px-1.5 py-0.5 text-caption text-warning-700">
          {badge}
        </span>
      )}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b pb-2">
        {item("fluxo", "Fluxo")}
        {item("historico", "Histórico", revisar)}
        {item("logs", "Logs")}
      </div>
      <div className={tab === "fluxo" ? "" : "hidden"}>{fluxo}</div>
      <div className={tab === "historico" ? "" : "hidden"}>{historico}</div>
      <div className={tab === "logs" ? "" : "hidden"}>{logs}</div>
    </div>
  );
}
