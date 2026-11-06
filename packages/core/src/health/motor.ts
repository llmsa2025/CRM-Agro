import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { basePrisma } from "@crmagro/db";
import { env } from "@crmagro/config";
import type { HealthCheckResult } from "./check";
import { inboundFalhosUltimaHora } from "../conversations/inbound-queue";

/**
 * Saúde do MOTOR (item 1.10 — MF-24). O heartbeat prova que o processo worker
 * existe, não que a fila anda: slots presos ou atraso de horas continuavam
 * "healthy". Aqui medimos a fila de verdade:
 * - contagem de waiting/delayed/active/failed das filas `flow` e `social`;
 * - atraso do job PRONTO mais antigo (em `wait` há quanto tempo);
 * - inscrições órfãs (active/waiting com o passo vencido há > 15 min — a
 *   varredura de 5 min não resolveu);
 * - passos que falharam na última hora;
 * - inscrições SEGURADAS PELA PAUSA com o fluxo NO AR há mais de 10 min (incidente de 02/10/2026): o motor devia tê-las
 *   retomado sozinho (`varrerSeguradasComFluxoNoAr`, a cada 5 min); se sobraram, a varredura não está dando conta ou
 *   o worker está parado. A segurada tem `nextRunAt` nulo, então a conta de órfãs não as enxergava;
 * - conexões do Google Agenda que não sincronizam porque o Google RECUSA o cliente OAuth do servidor (`invalid_client` e
 *   parentes, ver `conexoesGoogleComClienteRecusado`): a falha vira só aviso no log do worker e passou 22 horas assim
 *   (13/10/2026). Só a contagem entra na mensagem, nunca dado de pessoa;
 * - os workers vivos (heartbeat por pid) e o último job de cada um.
 *
 * `unhealthy` (→ /api/health "degraded") quando a fila `flow` atrasa > 10 min,
 * a `social` > 30 min, ou há órfãs. Leitura pesada (contagens cross-team):
 * cacheada 60 s no Redis.
 */

export const WORKER_HEARTBEAT_PREFIXO = "crmagro:worker:heartbeat:";
const CACHE_KEY = "saude:motor";
const CACHE_S = 60;
export const LIMITE_ATRASO_FLOW_MS = 10 * 60_000;
export const LIMITE_ATRASO_SOCIAL_MS = 30 * 60_000;
const ORFA_APOS_MS = 15 * 60_000;
/** Segurada pela pausa com o fluxo no ar há mais que isto: a varredura de 5 min já devia ter retomado. */
export const ENCALHADA_APOS_MS = 10 * 60_000;
/** O Google recusa as credenciais do cliente OAuth do servidor (secret ou client ID; cliente apagado): não passa sozinho. */
export const ERROS_DE_CLIENTE_RECUSADO_DO_GOOGLE = ["invalid_client", "deleted_client", "unauthorized_client"] as const;
/** Falhas seguidas (a espera entre elas cresce até 1 h) para não alertar por um soluço do Google. */
export const FALHAS_DO_GOOGLE_PARA_AVISAR = 3;
/** Só conta quem falhou há pouco: a sincronização que falha regrava a linha pelo menos a cada ~75 min. */
const GOOGLE_FALHOU_HA_MS = 3 * 3_600_000;

export type MetricasDaFila = { waiting: number; delayed: number; active: number; failed: number; atrasoMs: number };
/** `rls`: estado do pool do papel `crmagro_app` DAQUELE worker (RLS camada 3); ausente = RLS desligado nele. */
export type WorkerVivo = { pid: number; primary: boolean; at: string; ultimoJobEm: string | null; rls?: "ok" | "problema" };

export interface SaudeDoMotor extends HealthCheckResult {
  filas: { flow: MetricasDaFila; social: MetricasDaFila };
  orfas: number;
  /** Inscrições seguradas pela pausa (`fluxo_pausado`) com o fluxo NO AR há mais de 10 min (conta até 10.000). */
  seguradasComFluxoNoAr?: number;
  /** Mensagens recebidas NÃO gravadas (tentativas esgotadas) na última hora. */
  inboundPerdidas?: number;
  /** Conexões do Google Agenda paradas porque o Google recusa o cliente OAuth do servidor. */
  googleComClienteRecusado?: number;
  falhasUltimaHora: number;
  workers: WorkerVivo[];
  motivos: string[];
}

