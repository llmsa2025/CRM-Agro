import { agendaGoogleLiberadaParaMim, desconectarGoogle, googleAgendaConfigurada, minhaConexaoGoogle, podeConectarGoogle } from "@crmagro/core";
import { withTeam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Minha Agenda Google" no MENU DA CONTA (revisão do #169): a conexão é da
 * pessoa, e revogar o acesso tem de ser tão fácil quanto dar (LGPD). Por isso
 * esta rota não é de tela nenhuma — quem virou "só leitura" ou perdeu a Agenda
 * e as Integrações também desconecta daqui. O time e a pessoa vêm da SESSÃO;
 * o core só mexe na conexão da própria pessoa (userId = eu).
 *
 * GET    → { configurada, conexao, podeConectar, liberada } (sem token nenhum).
 *          `liberada` = a pessoa está em GOOGLE_AGENDA_LIBERADOS (A2): sem ela e
 *          sem conexão, o menu da conta nem mostra a Agenda Google.
 * DELETE → desconecta (revoga no Google e apaga a conexão)
 */
export async function GET() {
  return withTeam(async () => ({
    configurada: googleAgendaConfigurada(),
    conexao: googleAgendaConfigurada() ? await minhaConexaoGoogle() : null,
    podeConectar: podeConectarGoogle(),
    liberada: await agendaGoogleLiberadaParaMim().catch(() => false),
  }));
}

export async function DELETE() {
  return withTeam(async () => desconectarGoogle());
}
