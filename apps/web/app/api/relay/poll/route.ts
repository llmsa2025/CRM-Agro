import { runWithTeam } from "@crmagro/db";
import { aoEntregarJobAExtensao, tipoDeJobPermitido } from "@crmagro/core";
import { authenticate, unauthorized } from "../_auth";
import { waitForJob } from "../_store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const POLL_TIMEOUT_MS = 25_000;

/** GET /api/relay/poll?agentId=... — long-poll do próximo job para o time. */
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const agentId = new URL(req.url).searchParams.get("agentId");
  if (!agentId) return Response.json({ error: "agentId obrigatório" }, { status: 400 });

  const job = await waitForJob(auth.teamId, agentId, POLL_TIMEOUT_MS, auth.userId);
  if (!job) return Response.json({ job: null });

  // Catálogo fechado: tipo fora da lista nunca sai daqui (o hub também descarta).
  if (!tipoDeJobPermitido(job.type)) return Response.json({ job: null });

  // Leitura de seguidores do Instagram: só vai para a extensão da PESSOA que pediu a busca, e só
  // enquanto o lote está vivo. Marca o lote como "rodando" (a tela passa de "na fila" para "buscando").
  if (job.type === "ig_followers") {
    const entregar = await runWithTeam(auth.teamId, () => aoEntregarJobAExtensao(job), {
      userId: auth.userId ?? undefined,
      role: auth.role ?? undefined,
    }).catch(() => false);
    if (!entregar) return Response.json({ job: null });
  }
  return Response.json({ job });
}
