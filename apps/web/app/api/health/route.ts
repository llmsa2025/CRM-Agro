import { NextResponse } from "next/server";
import { runHealthChecks, alertarSeDegradado } from "@crmagro/core";

/**
 * GET /api/health — Health check público (sem auth).
 *
 * Verifica PostgreSQL, Redis, Evolution API e o heartbeat do worker. Status:
 * - 200 healthy: todos os serviços OK
 * - 200 degraded: Evolution, worker ou motor fora (site no ar, automação parada
 *   ou atrasada: fila atrasada > 10 min, inscrições órfãs — item 1.10)
 * - 503 unhealthy: DB ou Redis fora (sistema indisponível)
 *
 * Usado por uptime checkers, Docker healthcheck e monitoramento.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rota pública: sem cache, cada acesso abriria conexões no Redis e consultaria
// banco e Evolution — martelar a URL viraria carga. 10s basta para monitor.
const CACHE_MS = 10_000;
let cache: { at: number; report: Awaited<ReturnType<typeof runHealthChecks>> } | null = null;

export async function GET() {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), report: await runHealthChecks() };
    // Alerta de operação (item 1.10): cobre também o worker PARADO, que não
    // tem como se alertar sozinho. Trava de 30 min por motivo no Redis.
    void alertarSeDegradado(cache.report);
  }
  const report = cache.report;
  const statusCode = report.status === "unhealthy" ? 503 : 200;
  // Rota PÚBLICA: devolve só status e latência de cada dependência. A mensagem de
  // erro (pode conter host do banco, porta etc.) fica só no log do servidor.
  const checks = Object.fromEntries(
    Object.entries(report.checks).map(([nome, c]) => {
      if (c.error) console.warn(`[health] ${nome}: ${c.error}`);
      return [nome, { status: c.status, latency_ms: c.latency_ms }];
    }),
  );
  return NextResponse.json({ ...report, checks }, { status: statusCode });
}
