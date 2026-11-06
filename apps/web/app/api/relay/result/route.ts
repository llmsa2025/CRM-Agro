import { runWithTeam } from "@crmagro/db";
import { aoRecusarJobAExtensao } from "@crmagro/core";
import { authenticate, unauthorized } from "../_auth";
import { deliverResult } from "../_store";
import type { RelayResult } from "../_types";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB — teto de exfiltração/memória

/** POST /api/relay/result — o agente devolve o resultado de um job. */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  let raw: Partial<RelayResult>;
  try {
    raw = (await req.json()) as Partial<RelayResult>;
  } catch {
    return Response.json({ error: "json inválido" }, { status: 400 });
  }
  if (!raw.jobId || typeof raw.ok !== "boolean") {
    return Response.json({ error: "jobId e ok obrigatórios" }, { status: 400 });
  }
  if (typeof raw.body === "string" && raw.body.length > MAX_BODY_BYTES) {
    raw.body = raw.body.slice(0, MAX_BODY_BYTES);
  }

  const result: RelayResult = {
    jobId: raw.jobId,
    ok: raw.ok,
    status: raw.status,
    headers: raw.headers,
    body: raw.body,
    error: raw.error,
  };
  // Só o time que PEGOU o job pode responder por ele (item 1.8).
  const delivered = await deliverResult(result, auth.teamId);
  // Leitura de seguidores devolvida com ERRO, sem lotes (extensão antiga que não conhece a tarefa, tarefa recusada):
  // fecha a busca com o motivo, em vez de deixar a tela em "Buscando..." até o servidor dar a busca por perdida.
  // Só age se o job for uma busca do Instagram deste token e ela ainda estiver andando.
  if (!result.ok && typeof result.error === "string") {
    await runWithTeam(auth.teamId, () => aoRecusarJobAExtensao(result.jobId, result.error!), {
      userId: auth.userId ?? undefined,
      role: auth.role ?? undefined,
    }).catch(() => undefined);
  }
  return Response.json({ ok: true, delivered });
}