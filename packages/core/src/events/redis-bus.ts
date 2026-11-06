import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { getCurrentTeamId } from "@crmagro/db";
import { logger } from "../logger/index";

/**
 * Barramento de eventos CROSS-PROCESSO via Redis Pub/Sub.
 *
 * Por que existe: o barramento in-process (`conversations/events.ts`,
 * `EventEmitter`) só entrega dentro do MESMO processo. Web e worker são
 * processos separados — um evento emitido no worker (ex.: o motor processando
 * um passo `send_message`) nunca chegava ao inbox aberto no navegador.
 *
 * Aqui a publicação vai pro Redis; o Socket.IO server (apps/web, rodando no
 * custom server da VPS) assina o mesmo canal e reemite pros clientes conectados,
 * roteando por `teamId` (rooms). Assim o tempo real funciona com N processos.
 *
 * Multi-tenancy: cada envelope carrega o `teamId` (lido do AsyncLocalStorage no
 * momento da publicação). O Socket.IO usa isso pra emitir só na room do time —
 * um evento de um time NUNCA vaza pro navegador de outro.
 *
 * Robustez: publicar é BEST-EFFORT (fail-open). Se o Redis estiver inalcançável
 * (ex.: preview serverless na Vercel, sem Redis), a falha é engolida — tempo
 * real é notificação, não fonte de verdade; o estado real vem do banco no load
 * inicial e na reconciliação por polling. Isso difere da regra fail-CLOSED da
 * tenancy: lá, sem contexto = zero dados; aqui, sem Redis = sem push, só isso.
 */

/** Canal único de Pub/Sub. Todo evento de tempo real trafega por aqui. */
export const REALTIME_CHANNEL = "crmagro:realtime";

/** Mensagem de conversa espelhada no evento (subset do Message do Prisma). */
export type RealtimeMessage = {
  id: string;
  direcao: string;
  conteudo: string | null;
  createdAt: string;
};

/**
 * Evento de tempo real. Estruturalmente compatível com o `ConversationEvent`
 * in-process (mesmas variantes de mensagem), mais espaço pra crescer (deals,
 * atividades, ligações) sem quebrar os consumidores.
 */
export type RealtimeEvent =
  | {
      type: "message:received" | "message:sent";
      channelAccountId: string;
      conversationId: string;
      message: RealtimeMessage;
    }
  | {
      // Recibo de status (✓/✓✓): a tela atualiza o tique da mensagem ao vivo,
      // sem recarregar. Emitido por applyStatusUpdate ao receber MESSAGES_UPDATE.
      type: "message:status";
      channelAccountId: string;
      conversationId: string;
      messageId: string;
      status: string;
    }
  | {
      // Sinal genérico pro Painel: algo que mexe nos KPIs mudou (atividade,
      // deal, etapa). O cliente reage com um refetch — não precisa do payload.
      type: "dashboard:changed";
    }
  | {
      // Ciclo de vida de uma ligação (webhook da Voopi realimentado). `callId`
      // é o id da Call NO CRM Agro (UUID), não o providerCallId — o webhook roteia
      // via providerCallId mas publica com o id interno pro cliente (discador/
      // histórico) já enxergar. `dashboard:changed` também é publicado junto.
      type: "call:answered";
      callId: string;
      contactId: string;
      durationSeconds: number | null;
    }
  | {
      type: "call:ended";
      callId: string;
      contactId: string;
      durationSeconds: number | null;
    }
  | {
      type: "call:recording";
      callId: string;
      recordingUrl: string;
    }
  | {
      // Conexão do WhatsApp (item 1.6): caiu → banner "reconectar"; voltou →
      // some o banner. `channel:qr` leva o QR novo durante a (re)conexão.
      type: "channel:disconnected" | "channel:connected";
      channelAccountId: string;
      label: string;
    }
  | {
      type: "channel:qr";
      instance: string;
      qrBase64: string;
    }
  | {
      // Campanhas (produto §A.3): a tela "Em andamento" relê quando um tick
      // muda algo (envio, pulo, falha, freio, fim).
      type: "campaign:changed";
      campaignId: string;
      desfecho: string;
    }
  | {
      // Importação de contatos (produto §C): a tela do passo 4 mostra o
      // andamento ao vivo (a cada bloco) e o resultado final.
      type: "import:progress";
      importJobId: string;
      status: string;
      total: number;
      processadas: number;
      criadas: number;
      atualizadas: number;
      puladas: number;
      invalidas: number;
    }
  | {
      type: "call:transcription-completed";
      callId: string;
      contactId: string;
      transcript: string;
      /** null = sem IA conectada no time (ou a IA falhou): transcrição sem resumo. */
      summary: string | null;
    };

/** Envelope que trafega no Redis: o evento + o time dono dele. */
export type RealtimeEnvelope = {
  teamId: string;
  event: RealtimeEvent;
};

let publisher: Redis | null = null;

/** Conexão de publicação (singleton, lazy). Só cria quando o primeiro evento sai. */
function getPublisher(): Redis {
  if (!publisher) {
    publisher = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    publisher.on("error", (err) => {
      // Não deixa um Redis fora do ar derrubar o processo — só loga.
      
      logger.error({ err: err.message }, "[redis-bus] erro na conexão de publicação");
    });
  }
  return publisher;
}

/**
 * Publica um evento no barramento. `teamId` vem do contexto de tenancy (ALS) por
 * padrão — os serviços já rodam dentro de `runWithTeam`. Sem time no contexto e
 * sem override explícito, NÃO publica (não há room pra rotear).
 *
 * Best-effort: erro de Redis é logado e engolido, nunca propagado ao chamador.
 */
export function publishRealtime(event: RealtimeEvent, teamId?: string): void {
  const resolvedTeamId = teamId ?? getCurrentTeamId();
  if (!resolvedTeamId) {
    
    logger.warn({ eventType: event.type }, "[redis-bus] evento sem teamId no contexto — não publicado");
    return;
  }
  const envelope: RealtimeEnvelope = { teamId: resolvedTeamId, event };
  try {
    getPublisher()
      .publish(REALTIME_CHANNEL, JSON.stringify(envelope))
      .catch((err: unknown) => {
        
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "[redis-bus] falha ao publicar");
      });
  } catch (err) {
    
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[redis-bus] falha ao publicar");
  }
}

/**
 * Assina o barramento. Cria uma conexão DEDICADA (uma conexão em modo subscribe
 * não pode publicar — regra do Redis). Retorna função de unsubscribe que fecha a
 * conexão. Usado pelo Socket.IO server (um assinante por processo web).
 */
export function subscribeRealtime(handler: (envelope: RealtimeEnvelope) => void): () => void {
  const subscriber = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  subscriber.on("error", (err) => {
    
    logger.error({ err: err.message }, "[redis-bus] erro na conexão de assinatura");
  });

  subscriber.subscribe(REALTIME_CHANNEL).catch((err: unknown) => {
    
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[redis-bus] falha ao assinar");
  });

  subscriber.on("message", (channel, payload) => {
    if (channel !== REALTIME_CHANNEL) return;
    try {
      const envelope = JSON.parse(payload) as RealtimeEnvelope;
      handler(envelope);
    } catch (err) {
      
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "[redis-bus] payload inválido");
    }
  });

  return () => {
    void subscriber.quit();
  };
}
