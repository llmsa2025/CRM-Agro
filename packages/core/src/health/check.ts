import { basePrisma, sondarBancoApp } from "@crmagro/db";
import { env, remetenteDaPlataforma } from "@crmagro/config";
import { evolutionHeaders } from "@crmagro/channels";
import { Redis } from "ioredis";
import { checkMotor, type SaudeDoMotor } from "./motor";
import { checkBackup } from "./backup";

/**
 * Health checks de infraestrutura — verifica disponibilidade das dependências
 * (PostgreSQL, Redis, Evolution API) e mede latência de cada uma.
 *
 * Usado pelo endpoint GET /api/health para monitoramento externo (uptime
 * checkers, Docker healthcheck, alertas).
 */

export type CheckStatus = "healthy" | "unhealthy";

export interface HealthCheckResult {
  status: CheckStatus;
  latency_ms: number;
  error?: string;
}

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    database: HealthCheckResult;
    redis: HealthCheckResult;
    evolution: HealthCheckResult;
    worker: HealthCheckResult;
    /** Fila andando de verdade (item 1.10): atraso, órfãs, falhas/h, workers. */
    motor: SaudeDoMotor;
    /** Remetente da plataforma (PLATFORM_*): unhealthy quando o .env está incompleto ou malformado. */
    emailPlataforma: HealthCheckResult;
    /**
     * RLS (camada 3): só existe com `DATABASE_URL_APP` (o app pelo papel `crmagro_app`). Confere que o pool do
     * papel conecta, que o papel é mesmo `crmagro_app`, que não ignora RLS e que não enxerga linha sem time
     * declarado. Sem este check, senha errada ou papel recusado pelo pooler deixavam o /api/health verde
     * enquanto todo `db()` falhava.
     */
    rls?: HealthCheckResult;
    /**
     * Cópia do backup para fora do servidor. Só aparece com
     * `BACKUP_FORA_VIGIAR=1`; desligado, o relatório é igual ao de antes.
     */
    backup?: HealthCheckResult;
  };
  timestamp: string;
  uptime_seconds: number;
}

/**
 * Verifica PostgreSQL com SELECT 1 e mede latência.
 */
