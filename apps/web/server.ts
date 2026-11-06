import { createServer } from "node:http";
import next from "next";
import { conectarBancoApp } from "@crmagro/db";
import { initSocketServer } from "./lib/socket-server";

/**
 * Custom server do Next — necessário porque o Socket.IO precisa de um servidor
 * HTTP vivo (WebSocket + long-poll) que o App Router não expõe. Aqui criamos o
 * `http.Server`, deixamos o Next tratar as requisições HTTP normais e anexamos o
 * Socket.IO no mesmo servidor (mesma porta, path `/api/socket/io`).
 *
 * Onde roda: VPS / self-host (`pnpm --filter @crmagro/web start`), junto do worker,
 * Redis e Evolution. NÃO é usado na Vercel (serverless) — lá o `next start`
 * padrão sobe sem Socket.IO e o cliente degrada pro polling.
 *
 * Executado com `tsx` (igual ao worker), então roda o TS direto, resolvendo os
 * pacotes `@crmagro/*` source-only via os symlinks do pnpm.
 */

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error("[server] erro tratando requisição:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
  });

  initSocketServer(server);

  server.listen(port, hostname, () => {
    console.log(`[server] CRM Agro web pronto em http://${hostname}:${port} (dev=${dev})`);
    // RLS (camada 3): com DATABASE_URL_APP, confere o pool do papel crmagro_app e FALA ALTO se falhar (não
    // derruba o site; o /api/health acusa pelo check `rls`). Sem DATABASE_URL_APP, não faz nada.
    void conectarBancoApp("web");
  });
}

main().catch((err) => {
  console.error("[server] erro no boot:", err);
  process.exit(1);
});
