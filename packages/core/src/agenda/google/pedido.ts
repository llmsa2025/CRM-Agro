import { db } from "@crmagro/db";
import { exigirAgendaGoogleLiberada, exigirConexaoPropria, PROVEDOR_GOOGLE } from "./conexao";
import { enfileirarSyncGoogle } from "./fila";

/**
 * "Sincronizar agora" da PRÓPRIA agenda: só enfileira (o worker sincroniza).
 * Quem não está na lista de liberados (A2) não pede: o worker não sincronizaria.
 */
export async function pedirSincronizacaoGoogle(): Promise<{ pedido: boolean }> {
  const ator = exigirConexaoPropria();
  await exigirAgendaGoogleLiberada();
  const c = await db().oAuthConnection.findFirst({
    where: { userId: ator.userId, provider: PROVEDOR_GOOGLE, status: "connected" },
    select: { id: true },
  });
  if (!c) return { pedido: false };
  await enfileirarSyncGoogle(c.id);
  return { pedido: true };
}
