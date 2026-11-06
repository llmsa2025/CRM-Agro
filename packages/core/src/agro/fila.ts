import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { logger } from "../logger/index";

/**
 * Fila `agro` (verificação do agro da base toda, em segundo plano). O botão "Verificar agro" com "Selecionar todos
 * do filtro" só grava o andamento no Redis e enfileira BLOCOS de contatos; o worker (processo primário, um bloco por
 * vez) faz o resto. Em duas rodadas, para o filtro por tipo encher rápido:
 *
 * 1. `cadastro`: nome e empresas (CNAE, sócios), sem rede. Prioridade alta, passa na frente das fotos;
 * 2. `foto`: pergunta à Evolution se o contato tem foto e a põe na fila do Claude (MCP crmagro-agro). Prioridade
 *    baixa, com respiro entre uma consulta e outra.
 */
export const AGRO_QUEUE = "agro";

export type FaseDoLoteAgro = "cadastro" | "foto";

export type BlocoAgro = {
  teamId: string;
  loteId: string;
  fase: FaseDoLoteAgro;
  /** Posição do bloco na fase (conta cada bloco uma vez só, mesmo se o job rodar de novo). */
  indice: number;
  ids: string[];
};

/** Tentativas do bloco (cada contato é idempotente, então repetir é seguro). */
export const AGRO_TENTATIVAS = 3;

let conexao: Redis | null = null;
let fila: Queue<BlocoAgro> | null = null;
function queue(): Queue<BlocoAgro> {
  if (!fila) {
    conexao = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    conexao.on("error", (err) => logger.warn({ err: err.message }, "[agro] erro na conexão Redis"));
    fila = new Queue<BlocoAgro>(AGRO_QUEUE, { connection: conexao });
  }
  return fila;
}

/** Blocos por chamada ao Redis: cada bloco leva ~8 KB de ids e o Upstash limita o tamanho de uma requisição. */
const BLOCOS_POR_CHAMADA = 25;

/** Enfileira os blocos de uma rodada. `jobId` sem ":" (o BullMQ recusa). Lança se a fila não aceitar. */
export async function enfileirarBlocosAgro(blocos: BlocoAgro[]): Promise<void> {
  for (let i = 0; i < blocos.length; i += BLOCOS_POR_CHAMADA) {
    await enfileirarFatia(blocos.slice(i, i + BLOCOS_POR_CHAMADA));
  }
}

async function enfileirarFatia(blocos: BlocoAgro[]): Promise<void> {
  await queue().addBulk(
    blocos.map((b) => ({
      name: b.fase,
      data: b,
      opts: {
        jobId: `agro_${b.loteId}_${b.fase}_${b.indice}`,
        // 1 = mais urgente. O cadastro (sem rede) passa na frente de qualquer foto.
        priority: b.fase === "cadastro" ? 1 : 10,
        attempts: AGRO_TENTATIVAS,
        backoff: { type: "exponential" as const, delay: 30_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    })),
  );
}
