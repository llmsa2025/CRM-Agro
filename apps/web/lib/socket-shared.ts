import type { RealtimeEvent } from "@crmagro/core";

/**
 * Contrato compartilhado entre o Socket.IO server (`socket-server.ts`, Node) e o
 * client hook (`socket-client.ts`, browser). SEM imports de runtime Node — só
 * constantes e tipos —, pra que o cliente possa importar daqui sem arrastar
 * `socket.io`/`ioredis`/`next-auth` pro bundle do navegador.
 */

/** Path do endpoint Socket.IO (casado no server, no client e na rota-info). */
export const SOCKET_PATH = "/api/socket/io";

/** Eventos que o servidor emite → o cliente escuta. Um por `type` do RealtimeEvent. */
export interface ServerToClientEvents {
  "message:received": (event: Extract<RealtimeEvent, { type: "message:received" }>) => void;
  "message:sent": (event: Extract<RealtimeEvent, { type: "message:sent" }>) => void;
  "message:status": (event: Extract<RealtimeEvent, { type: "message:status" }>) => void;
  "dashboard:changed": (event: Extract<RealtimeEvent, { type: "dashboard:changed" }>) => void;
  "call:answered": (event: Extract<RealtimeEvent, { type: "call:answered" }>) => void;
  "call:ended": (event: Extract<RealtimeEvent, { type: "call:ended" }>) => void;
  "call:recording": (event: Extract<RealtimeEvent, { type: "call:recording" }>) => void;
  "call:transcription-completed": (event: Extract<RealtimeEvent, { type: "call:transcription-completed" }>) => void;
  // Conexão do WhatsApp (item 1.6): banner de "número desconectado" e QR ao vivo.
  "channel:disconnected": (event: Extract<RealtimeEvent, { type: "channel:disconnected" }>) => void;
  "channel:connected": (event: Extract<RealtimeEvent, { type: "channel:connected" }>) => void;
  "channel:qr": (event: Extract<RealtimeEvent, { type: "channel:qr" }>) => void;
  // Importação de contatos (produto §C): andamento a cada bloco e o resultado.
  "import:progress": (event: Extract<RealtimeEvent, { type: "import:progress" }>) => void;
  // Campanhas (produto §A.3): um tick mudou a campanha — a tela relê.
  "campaign:changed": (event: Extract<RealtimeEvent, { type: "campaign:changed" }>) => void;
}

/** O cliente não emite nada de negócio (só o protocolo interno do Socket.IO). */
export type ClientToServerEvents = Record<string, never>;

/** Dados presos ao socket após o handshake (lado servidor). */
export interface SocketData {
  teamId: string;
  /** Claims da sessão do handshake — revalidadas a cada minuto (auditoria do #52). */
  sessao: SessaoDoSocket;
}

export type SessaoDoSocket = {
  userId: string;
  teamId: string;
  role: unknown;
  /** Telas liberadas (F2b); vazio = todas as do papel. */
  modulos: string[];
  /** "Ver tudo" por tela (F3): nessas telas recebe os eventos de todos, como master/admin. */
  verTudoEm: string[];
  sessionVersion: unknown;
  /** Expiração do JWT (epoch em segundos), quando houver. */
  exp: number | null;
};
