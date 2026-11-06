import { NextResponse } from "next/server";
import { SOCKET_PATH } from "@/lib/socket-shared";

/**
 * Rota-INFO do Socket.IO — NÃO inicializa o servidor.
 *
 * Por que não inicializa aqui: no App Router, um route handler não tem acesso ao
 * `http.Server` subjacente (diferente do velho Pages API, onde dava pra pegar
 * `res.socket.server`). O Socket.IO precisa desse servidor pra anexar o upgrade
 * de WebSocket. Por isso o servidor é inicializado no **custom server**
 * (`apps/web/server.ts`, via `initSocketServer`), que roda na VPS.
 *
 * O tráfego real do Socket.IO (handshake, WebSocket, long-poll) chega neste mesmo
 * `path` (`/api/socket/io`) mas é interceptado pelo Socket.IO ANTES do Next — o
 * engine trata a requisição no `http.Server`. Este handler só responde a um GET
 * simples de diagnóstico (checar se o app está no ar e qual o path esperado).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    transport: "socket.io",
    path: SOCKET_PATH,
    note:
      "Socket.IO é servido pelo custom server (apps/web/server.ts) na VPS. " +
      "Em serverless (Vercel) não há WebSocket; o cliente degrada pro polling.",
  });
}
