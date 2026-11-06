import { randomUUID } from "node:crypto";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { publishRealtime } from "../events/redis-bus";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { agendarTick, getCampaignQueue, type CampaignJob } from "./queue";

/**
 * Campanha "enviando" (ou agendada) sem nenhum tick vivo (auditoria do #125):
 * se um tick esgota as tentativas (Redis/banco fora por um tempo), a corrente
 * acaba e a campanha fica parada para sempre, sem enviar e sem aviso — só um
 * log de erro. A varredura (worker primário, 5 min) acha essas campanhas e
 * rearma com uma corrente NOVA: gira o `tickToken` (condicional ao token velho)
 * e agenda o seq 0 do token novo. Girar é o que garante "uma corrente de cada
 * vez" (auditoria do #127): se a varredura cair entre o commit e o `add` de um
 * início/retomada, o tick do token velho que chega depois sai como
 * `corrente_morta` — com o mesmo token seriam DUAS correntes, e a pausa de lote
 * e o intervalo do controle de ritmo deixariam de valer. O tick confere token, janela,
 * ritmo e travas: rearmar não fura o controle de ritmo. Rearmou mais de 3× em 1 h: a
 * falha é persistente → pausa com motivo visível em vez de girar em falha.
 */

const VIVOS = ["waiting", "delayed", "active", "prioritized", "waiting-children"] as const;
// Agendada também: se o 1º tick esgota as tentativas antes de virar "sending",
// ela ficaria "agendada" para sempre. A agendada normal tem o tick atrasado vivo.
const EM_CURSO = ["sending", "scheduled"] as const;
const MAX_REARMES_POR_HORA = 3;
export const MOTIVO_PARADA_REPETIDA = "envio parado por falhas repetidas. Verifique a conexão e retome";

type FilaDeCampanha = { getJobs: (tipos: readonly string[], inicio: number, fim: number) => Promise<Array<{ data: CampaignJob } | undefined>> };

export async function varrerCampanhasParadas(
  opts: { fila?: FilaDeCampanha } = {},
): Promise<{ rearmadas: number; pausadas: number }> {
  const fila = opts.fila ?? (getCampaignQueue() as unknown as FilaDeCampanha);
  // Cross-team de propósito (varredura da plataforma); cada escrita roda no time.
  const ativas = await basePrisma.campaign.findMany({
    where: { status: { in: [...EM_CURSO] }, tickToken: { not: null } },
    select: { id: true, teamId: true, tickToken: true },
    // As mais antigas primeiro: passando de 500, nenhuma fica de fora sempre.
    orderBy: { updatedAt: "asc" },
    take: 500,
  });
  if (ativas.length === 0) return { rearmadas: 0, pausadas: 0 };

  const vivos = new Set<string>();
  for (const job of await fila.getJobs([...VIVOS], 0, 5000)) {
    if (job?.data.kind === "tick") vivos.add(`${job.data.campaignId}:${job.data.token}`);
  }

  let rearmadas = 0;
  let pausadas = 0;
  for (const c of ativas) {
    if (vivos.has(`${c.id}:${c.tickToken}`)) continue;
    const chave = `campanha:rearme:${c.id}`;
    const [[, vezes]] = (await redisEstado().multi().incr(chave).expire(chave, 3600, "NX").exec()) as [[unknown, number], unknown];
    if (vezes > MAX_REARMES_POR_HORA) {
      const { count } = await runAsSystem(c.teamId, () =>
        basePrisma.campaign.updateMany({
          where: { id: c.id, teamId: c.teamId, tickToken: c.tickToken, status: { in: [...EM_CURSO] } },
          data: { status: "paused", pausadoMotivo: MOTIVO_PARADA_REPETIDA, tickToken: null },
        }),
      );
      if (count) {
        pausadas++;
        // A tela "Em andamento" relê na hora, como nos outros freios.
        publishRealtime({ type: "campaign:changed", campaignId: c.id, desfecho: "freio" }, c.teamId);
        logger.error({ campaignId: c.id, teamId: c.teamId }, "[campanha] parada de novo — pausada com motivo visível");
      }
      continue;
    }
    // Gira o token só se ninguém mexeu (pausar/retomar/cancelar no meio → 0).
    const novo = randomUUID();
    const { count } = await runAsSystem(c.teamId, () =>
      basePrisma.campaign.updateMany({
        where: { id: c.id, teamId: c.teamId, tickToken: c.tickToken, status: { in: [...EM_CURSO] } },
        data: { tickToken: novo },
      }),
    );
    if (!count) continue;
    // Se o `add` falhar (Redis fora), a campanha fica com o token novo e sem
    // tick — a próxima rodada vê de novo e conta mais um rearme.
    await agendarTick({ teamId: c.teamId, campaignId: c.id, token: novo, seq: 0, delayMs: 0 });
    rearmadas++;
    logger.warn({ campaignId: c.id, teamId: c.teamId }, "[campanha] enviando sem tick vivo — corrente rearmada");
  }
  return { rearmadas, pausadas };
}
