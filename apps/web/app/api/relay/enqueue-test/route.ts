import { authenticate, unauthorized } from "../_auth";
import { awaitResult, onlineAgentsForTeam, pushJob } from "../_store";
import { isUrlAllowed, type RelayJob } from "../_types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RESULT_TIMEOUT_MS = 27_000;

/**
 * POST /api/relay/enqueue-test — VERIFICAÇÃO DO MVP. Simula o que o worker fará:
 * enfileira um http_fetch e aguarda o resultado do agente (o navegador do usuário
 * executa pelo IP residencial). Em produção quem enfileira é o capture-handler.
 */
export async function POST(req: Request): Promise<Response> {
  // Só para teste de bancada. Em produção fica desligada: com qualquer token do
  // time, dava para mandar o navegador de OUTRO usuário do time buscar uma página
  // com a sessão dele e ler o começo da resposta. Liga com RELAY_ENQUEUE_TEST=1.
  if (process.env.NODE_ENV === "production" && process.env.RELAY_ENQUEUE_TEST !== "1") {
    return Response.json({ error: "desativado" }, { status: 404 });
  }
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  let body: { url?: string } = {};
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return Response.json({ error: "json inválido" }, { status: 400 });
  }
  const url = body.url;
  if (!url) return Response.json({ error: "url obrigatória" }, { status: 400 });
  if (!isUrlAllowed(url)) {
    return Response.json({ ok: false, error: "domain_not_allowed" }, { status: 400 });
  }
  if ((await onlineAgentsForTeam(auth.teamId)) === 0) {
    return Response.json({ ok: false, error: "no_agent_online" }, { status: 409 });
  }

  const job: RelayJob = {
    id: crypto.randomUUID(),
    teamId: auth.teamId,
    type: "http_fetch",
    spec: { url, method: "GET", timeoutMs: 20_000 },
    createdAt: Date.now(),
  };
  await pushJob(job);
  const result = await awaitResult(job.id, RESULT_TIMEOUT_MS);

  return Response.json({
    jobId: job.id,
    ok: result.ok,
    status: result.status,
    error: result.error,
    bodyPreview: result.body?.slice(0, 2000),
    bodyLength: result.body?.length ?? 0,
  });
}