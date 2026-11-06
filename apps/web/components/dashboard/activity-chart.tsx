"use client";

/**
 * Prospecção por dia (últimos 7 dias): barras finas — enviadas em verde-mata,
 * respostas em ok. Sem grade vertical, eixo Y oculto, tooltip sóbrio.
 */
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DiaAtividade } from "@crmagro/core";

type TooltipPayloadEntry = { dataKey?: string | number; name?: string; value?: number | string; color?: string };

function ActivityTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayloadEntry[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-popover px-3 py-2 text-small shadow-popover">
      <p className="mb-1 text-caption text-ink-3 first-letter:uppercase">{label}</p>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="num ml-auto pl-4 text-ink-2">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ActivityChart({ data }: { data: DiaAtividade[] }) {
  return (
    <div style={{ height: 220 }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barGap={3} barCategoryGap="38%">
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: "hsl(var(--ink-3))" }} tickLine={false} axisLine={false} />
          <YAxis hide />
          <Tooltip content={<ActivityTooltip />} cursor={{ fill: "hsl(var(--accent))" }} />
          <Bar dataKey="enviadas" name="Enviadas" fill="hsl(var(--brand-500))" radius={[2, 2, 0, 0]} />
          <Bar dataKey="recebidas" name="Respostas" fill="hsl(var(--success-500))" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
