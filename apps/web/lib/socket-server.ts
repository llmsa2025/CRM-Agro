import { TELAS, temTela } from "./telas";
import type { Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import IORedis from "ioredis";
import { decode } from "next-auth/jwt";
import { env } from "@crmagro/config";
import {
  subscribeRealtime,
  getSessionState,
  sessionIsCurrent,
  SESSION_CHECK_MS,
  destinoDoEvento,
  moduloDeEscopoDaTela,
  veTudoNaTela,
  verTudoEmDoLegado,
  type RealtimeEvent,
} from "@crmagro/core";
import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SessaoDoSocket,
  type SocketData,
} from "./socket-shared";

const salaDaTela = (teamId: string, tela: string) => `team:${teamId}:tela:${tela}`;
// Escopo por dono (F3): dentro da tela, quem vê tudo e cada pessoa têm sala própria.
const salaDeQuemVeTudo = (teamId: string, tela: string) => `${salaDaTela(teamId, tela)}:tudo`;
const salaDaPessoa = (teamId: string, tela: string, userId: string) => `${salaDaTela(teamId, tela)}:u:${userId}`;

/**
 * Nesta tela, a pessoa recebe os eventos de todos? Master, administrador e
 * "ver tudo" NA TELA do registro (espelha o `escopoDoAtor` do core). Tela sem
 * registro com dono (Agenda, Configurações...) não tem evento por dono: sala
 * da pessoa, que nunca recebe nada de outro.
 */
const veTudo = (s: SessaoDoSocket, tela: string) => {
  const modulo = moduloDeEscopoDaTela(tela);
  return modulo ? veTudoNaTela(s.role, s.verTudoEm, modulo) : s.role === "owner" || s.role === "admin";
};

/**
 * Tela de cada evento em tempo real (F2b). Tipado com TODOS os tipos do
 * RealtimeEvent: evento novo sem tela quebra o typecheck (revisão do #150 —
 * `message:sent` escapava para o Painel, que é de todos).
 */
const TELAS_DO_EVENTO: Record<RealtimeEvent["type"], readonly string[]> = {
  "message:received": ["conversas"],
  "message:sent": ["conversas"],
  "message:status": ["conversas"],
  "dashboard:changed": ["painel"],
  "call:answered": ["ligacoes"],
  "call:ended": ["ligacoes"],
  "call:recording": ["ligacoes"],
  "call:transcription-completed": ["ligacoes"],
  "channel:disconnected": ["integracoes", "conversas"],
  "channel:connected": ["integracoes", "conversas"],
  "channel:qr": ["integracoes"],
  "campaign:changed": ["campanhas"],
  "import:progress": ["contatos"],
};

/**
 * Socket.IO server — o tempo real do CRM Agro, substituindo o SSE in-process.
 *
 * Onde roda: NÃO em serverless. Socket.IO precisa segurar o servidor HTTP vivo
 * (WebSocket + long-poll), o que o App Router não expõe. Por isso é anexado ao
 * **custom server** (`apps/web/server.ts`), que roda na VPS junto do worker e do
 * Redis. Na Vercel o custom server não é usado; lá o cliente degrada pro polling
 * (ver `socket-client.ts`).
 *
 * Como escala pra N processos: CADA instância assina o barramento Redis do core
 * (`subscribeRealtime`), então todas recebem todo evento. Por isso o reenvio é
 * `io.local.to(room)` — só pros sockets DESTA instância. Com `io.to(room)`, o
 * **Redis adapter** (`@socket.io/redis-adapter`) também replicava o emit para as
 * outras instâncias, que já tinham o evento pelo barramento: com N instâncias,
 * cada navegador recebia N cópias (auditoria DP-19). O adapter continua ligado
 * para operações entre instâncias (ex.: `fetchSockets`, emits fora do barramento).
 *
 * De onde vêm os eventos: o `subscribeRealtime` (barramento Redis do core) — um
 * evento publicado no worker OU no web cai aqui e é reemitido pra room do time.
 *
 * Multi-tenancy: no handshake validamos a sessão do NextAuth (JWT no cookie) e
 * pegamos o `teamId`; o socket entra só na room `team:<teamId>`. Um evento de um
 * time nunca chega ao navegador de outro. Sem sessão válida = conexão recusada.
 */

export type CrmAgroIOServer = IOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

// Singleton: evita reanexar o servidor no hot-reload do custom server em dev.
let io: CrmAgroIOServer | null = null;

/**
 * Lê o `teamId` da sessão do NextAuth a partir do cookie do handshake.
 *
 * NextAuth v5 usa JWT (sem tabela de sessão) assinado com `AUTH_SECRET`. O nome
 * do cookie muda com HTTPS (`__Secure-` prefix); o `salt` do decode é o próprio
 * nome do cookie, então tentamos as duas variantes. Sem cookie/JWT válido → null
 * (fail-closed: a conexão é recusada).
 */
async function resolveSessao(cookieHeader: string | undefined): Promise<SessaoDoSocket | null> {
  if (!cookieHeader) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const idx = c.indexOf("=");
      const name = c.slice(0, idx).trim();
      const value = c.slice(idx + 1).trim();
      return [name, decodeURIComponent(value)] as const;
    }),
  );

  // Cookie de sessão do NextAuth v5: seguro (HTTPS) tem prefixo `__Secure-`.
  const candidates = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

  for (const cookieName of candidates) {
    const token = cookies[cookieName];
    if (!token) continue;
    try {
      const payload = await decode({ token, secret: env.AUTH_SECRET, salt: cookieName });
      const teamId = payload?.teamId;
      if (typeof teamId === "string" && teamId) {
        // S12: sessão derrubada (senha/papel/remoção) não abre socket do time.
        const userId = payload?.userId;
        if (typeof userId !== "string" || !sessionIsCurrent(payload, await getSessionState(userId))) return null;
        return {
          userId,
          teamId,
          role: payload?.role,
          // Telas por pessoa (F2b): cada socket só entra nas salas das telas liberadas.
          modulos: Array.isArray(payload?.modulos) ? (payload.modulos as string[]) : [],
          // "Ver tudo" por tela; token de antes da troca traz o booleano (= todas).
          verTudoEm: verTudoEmDoLegado(payload?.verTudoEm, payload?.verTudo),
          sessionVersion: payload?.sessionVersion,
          exp: typeof payload?.exp === "number" ? payload.exp : null,
        };
      }
    } catch {
      // token inválido/expirado para esse salt — tenta a próxima variante.
    }
  }
  return null;
}