let _conn: Redis | null = null;
const _filas = new Map<string, Queue>();

// Conexão própria, com teto de tentativas: o health nunca pode travar
// esperando um Redis fora do ar.
function conexao(): Redis {
  _conn ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
  return _conn;
}

function fila(nome: string): Queue {
  let q = _filas.get(nome);
  if (!q) {
    q = new Queue(nome, { connection: conexao() });
    _filas.set(nome, q);
  }
  return q;
}

/** Contagens + atraso do job pronto mais antigo (criação + delay → agora). */
export async function metricasDaFila(nome: string, agora = Date.now()): Promise<MetricasDaFila> {
  const q = fila(nome);
  const c = await q.getJobCounts("waiting", "delayed", "active", "failed");
  const [maisAntigo] = await q.getJobs(["wait"], 0, 0, true);
  const pronto = maisAntigo ? maisAntigo.timestamp + (maisAntigo.opts.delay ?? 0) : agora;
  return {
    waiting: c.waiting ?? 0,
    delayed: c.delayed ?? 0,
    active: c.active ?? 0,
    failed: c.failed ?? 0,
    atrasoMs: Math.max(0, agora - pronto),
  };
}

/** Workers com heartbeat vivo (uma chave por pid, expira em 90 s). */
export async function workersVivos(redis: Redis = conexao()): Promise<WorkerVivo[]> {
  const vivos: WorkerVivo[] = [];
  let cursor = "0";
  do {
    const [prox, chaves] = await redis.scan(cursor, "MATCH", `${WORKER_HEARTBEAT_PREFIXO}*`, "COUNT", 100);
    cursor = prox;
    for (const k of chaves) {
      const raw = await redis.get(k);
      if (!raw) continue;
      try {
        vivos.push(JSON.parse(raw) as WorkerVivo);
      } catch {
        // chave torta: ignora
      }
    }
  } while (cursor !== "0");
  return vivos;
}

/** Decide o status a partir das métricas (puro — testável). */
export function avaliarMotor(m: {
  flow: MetricasDaFila;
  social: MetricasDaFila;
  orfas: number;
  inboundPerdidas?: number;
  seguradasComFluxoNoAr?: number;
  googleComClienteRecusado?: number;
  /** Workers vivos cujo pool do `crmagro_app` (RLS) acusou problema no heartbeat. */
  workersComRlsQuebrado?: number;
}): string[] {
  const motivos: string[] = [];
  // Resposta de lead que não entrou no inbox nem no "respondeu?" (auditoria do #56).
  if (m.inboundPerdidas) motivos.push(`${m.inboundPerdidas} mensagem(ns) recebida(s) NÃO gravada(s) na última hora (fila inbound)`);
  // RLS ligado no worker e o pool do papel quebrado: todo db() do worker falha (fluxo, IA, campanha, inbound).
  // O /api/health só enxerga o pool do SITE, então o worker conta o dele pelo heartbeat.
  if (m.workersComRlsQuebrado) {
    motivos.push(`${m.workersComRlsQuebrado} worker(s) com o RLS quebrado (o pool do crmagro_app não responde): veja o log do worker e, se preciso, desligue o RLS do worker (remova DATABASE_URL_APP_WORKER)`);
  }
  // Só o número: sem e-mail, nome ou id de ninguém (o alerta sai por e-mail e push).
  if (m.googleComClienteRecusado) {
    motivos.push(
      `${m.googleComClienteRecusado} conexão(ões) do Google Agenda sem sincronizar: o Google recusa as credenciais do cliente OAuth do servidor (secret ou client ID). Confira o client ID e o secret do cliente OAuth no Google Cloud`,
    );
  }
  if (m.flow.atrasoMs > LIMITE_ATRASO_FLOW_MS) motivos.push(`fila flow atrasada ${Math.round(m.flow.atrasoMs / 60_000)} min`);
  if (m.social.atrasoMs > LIMITE_ATRASO_SOCIAL_MS) motivos.push(`fila social atrasada ${Math.round(m.social.atrasoMs / 60_000)} min`);
  if (m.orfas > 0) motivos.push(`${m.orfas} inscrição(ões) órfã(s) há mais de 15 min`);
  if (m.seguradasComFluxoNoAr) {
    motivos.push(`${m.seguradasComFluxoNoAr} inscrição(ões) segurada(s) pela pausa com o fluxo no ar há mais de 10 min (a varredura não as retomou)`);
  }
  return motivos;
}

