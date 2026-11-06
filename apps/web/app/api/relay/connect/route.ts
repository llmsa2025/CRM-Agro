import { runWithTeam } from "@crmagro/db";
import { descreverDonoDoToken, resolverContasDoNavegador } from "@crmagro/core";
import { authenticate, unauthorized } from "../_auth";
import { touchAgent, registrarContasDoAgente } from "../_store";
import { RELAY_ALLOWLIST } from "../_types";

export const dynamic = "force-dynamic";

type ContaDoNavegador = { network: string; username: string };

/**
 * POST /api/relay/connect — registra/renova o agente (navegador do usuário).
 *
 * Item 1.8 (INT-08): a extensão manda as contas sociais logadas no navegador
 * (`contas: [{ network, username }]`, renovadas a cada 5 min). Só as que casam
 * com uma conta social DO TIME do token viram filas deste agente — um DM da
 * conta @vendedorA nunca é entregue à extensão do vendedor B.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  let body: { agentId?: string; contas?: unknown } = {};
  try {
    body = (await req.json()) as { agentId?: string; contas?: unknown };
  } catch {
    // corpo opcional
  }
  const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId.slice(0, 100) : crypto.randomUUID();

  let contas: string[] = [];
  if (Array.isArray(body.contas)) {
    const pedidas: ContaDoNavegador[] = body.contas
      .slice(0, 10)
      .filter((c): c is ContaDoNavegador => !!c && typeof c === "object" && typeof (c as ContaDoNavegador).network === "string" && typeof (c as ContaDoNavegador).username === "string")
      .map((c) => ({ network: c.network.slice(0, 20), username: c.username.slice(0, 120) }));
    contas = await runWithTeam(auth.teamId, () => resolverContasDoNavegador(pedidas), {
      userId: auth.userId ?? undefined,
      role: auth.role ?? undefined,
    });
    await registrarContasDoAgente(auth.teamId, agentId, contas, auth.userId);
  } else {
    await touchAgent(agentId, auth.teamId, auth.userId);
  }

  // De quem é o token: o popup da extensão mostra o nome (ele não tem sessão do
  // CRM Agro para conferir se é a pessoa certa). Falha aqui não derruba o connect.
  const usuario = await descreverDonoDoToken(auth.teamId, auth.userId).catch(() => ({ nome: null, time: null }));

  return Response.json({
    ok: true,
    agentId,
    teamId: auth.teamId,
    heartbeatMs: 20_000,
    allowlist: RELAY_ALLOWLIST,
    contas: contas.length,
    usuario,
  });
}
