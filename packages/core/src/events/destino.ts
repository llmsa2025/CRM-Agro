import { basePrisma } from "@crmagro/db";
import { logger } from "../logger/index";
import type { RealtimeEvent } from "./redis-bus";

/**
 * Para quem vai um evento em tempo real (F3, "cada um vê o seu"): o time
 * inteiro (quem tem a tela), ou só quem vê tudo (master, admin, "ver tudo")
 * mais o DONO do registro — a mensagem do número de um vendedor não aparece na
 * tela de outro. `dono: null` = só quem vê tudo.
 */
export type DestinoDoEvento = { time: true } | { time: false; dono: string | null };

/**
 * Cache curto por registro. Guarda a PROMESSA: dois eventos seguidos do mesmo
 * número esperam a mesma consulta e saem na ordem em que chegaram. Uma troca
 * de dono ("Transferir dono") vale para o tempo real em até 1 min.
 */
const CACHE_MS = 60_000;
const CACHE_MAX = 5_000;
const cache = new Map<string, { destino: Promise<DestinoDoEvento>; ate: number }>();

function lembrar(chave: string, buscar: () => Promise<DestinoDoEvento>): Promise<DestinoDoEvento> {
  const agora = Date.now();
  const ja = cache.get(chave);
  if (ja && ja.ate > agora) return ja.destino;
  if (cache.size >= CACHE_MAX) cache.clear();
  const destino = buscar().catch((err: unknown) => {
    // Banco fora: só quem vê tudo recebe (fail-closed) e não guarda o erro.
    cache.delete(chave);
    logger.warn({ chave, err: err instanceof Error ? err.message : String(err) }, "[tempo real] dono do evento não resolvido");
    return { time: false, dono: null } as DestinoDoEvento;
  });
  cache.set(chave, { destino, ate: agora + CACHE_MS });
  return destino;
}

const soDono = (dono: string | null | undefined): DestinoDoEvento => ({ time: false, dono: dono ?? null });

/** Resolve o destino de um evento do time `teamId` (toda consulta filtra o `teamId`). */
export function destinoDoEvento(teamId: string, event: RealtimeEvent): Promise<DestinoDoEvento> {
  switch (event.type) {
    case "dashboard:changed":
      // Só um sinal de "releia": o Painel relido já vem no escopo de cada um.
      return Promise.resolve({ time: true });
    case "message:received":
    case "message:sent":
    case "message:status":
    case "channel:connected":
    case "channel:disconnected": {
      const id = event.channelAccountId;
      return lembrar(`${teamId}:canal:${id}`, async () =>
        soDono((await basePrisma.channelAccount.findFirst({ where: { id, teamId }, select: { ownerId: true } }))?.ownerId),
      );
    }
    case "channel:qr": {
      const instance = event.instance;
      // Instância ainda sem conta (conectando): só quem vê tudo — nada na tela usa este evento hoje.
      return lembrar(`${teamId}:qr:${instance}`, async () =>
        soDono(
          (await basePrisma.channelAccount.findFirst({ where: { teamId, provider: "evolution", externalId: instance }, select: { ownerId: true } }))
            ?.ownerId,
        ),
      );
    }
    case "call:answered":
    case "call:ended":
    case "call:recording":
    case "call:transcription-completed": {
      const id = event.callId;
      return lembrar(`${teamId}:ligacao:${id}`, async () =>
        soDono((await basePrisma.call.findFirst({ where: { id, teamId }, select: { userId: true } }))?.userId),
      );
    }
    case "campaign:changed": {
      const id = event.campaignId;
      return lembrar(`${teamId}:campanha:${id}`, async () => {
        const c = await basePrisma.campaign.findFirst({ where: { id, teamId }, select: { createdById: true, compartilhado: true } });
        return c?.compartilhado ? { time: true } : soDono(c?.createdById);
      });
    }
    case "import:progress": {
      const id = event.importJobId;
      return lembrar(`${teamId}:importacao:${id}`, async () =>
        soDono((await basePrisma.importJob.findFirst({ where: { id, teamId }, select: { createdById: true } }))?.createdById),
      );
    }
    default: {
      // Evento novo sem regra aqui quebra o typecheck; em runtime, só quem vê tudo.
      const semRegra: never = event;
      void semRegra;
      return Promise.resolve({ time: false, dono: null });
    }
  }
}

/** Só para testes: esquece o cache. */
export function _limparDestinos(): void {
  cache.clear();
}
