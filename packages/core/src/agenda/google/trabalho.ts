import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { basePrisma } from "@crmagro/db";
import { logger } from "../../logger/index";
import { redisEstado } from "../../shared/redis-cache";
import { filtroDeConexoesLiberadas, googleAgendaConfigurada, processarRevogacoesPendentes, PROVEDOR_GOOGLE, pushDaAgendaHabilitado } from "./conexao";
import { enviarPendentesAoGoogle, erroSeguro } from "./envio";
import { enfileirarSyncGoogle, type JobAgendaGoogle } from "./fila";
import { sincronizarConexaoGoogle } from "./sincronizacao";

const DIA = 24 * 60 * 60_000;
/** Uma rodada de manutenção não passa disso (roda a cada minuto; não pode empilhar). */
const PRAZO_DA_RODADA_MS = 45_000;
const TRAVA_MANUTENCAO = "agenda:google:manutencao";
const SOLTAR_SE_MINHA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Rodada de manutenção (a cada minuto, fila `agenda-google`):
 * - agenda a sincronização das agendas vencidas (polling de reserva com
 *   sorteio, espera depois de erro) e das com canal de push perto de vencer —
 *   estas só com o push ligado, sem erro pendente e fora da espera do canal
 *   (senão viraria polling de 1 minuto e estouraria a cota do projeto);
 * - reenvia ao Google o que ficou pendente;
 * - só de quem está liberado (`GOOGLE_AGENDA_LIBERADOS`, A2): a agenda de quem
 *   saiu da lista fica parada, sem apagar nada;
 * - tenta de novo as revogações que o Google não confirmou (não precisa do
 *   cliente OAuth: roda mesmo se as variáveis saírem do .env).
 * `prazo`: a rodada para ali (o que sobrar fica para o próximo minuto).
 */
export async function manutencaoAgendaGoogle(agora = new Date(), prazo = Date.now() + PRAZO_DA_RODADA_MS): Promise<{ sincronizacoes: number; enviados: number }> {
  await processarRevogacoesPendentes(agora, prazo).catch((e) =>
    logger.warn({ err: erroSeguro(e) }, "[agenda-google] falha na fila de revogação"),
  );
  if (!googleAgendaConfigurada()) return { sincronizacoes: 0, enviados: 0 };
  const vencidas: Prisma.CalendarSyncWhereInput[] = [{ proximaSincronizacaoEm: null }, { proximaSincronizacaoEm: { lte: agora } }];
  if (pushDaAgendaHabilitado()) {
    vencidas.push({
      canalId: { not: null },
      canalExpiraEm: { lte: new Date(agora.getTime() + DIA) },
      falhas: 0,
      OR: [{ canalTentarEm: null }, { canalTentarEm: { lte: agora } }],
    });
  }
  const lista = await basePrisma.calendarSync.findMany({
    where: {
      // A2: só as agendas de quem está em GOOGLE_AGENDA_LIBERADOS (as demais ficam
      // paradas, sem ocupar as 200 vagas da rodada; a sincronização também confere).
      connection: { provider: PROVEDOR_GOOGLE, status: "connected", user: { desativadoEm: null, role: { not: "viewer" } }, AND: [filtroDeConexoesLiberadas()] },
      OR: vencidas,
    },
    orderBy: { proximaSincronizacaoEm: "asc" },
    take: 200,
    select: { connectionId: true },
  });
  for (const s of lista) await enfileirarSyncGoogle(s.connectionId);
  const { enviados } = await enviarPendentesAoGoogle(agora, prazo);
  return { sincronizacoes: lista.length, enviados };
}

/**
 * Manutenção com trava no Redis: o job scheduler do BullMQ cria a próxima
 * rodada quando a atual COMEÇA — com o Google lento, duas rodadas juntas
 * leriam os mesmos pendentes (convite em dobro) e ocupariam as duas vagas da
 * fila. Sem a trava, a rodada é pulada (a próxima vem em 1 minuto).
 */
async function manutencaoComTrava(): Promise<{ sincronizacoes: number; enviados: number } | null> {
  const token = randomUUID();
  try {
    if ((await redisEstado().set(TRAVA_MANUTENCAO, token, "EX", 120, "NX")) !== "OK") return null;
  } catch {
    return null;
  }
  try {
    return await manutencaoAgendaGoogle();
  } finally {
    await redisEstado()
      .eval(SOLTAR_SE_MINHA, 1, TRAVA_MANUTENCAO, token)
      .catch(() => {});
  }
}

/** Processa um job da fila `agenda-google` (o worker só registra isto). */
export async function processarJobAgendaGoogle(job: JobAgendaGoogle): Promise<void> {
  if (job.tipo === "manutencao") {
    const r = await manutencaoComTrava();
    if (r?.enviados) logger.info({ ...r }, "[agenda-google] manutenção");
    return;
  }
  const r = await sincronizarConexaoGoogle(job.connectionId);
  // Outra rodada já está nesta agenda: tenta de novo daqui a pouco (o aviso não se perde).
  if (!r.ok && r.pulou === "travada") await enfileirarSyncGoogle(job.connectionId, { atrasoMs: 20_000 });
  if (r.ok && (r.compromissos || r.atualizados || r.cancelados)) {
    logger.info({ connectionId: job.connectionId, completa: r.completa, compromissos: r.compromissos, atualizados: r.atualizados, cancelados: r.cancelados }, "[agenda-google] sincronizada");
  }
}
