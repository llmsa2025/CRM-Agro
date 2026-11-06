"use client";

/**
 * DonutChart — distribuição de contatos por canal.
 *
 * PieChart com innerRadius (anel). O total fica no centro (overlay) e a
 * legenda é renderizada manualmente embaixo, com cor + nome + percentual.
 */
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

type CanalItem = { name: string; value: number; color: string };

const DATA: CanalItem[] = [
  { name: "WhatsApp", value: 65, color: "#22c55e" },
  { name: "Instagram", value: 20, color: "#a855f7" },
  { name: "Manual", value: 15, color: "#64748b" },
];

type TooltipPayloadEntry = { name?: string; value?: number; payload?: CanalItem };

function DonutTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadEntry[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0];
  if (!p) return null;
  const pct = ((p.value ?? 0) / DATA.reduce((a, d) => a + d.value, 0)) * 100;
  return (
    <div className="rounded-lg border bg-popover p-2.5 text-body shadow-lg">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: p.payload?.color }} />
        <span className="font-medium">{p.name}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {p.value} · {pct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

export function ChannelDonut() {
  const total = DATA.reduce((acc, d) => acc + d.value, 0);

  return (
    <div>
      <div className="relative" style={{ height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={DATA}
              dataKey="value"
              nameKey="name"
              innerRadius={58}
              outerRadius={82}
              paddingAngle={2}
              stroke="none"
            >
              {DATA.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {/* Total no centro do anel */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-display font-semibold tabular-nums">{total}</span>
          <span className="text-caption text-muted-foreground">contatos</span>
        </div>
      </div>

      {/* Legenda customizada embaixo */}
      <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
        {DATA.map((d) => (
          <div key={d.name} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />
            <span className="text-caption font-medium">{d.name}</span>
            <span className="text-caption text-muted-foreground tabular-nums">
              {((d.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