/**
 * Inicializa (uma vez) o Socket.IO server sobre o HTTP server do custom server.
 * Idempotente: chamadas repetidas devolvem a instância existente.
 */
export function initSocketServer(httpServer: HttpServer): CrmAgroIOServer {
  if (io) return io;

  io = new IOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    path: SOCKET_PATH,
    // Mesma origem (o Next serve o app e o socket) — sem CORS cross-site a abrir.
    serveClient: false,
  });

  // Redis adapter: espelha entre instâncias o que NÃO vem do barramento (os
  // eventos do barramento usam `io.local`, ver o reenvio abaixo).
  const pubClient = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const subClient = pubClient.duplicate();
  pubClient.on("error", (err) => {
    console.error("[socket] erro no pub do adapter:", err.message);
  });
  subClient.on("error", (err) => {
    console.error("[socket] erro no sub do adapter:", err.message);
  });
  io.adapter(createAdapter(pubClient, subClient));

  // Handshake: valida sessão e prende o teamId ao socket.
  io.use(async (socket, nextFn) => {
    try {
      const sessao = await resolveSessao(socket.handshake.headers.cookie);
      if (!sessao) {
        nextFn(new Error("unauthorized"));
        return;
      }
      socket.data.teamId = sessao.teamId;
      socket.data.sessao = sessao;
      nextFn();
    } catch (err) {
      nextFn(err instanceof Error ? err : new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    // Uma sala por tela (revisão do #150): quem não tem Conversas não recebe o
    // texto das mensagens, quem não tem Integrações não recebe o QR, etc.
    const s = socket.data.sessao;
    if (!s) return;
    const time = socket.data.teamId;
    for (const t of TELAS) {
      if (!temTela(typeof s.role === "string" ? s.role : null, s.modulos, t.id)) continue;
      // Eventos do time (ex.: Painel) + os do escopo: todos ou só os dele (F3).
      socket.join([salaDaTela(time, t.id), veTudo(s, t.id) ? salaDeQuemVeTudo(time, t.id) : salaDaPessoa(time, t.id, s.userId)]);
    }
  });

  // Barramento Redis → sockets: reemite cada evento nas salas das telas dele,
  // só nesta instância (as outras recebem pelo barramento — DP-19). Socket em
  // várias salas recebe uma vez só.
  subscribeRealtime(({ teamId, event }) => {
    // Sem mapa (não deveria: o tipo obriga) = não vai para ninguém.
    const telas = TELAS_DO_EVENTO[event.type as RealtimeEvent["type"]] ?? [];
    if (telas.length === 0) {
      console.warn(`[socket] evento sem tela no mapa — não emitido: ${event.type}`);
      return;
    }
    // F3: mensagem do número de um vendedor, a ligação dele, a campanha dele...
    // só para ele e para quem vê tudo. A ordem entre eventos do mesmo registro
    // se mantém (o destino é a mesma promessa em cache).
    void destinoDoEvento(teamId, event).then((destino) => {
      const salas = destino.time
        ? telas.map((t) => salaDaTela(teamId, t))
        : telas.flatMap((t) => [salaDeQuemVeTudo(teamId, t), ...(destino.dono ? [salaDaPessoa(teamId, t, destino.dono)] : [])]);
      io?.local.to(salas).emit(event.type, event as never);
    });
  });

  // Revalidação periódica (auditoria do #52): antes a sessão só era conferida ao
  // ABRIR o socket — quem era removido ou rebaixado com a aba aberta seguia
  // recebendo os eventos do time (prévia de mensagem, QR, status). A cada
  // minuto (o mesmo cache de 60 s do `getSessionState`), socket com sessão que
  // não bate mais com o banco, ou com o JWT vencido, é desconectado.
  const revalidar = setInterval(() => void revalidarSockets(), SESSION_CHECK_MS);
  revalidar.unref();

  console.log(`[socket] Socket.IO pronto em ${SOCKET_PATH} (Redis adapter ativo).`);
  return io;
}

let revalidando = false;
async function revalidarSockets(): Promise<void> {
  if (!io || revalidando) return;
  revalidando = true;
  try {
    const agoraS = Date.now() / 1000;
    const estados = new Map<string, Awaited<ReturnType<typeof getSessionState>>>();
    // Só os sockets DESTE processo (cada instância revalida os seus).
    for (const socket of io.of("/").sockets.values()) {
      const s = socket.data.sessao;
      if (!s) {
        socket.disconnect(true);
        continue;
      }
      if (s.exp !== null && s.exp < agoraS) {
        socket.disconnect(true);
        continue;
      }
      try {
        if (!estados.has(s.userId)) estados.set(s.userId, await getSessionState(s.userId));
        if (!sessionIsCurrent(s, estados.get(s.userId) ?? null)) socket.disconnect(true);
      } catch {
        // Banco/Redis fora: não derruba ninguém por falha de infra; tenta no próximo minuto.
      }
    }
  } finally {
    revalidando = false;
  }
}
