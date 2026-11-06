"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "./socket-shared";

/**
 * Hook de tempo real do cliente — conecta ao Socket.IO server (custom server na
 * VPS) e entrega os eventos do time ao componente. Substitui o `EventSource`
 * (SSE) do inbox.
 *
 * Reconexão: automática (padrão do socket.io-client) — WebSocket cai, ele volta
 * sozinho com backoff. O `connected` acompanha o estado pra UI decidir o ritmo
 * do polling de reconciliação (rápido quando desconectado, lento quando de pé).
 *
 * Uma conexão por hook, criada UMA vez: os handlers vivem num ref, então mudar
 * de handler (ex.: trocar a conta selecionada) NÃO derruba nem recria o socket.
 *
 * Degradação: na Vercel (sem custom server) a conexão nunca abre; `connected`
 * fica `false` e o polling do componente assume. Nada quebra.
 */

export type SocketEventHandlers = Partial<ServerToClientEvents>;

type CrmAgroClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function useSocket(handlers: SocketEventHandlers): { connected: boolean } {
  const [connected, setConnected] = useState(false);

  // Handlers num ref: o effect roda uma vez só; trocar handler não reconecta.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const socket: CrmAgroClientSocket = io({
      path: SOCKET_PATH,
      withCredentials: true, // manda o cookie de sessão pro handshake autenticar
      // Reconexão é o default; explicitado pra deixar a intenção clara.
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));

    socket.on("message:received", (e) => handlersRef.current["message:received"]?.(e));
    socket.on("message:sent", (e) => handlersRef.current["message:sent"]?.(e));
    socket.on("dashboard:changed", (e) => handlersRef.current["dashboard:changed"]?.(e));

    return () => {
      socket.disconnect();
    };
  }, []);

  return { connected };
}
