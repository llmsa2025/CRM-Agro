import { mensagemParaTela } from "@/lib/erros";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  rateLimit,
  enqueueAiChat,
  subscribeAiStream,
  cancelarConversaIa,
  cortarHistorico,
  AI_AGENT_DEADLINE_MS,
} from "@crmagro/core";
import { auth } from "@/auth";

// Streaming (SSE) do assistente. O loop de tool-use NÃO roda mais aqui: o web
// ENFILEIRA um job na fila `ai` e o WORKER roda o agente, publicando cada trecho
// num canal Redis por streamId. Esta rota só ASSINA o canal e repassa como SSE —
// libera o event loop do web (antes uma conversa o segurava por até 8×60s).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Na Vercel a função morre no prazo do plano; o stream espera o worker por até STREAM_TIMEOUT_MS (180 s).
export const maxDuration = 300;

// Teto de chamadas de IA por time/minuto — protege a cota (paga) do provedor e a
// fila contra rajada/loop de retry. Ajustável por env.
const AI_RATE_PER_MIN = Number(process.env.AI_RATE_PER_MIN ?? 30);
// Guarda de segurança: se o worker não responder (parado/travado), encerra o SSE.
// Sempre acima do prazo do agente (150 s), para o resultado chegar à tela.
const STREAM_TIMEOUT_MS = Math.max(
  Number(process.env.AI_STREAM_TIMEOUT_MS ?? 180_000),
  AI_AGENT_DEADLINE_MS + 15_000,
);

// Borda (zod): o histórico vem do navegador. Teto generoso aqui; o corte de
// verdade (20 msgs / 30k chars) é o `cortarHistorico` logo abaixo.
const bodySchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(200_000) }))
    .min(1)
    .max(500),
  provider: z.enum(["anthropic", "glm"]).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  const teamId = session?.user?.teamId;
  if (!teamId) return new Response("unauthorized", { status: 401 });

  const rl = await rateLimit(`ai:${teamId}`, AI_RATE_PER_MIN, 60_000);
  if (!rl.allowed) {
    return new Response("rate_limited", {
      status: 429,
      headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("bad_request", { status: 400 });
  const body = parsed.data;
  const encoder = new TextEncoder();
  const streamId = randomUUID();
  // Prazo da rodada contado DAQUI (tempo na fila também conta).
  const deadlineAt = Date.now() + AI_AGENT_DEADLINE_MS;
  // Terminou com done/error? Então fechar a conexão não é cancelamento.
  let concluido = false;

  const stream = new ReadableStream({
    async start(controller) {
      let done = false;
      let unsubscribe: (() => Promise<void>) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = async () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (unsubscribe) await unsubscribe();
        try {
          controller.close();
        } catch {
          /* já fechado */
        }
      };
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller fechado */
        }
      };

      try {
        // ASSINA antes de enfileirar — senão perde os primeiros trechos.
        unsubscribe = await subscribeAiStream(streamId, (chunk) => {
          send(chunk);
          if (chunk.type === "done" || chunk.type === "error") {
            concluido = true;
            void finish();
          }
        });
        timer = setTimeout(() => {
          send({ type: "error", error: "tempo esgotado: o assistente não respondeu" });
          // A tela desistiu: o worker para antes da próxima tool (nada de escrita órfã).
          void cancelarConversaIa(teamId, streamId);
          void finish();
        }, STREAM_TIMEOUT_MS);
        await enqueueAiChat({
          streamId,
          teamId,
          // RBAC: o worker roda o agente com o papel de quem pediu (viewer = só leitura).
          userId: session.user.id,
          ...(session.user.role ? { role: session.user.role } : {}),
          // Telas por pessoa (F2b): sem isto o worker rodaria "com todas".
          modulos: session.user.modulos ?? [],
          verTudoEm: session.user.verTudoEm ?? [],
          editarTudoEm: session.user.editarTudoEm ?? [],
          messages: cortarHistorico(body.messages),
          ...(body.provider ? { provider: body.provider } : {}),
          deadlineAt,
        });
      } catch (e) {
        send({ type: "error", error: mensagemParaTela(e) });
        await finish();
      }
    },
    async cancel() {
      // Cliente desconectou (fechou a aba, parou): avisa o worker para parar
      // antes da próxima tool — antes ele seguia escrevendo sem ninguém ver.
      if (!concluido) await cancelarConversaIa(teamId, streamId);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
