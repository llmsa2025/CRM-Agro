import { basePrisma, runAsSystem } from "@crmagro/db";
import { enviarPush } from "../push/service";
import { logger } from "../logger/index";
import { DEFAULT_TZ, zonedParts } from "../motor-do-dia/tz";
import { LEMBRETE_MAX_MIN } from "./service";

/**
 * Lembrete da Agenda por Web Push (produto §E) — job `agenda-lembrete` do
 * worker PRIMÁRIO, a cada 1 min.
 *
 * - Vence quando `lembreteEm` (início − lembreteMin, calculado pelo trigger do
 *   banco) chega. Compromisso que começou há mais de 10 min não recebe
 *   lembrete atrasado (worker parado e voltando depois).
 * - Idempotente: antes de avisar, marca `lembreteEnviadoEm` com um
 *   `updateMany` condicional (só quem marcar primeiro avisa). Restart, rodada
 *   sobreposta e 2 workers não repetem o aviso. Remarcar o horário zera a marca
 *   (trigger) e o compromisso ganha lembrete novo.
 * - Vai para o RESPONSÁVEL; compromisso "do time" (sem responsável, criado
 *   pela automação) vai para owner/admin. Sempre no contexto do time do
 *   compromisso (`runAsSystem`): o push de um time nunca chega a outro.
 */

/** Compromisso que já começou há mais que isso não ganha lembrete atrasado. */
const TOLERANCIA_MS = 10 * 60_000;
/** Lembretes por rodada (o resto sai na rodada seguinte, 1 min depois). */
const POR_RODADA = 200;

const ROTULO: Record<string, string> = {
  visita: "Visita",
  reuniao: "Reunião",
  reuniao_online: "Reunião online",
  ligacao: "Ligação",
  follow_up: "Follow-up",
  tarefa: "Tarefa",
  outro: "Compromisso",
};

function hora(d: Date, timeZone: string): string {
  const p = zonedParts(d, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "em 30 min", "em 2 h", "agora". */
function faltam(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min <= 0) return "agora";
  if (min < 60) return `em ${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto ? `em ${h} h ${resto} min` : `em ${h} h`;
}

export async function enviarLembretesDaAgenda(agora: Date = new Date()): Promise<{ enviados: number }> {
  const now = agora.getTime();
  // Cruza times (job): basePrisma, com o teamId de cada linha em tudo que segue.
  const vencidos = await basePrisma.appointment.findMany({
    where: {
      status: "pendente",
      lembreteEnviadoEm: null,
      lembreteEm: { lte: agora },
      // Limite superior = maior antecedência possível: usa o índice (status, inicio).
      inicio: { gt: new Date(now - TOLERANCIA_MS), lte: new Date(now + LEMBRETE_MAX_MIN * 60_000) },
    },
    orderBy: { lembreteEm: "asc" },
    take: POR_RODADA,
    select: {
      id: true,
      teamId: true,
      titulo: true,
      tipo: true,
      inicio: true,
      local: true,
      reuniaoLink: true,
      responsavelId: true,
      contact: { select: { nome: true } },
    },
  });

  // Fuso do time (TeamConfig; MT/MS/RO/AM são UTC−4), lido uma vez por time na rodada.
  const fusos = new Map<string, string>();
  const fusoDoTime = async (teamId: string): Promise<string> => {
    let tz = fusos.get(teamId);
    if (!tz) {
      const cfg = await basePrisma.teamConfig.findUnique({ where: { teamId }, select: { timezone: true } });
      tz = cfg?.timezone || DEFAULT_TZ;
      fusos.set(teamId, tz);
    }
    return tz;
  };

  let enviados = 0;
  for (const a of vencidos) {
    // Trava de idempotência: só a rodada que marcar primeiro avisa.
    const { count } = await basePrisma.appointment.updateMany({
      where: { id: a.id, teamId: a.teamId, status: "pendente", lembreteEnviadoEm: null },
      data: { lembreteEnviadoEm: agora },
    });
    if (count !== 1) continue;
    const quando = `${faltam(a.inicio.getTime() - now)} (${hora(a.inicio, await fusoDoTime(a.teamId))})`;
    const corpo = [a.titulo, a.contact?.nome, a.local, a.reuniaoLink ? "Google Meet" : null].filter(Boolean).join(" · ");
    await runAsSystem(a.teamId, () =>
      enviarPush(a.responsavelId ? { userIds: [a.responsavelId] } : { papelMinimo: "admin" }, {
        titulo: `${ROTULO[a.tipo] ?? "Compromisso"} ${quando}`,
        corpo,
        url: "/agenda",
        tag: `agenda-${a.id}`,
      }),
    );
    enviados++;
  }
  if (enviados) logger.info({ enviados }, "[agenda] lembretes enviados");
  return { enviados };
}