/**
 * Conexões do Google Agenda que falham há pelo menos 3 rodadas seguidas com erro de cliente recusado, e falharam há
 * pouco. Lê só colunas de `CalendarSync` (a sincronização grava `GoogleApiErro: HTTP 401 (invalid_client)` em
 * `ultimoErro`). Contagem entre todos os times, de propósito (saúde da plataforma); devolve só o número.
 */
export async function conexoesGoogleComClienteRecusado(agora = Date.now()): Promise<number> {
  return basePrisma.calendarSync.count({
    where: {
      falhas: { gte: FALHAS_DO_GOOGLE_PARA_AVISAR },
      updatedAt: { gte: new Date(agora - GOOGLE_FALHOU_HA_MS) },
      connection: { status: "connected" },
      OR: ERROS_DE_CLIENTE_RECUSADO_DO_GOOGLE.map((erro) => ({ ultimoErro: { contains: `(${erro})` } })),
    },
  });
}

async function medir(agora: number): Promise<SaudeDoMotor> {
  const start = Date.now();
  const [flow, social, orfas, seguradasComFluxoNoAr, falhasUltimaHora, workers, googleComClienteRecusado] = await Promise.all([
    metricasDaFila("flow", agora),
    metricasDaFila("social", agora),
    // Cross-team de propósito (saúde da plataforma). DM esperando na fila
    // social tem a própria métrica (atraso da fila), não é órfã.
    basePrisma.enrollment.count({
      where: {
        status: { in: ["active", "waiting"] },
        nextRunAt: { lt: new Date(agora - ORFA_APOS_MS) },
        OR: [{ waitingFor: null }, { waitingFor: { not: "social" } }],
      },
    }),
    // Segurada pela pausa mas com o fluxo no ar: nada mais a traz de volta além da varredura do worker.
    basePrisma.enrollment.count({
      where: { status: "waiting", waitingFor: "fluxo_pausado", updatedAt: { lt: new Date(agora - ENCALHADA_APOS_MS) }, flow: { status: "active" } },
      take: 10_000,
    }),
    basePrisma.flowStepExecution.count({ where: { status: "failed", finishedAt: { gte: new Date(agora - 3_600_000) } } }),
    workersVivos(),
    conexoesGoogleComClienteRecusado(agora),
  ]);
  const inboundPerdidas = await inboundFalhosUltimaHora(agora);
  const workersComRlsQuebrado = workers.filter((w) => w.rls === "problema").length;
  const motivos = avaliarMotor({ flow, social, orfas, inboundPerdidas, seguradasComFluxoNoAr, googleComClienteRecusado, workersComRlsQuebrado });
  return {
    status: motivos.length ? "unhealthy" : "healthy",
    latency_ms: Date.now() - start,
    ...(motivos.length ? { error: motivos.join("; ") } : {}),
    filas: { flow, social },
    orfas,
    seguradasComFluxoNoAr,
    inboundPerdidas,
    googleComClienteRecusado,
    falhasUltimaHora,
    workers,
    motivos,
  };
}

/** Saúde do motor, com cache de 60 s no Redis. Erro de leitura = unhealthy com o motivo. */
export async function checkMotor(agora = Date.now()): Promise<SaudeDoMotor> {
  try {
    const emCache = await conexao().get(CACHE_KEY).catch(() => null);
    if (emCache) return JSON.parse(emCache) as SaudeDoMotor;
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      medir(agora),
      new Promise<never>((_, rej) => {
        relogio = setTimeout(() => rej(new Error("métricas do motor: timeout de 5 s")), 5_000);
      }),
    ]).finally(() => clearTimeout(relogio));
    await conexao().set(CACHE_KEY, JSON.stringify(r), "EX", CACHE_S).catch(() => undefined);
    return r;
  } catch (err) {
    const erro = err instanceof Error ? err.message : String(err);
    const vazia: MetricasDaFila = { waiting: 0, delayed: 0, active: 0, failed: 0, atrasoMs: 0 };
    return {
      status: "unhealthy",
      latency_ms: 0,
      error: erro,
      filas: { flow: vazia, social: vazia },
      orfas: 0,
      falhasUltimaHora: 0,
      workers: [],
      motivos: [erro],
    };
  }
}
