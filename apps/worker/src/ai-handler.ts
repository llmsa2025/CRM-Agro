import { runAsSystem, runWithTeam } from "@crmagro/db";
import {
  runAgent,
  publishAiChunk,
  conversaIaCancelada,
  logger,
  processarClassificacao,
  JOB_CLASSIFICAR_RESPOSTA,
  verTudoEmDoLegado,
  editarTudoEmDoLegado,
  type AiChatJob,
  type ClassificacaoJob,
} from "@crmagro/core";

/**
 * Consumidor da fila `ai`: roda o loop de tool-use do assistente NO WORKER
 * (fora do event loop do web) e publica cada trecho no canal Redis do stream,
 * que a rota /api/ai/chat repassa como SSE ao navegador.
 *
 * Tetos (item 3.5): a rodada respeita o prazo do job (`deadlineAt`, contado de
 * quando a tela pediu) e para quando a rota marca o cancelamento no Redis
 * (cliente saiu / SSE esgotou) — nenhuma tool de escrita roda depois disso.
 */
/** Identidade de quem pediu, com as listas por tela (job antigo sem elas = como era). */
function identidadeDoJob(j: Pick<AiChatJob, "userId" | "role" | "modulos" | "verTudoEm" | "editarTudoEm" | "verTudo">) {
  const ver = verTudoEmDoLegado(j.verTudoEm, j.verTudo);
  return { userId: j.userId, role: j.role, modulos: j.modulos ?? [], verTudoEm: ver, editarTudoEm: editarTudoEmDoLegado(j.editarTudoEm, ver) };
}

export async function handleAiJob(job: AiChatJob | ClassificacaoJob): Promise<void> {
  // Job de segundo plano na mesma fila (prioridade baixa): classificar a
  // resposta de campanha (produto §A.5). Roda como sistema do time; falha
  // transitória da IA é relançada para o retry do BullMQ (3×, exponencial).
  if ("kind" in job && job.kind === JOB_CLASSIFICAR_RESPOSTA) {
    const r = await runAsSystem(job.teamId, () => processarClassificacao(job));
    logger.info({ recipientId: job.recipientId, ...r }, "[ai] classificação de resposta de campanha");
    return;
  }
  const { streamId, teamId, messages, provider, userId, role, modulos, verTudoEm, editarTudoEm, verTudo, deadlineAt } = job as AiChatJob;
  try {
    // Ficou tempo demais na fila: a tela já desistiu — não gasta IA nem escreve.
    if (deadlineAt && Date.now() >= deadlineAt) {
      logger.warn({ streamId }, "[ai] job expirou na fila — descartado");
      await publishAiChunk(streamId, { type: "error", error: "o assistente demorou para começar, tente de novo" });
      return;
    }
    // Roda com a identidade de quem pediu: o papel decide se a IA pode escrever.
    const res = await runWithTeam(
      teamId,
      () =>
        runAgent(
          { messages, ...(provider ? { provider } : {}) },
          (t) => {
            void publishAiChunk(streamId, { type: "text", text: t });
          },
          {
            execId: streamId,
            ...(deadlineAt ? { deadlineAt } : {}),
            deveParar: () => conversaIaCancelada(teamId, streamId),
          },
        ),
      // "Ver tudo"/"editar" por tela; job de antes da troca traz o booleano (= todas)
      // e, sem a lista de edição, edita onde vê (como era).
      identidadeDoJob({ userId, role, modulos, verTudoEm, editarTudoEm, verTudo }),
    );
    await publishAiChunk(streamId, { type: "done", reply: res.reply, toolCalls: res.toolCalls });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error({ streamId, err: error }, "[ai] job falhou");
    await publishAiChunk(streamId, { type: "error", error });
  }
}
