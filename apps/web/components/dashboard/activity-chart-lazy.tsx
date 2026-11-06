"use client";

import dynamic from "next/dynamic";
import type { DiaAtividade } from "@crmagro/core";

// O gráfico (recharts, ~100 KB) só entra no cliente e depois do conteúdo
// principal: a lista do dia aparece na hora, o gráfico chega em seguida.
// `ssr: false` só é permitido num Client Component — por isso este wrapper.
const ActivityChart = dynamic(() => import("./activity-chart").then((m) => m.ActivityChart), {
  ssr: false,
  loading: () => <div className="h-[220px]" aria-hidden />,
});

export function ActivityChartLazy({ data }: { data: DiaAtividade[] }) {
  return <ActivityChart data={data} />;
}