export async function checkDatabase(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    await basePrisma.$queryRaw`SELECT 1`;
    return { status: "healthy", latency_ms: Date.now() - start };
  } catch (err) {
    return {
      status: "unhealthy",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Verifica o pool do papel `crmagro_app` (RLS, camada 3). Devolve `null` quando o RLS não está ligado
 * (sem `DATABASE_URL_APP`), e então o relatório não traz o check `rls`.
 */
export async function checkBancoApp(): Promise<HealthCheckResult | null> {
  const start = Date.now();
  const sonda = await sondarBancoApp();
  if (!sonda.ativo) return null;
  if (sonda.ok) return { status: "healthy", latency_ms: Date.now() - start };
  return { status: "unhealthy", latency_ms: Date.now() - start, error: `RLS: ${sonda.problema}` };
}

/**
 * Verifica Redis com PING e mede latência.
 * Cria uma conexão efêmera (não reusa o singleton do BullMQ para isolar).
 */
export async function checkRedis(): Promise<HealthCheckResult> {
  const start = Date.now();
  let redis: Redis | null = null;
  try {
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: false,
    });
    const pong = await redis.ping();
    redis.disconnect();
    if (pong !== "PONG") {
      return {
        status: "unhealthy",
        latency_ms: Date.now() - start,
        error: `Unexpected response: ${pong}`,
      };
    }
    return { status: "healthy", latency_ms: Date.now() - start };
  } catch (err) {
    if (redis) redis.disconnect();
    return {
      status: "unhealthy",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Instâncias que o health confere: as contas WhatsApp (Evolution) que o BANCO
 * diz estarem conectadas. Antes era só `env.EVOLUTION_INSTANCE` — fixa no .env
 * e fora de sincronia assim que o número é reconectado (instância nova): o
 * health acusava "evolution unhealthy" por uma instância que nem existia mais.
 * Sem conta conectada no banco (ou banco fora — o check do banco já acusa),
 * cai no env, como antes.
 */
async function instanciasParaConferir(): Promise<string[]> {
  try {
    const contas = await basePrisma.channelAccount.findMany({
      where: { provider: "evolution", canal: "whatsapp", status: "connected", externalId: { not: null } },
      select: { externalId: true },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    const nomes = [...new Set(contas.map((c) => c.externalId).filter((n): n is string => !!n))];
    if (nomes.length) return nomes;
  } catch {
    // Banco fora: o checkDatabase reporta; aqui segue com o env.
  }
  return [env.EVOLUTION_INSTANCE];
}

/**
 * Verifica a Evolution com UMA chamada `GET /instance/fetchInstances` e EXIGE
 * `connectionStatus === "open"` em cada instância conferida (item 1.6,
 * INT-04): responder 200 com a sessão caída não é saudável. O erro diz QUAL
 * instância está fora (fechada ou inexistente na Evolution).
 */
export async function checkEvolution(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const instancias = await instanciasParaConferir();
    const url = `${env.EVOLUTION_API_URL.replace(/\/$/, "")}/instance/fetchInstances`;
    // Mesmos cabeçalhos do envio: com CF_ACCESS_* (web na Vercel, Evolution atrás do Cloudflare
    // Access) vai também a chave do Access; sem ela o Access devolve 401 e o check mentia "fora".
    const resp = await fetch(url, {
      headers: evolutionHeaders(env.EVOLUTION_API_KEY),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      return {
        status: "unhealthy",
        latency_ms: Date.now() - start,
        error: `HTTP ${resp.status}`,
      };
    }
    const corpo = (await resp.json().catch(() => null)) as unknown;
    const lista = Array.isArray(corpo) ? (corpo as Array<{ name?: unknown; connectionStatus?: unknown }>) : [];
    const estados = new Map(
      lista
        .filter((i) => typeof i?.name === "string")
        .map((i) => [i.name as string, typeof i.connectionStatus === "string" ? i.connectionStatus : null]),
    );
    const fora = instancias
      .filter((nome) => estados.get(nome) !== "open")
      .map((nome) => `${nome}: ${estados.has(nome) ? (estados.get(nome) ?? "sem estado") : "não existe na Evolution"}`);
    if (fora.length) {
      return { status: "unhealthy", latency_ms: Date.now() - start, error: `instância ${fora.join("; ")}` };
    }
    return { status: "healthy", latency_ms: Date.now() - start };
  } catch (err) {
    return {
      status: "unhealthy",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/** Chave gravada pelo worker a cada 30s (expira em 90s) — ver apps/worker/src/index.ts. */
export const WORKER_HEARTBEAT_KEY = "crmagro:worker:heartbeat";

/**
 * Verifica se o WORKER (motor de fluxos, fila de IA, poll de e-mail) está vivo,
 * lendo o heartbeat que ele grava no Redis. Sem isso o health dizia "saudável"
 * com o motor parado há dias — o web sozinho não percebe.
 */
export async function checkWorker(): Promise<HealthCheckResult> {
  const start = Date.now();
  let redis: Redis | null = null;
  try {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    const beat = await redis.get(WORKER_HEARTBEAT_KEY);
    redis.disconnect();
    if (!beat) {
      return { status: "unhealthy", latency_ms: Date.now() - start, error: "sem heartbeat do worker (parado?)" };
    }
    return { status: "healthy", latency_ms: Date.now() - start };
  } catch (err) {
    if (redis) redis.disconnect();
    return {
      status: "unhealthy",
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Remetente da plataforma (reset de senha, convite, alerta). PLATFORM_* com
 * erro não derruba o boot: o envio é recusado, e é AQUI que a operação vê
 * (status `degraded`, que dispara o Web Push do alerta). Desligado (nenhuma
 * PLATFORM_*) é saudável: vale o legado. O erro traz só o NOME das variáveis.
 */
export function checkEmailPlataforma(): HealthCheckResult {
  const r = remetenteDaPlataforma(env);
  if (r.estado === "invalido") {
    return { status: "unhealthy", latency_ms: 0, error: `remetente da plataforma inválido: ${r.problemas.join("; ")}` };
  }
  return { status: "healthy", latency_ms: 0 };
}

/**
 * Executa todos os health checks em paralelo e agrega o resultado.
 *
 * - healthy: todos os checks healthy
 * - degraded: Evolution, worker, motor, remetente da plataforma ou (com
 *   BACKUP_FORA_VIGIAR=1) a cópia do backup para fora unhealthy (o site
 *   responde, mas WhatsApp, automação — fluxos, IA, e-mail — os e-mails de
 *   sistema ou o backup fora do servidor estão parados ou atrasados)
 * - unhealthy: DB ou Redis fora do ar (sistema indisponível), ou o pool do papel
 *   `crmagro_app` (RLS ligado) quebrado: todo `db()` falharia
 */
export async function runHealthChecks(): Promise<HealthReport> {
  const [database, redis, evolution, worker, motor, rls] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkEvolution(),
    checkWorker(),
    checkMotor(),
    checkBancoApp(),
  ]);
  const emailPlataforma = checkEmailPlataforma();
  // Leitura de arquivos de status (sem banco nem rede); null com BACKUP_FORA_VIGIAR desligado.
  const backup = await checkBackup();

  let status: HealthReport["status"] = "healthy";
  // RLS ligado e pool do papel quebrado = todo `db()` falha: para o app é o mesmo que banco fora.
  if (database.status === "unhealthy" || redis.status === "unhealthy" || rls?.status === "unhealthy") {
    status = "unhealthy";
  } else if (
    evolution.status === "unhealthy" ||
    worker.status === "unhealthy" ||
    motor.status === "unhealthy" ||
    emailPlataforma.status === "unhealthy" ||
    backup?.status === "unhealthy"
  ) {
    status = "degraded";
  }

  return {
    status,
    checks: { database, redis, evolution, worker, motor, emailPlataforma, ...(rls ? { rls } : {}), ...(backup ? { backup } : {}) },
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
  };
}
