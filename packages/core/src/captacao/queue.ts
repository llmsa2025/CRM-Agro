import { Queue } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { env } from "@crmagro/config";
import { marcarCapturaAtiva } from "./andamento";
import { novoStatusCaptura, salvarStatusCaptura } from "./status";
import type { FiltrosDoJob } from "./busca-tipos";

/**
 * Fila de CAPTAÇÃO assíncrona (Maps e lote de CNPJ; o Instagram é LEGADO aqui) —
 * o scraping roda no worker (Playwright/sessão), leva minutos, então o web só
 * enfileira e a tela acompanha o status do lote (`statusDaCaptura`) e o
 * staging. Mesmo Redis do motor de fluxo. O job carrega o teamId (o worker abre
 * o contexto com runAsSystem).
 *
 * INSTAGRAM (LEGADO): a leitura de seguidores saiu do worker (IP de datacenter,
 * o Instagram respondia 429). Agora é feita pela extensão, no Chrome de quem
 * pediu (`instagram-extensao.ts`, tarefa `ig_followers`). O caso `instagram` do
 * `CaptureJob` e o coletor do worker continuam no código só para drenar jobs
 * antigos que já estavam na fila; `enqueueCapture` recusa novos, para nunca
 * haver retorno ao IP do servidor por descuido.
 */
export type CaptureJob = (
  | { origem: "maps"; teamId: string; lote: string; termo: string; limite: number }
  | { origem: "instagram"; teamId: string; lote: string; accountId: string; perfil: string; limite: number }
  // Item 3.2 (INT-13): lista grande de CNPJ sai da server action e vem para cá.
  | { origem: "cnpj"; modo?: "lista"; teamId: string; lote: string; cnpjs: string[] }
  // Aba "Por filtros": CNAE, cidade, porte etc. (a fonte pagina; os filtros finos são nossos).
  | {
      origem: "cnpj";
      modo: "filtro";
      teamId: string;
      lote: string;
      filtros: FiltrosDoJob;
      /** Máximo de empresas que passam nos filtros e entram na fila de revisão. */
      limite: number;
      /** "Buscar mais": de onde a busca anterior parou (cursor opaco da fonte + registros já lidos da página). */
      cursor?: string | null;
      saltar?: number;
      lidasAntes?: number;
      /** Completa e-mail e sócios consultando o CNPJ de cada empresa (mais lento). */
      completarContato: boolean;
      /** Busca por sócio: o motivo que a pessoa informou (fica no rascunho, para "de onde veio este dado?"). */
      motivo?: string | null;
      /** Checa "tem WhatsApp?" nos telefones (gasta a cota do dia do número). Desligado por padrão. */
      checarWhatsApp: boolean;
    }
) & {
  /** Quem pediu a captação (F3: a fila é por pessoa). Jobs antigos não têm. */
  ownerId?: string | null;
};

const CAPTURE_QUEUE = "capture";

let _conn: Redis | null = null;
let _queue: Queue | null = null;
function connection(): Redis {
  if (!_conn) _conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return _conn;
}
function queue(): Queue {
  if (!_queue) _queue = new Queue(CAPTURE_QUEUE, { connection: connection() });
  return _queue;
}

/** Tentaram pôr uma busca de seguidores do Instagram no worker (IP de datacenter). Isso não existe mais. */
export class CapturaInstagramSoPelaExtensao extends Error {
  constructor() {
    super("A leitura de seguidores do Instagram só roda pela extensão do CRM Agro, no navegador de quem pediu");
    this.name = "CapturaInstagramSoPelaExtensao";
  }
}

/** Total mostrado no andamento: itens da lista de CNPJ, ou o limite pedido nos demais. */
export function totalDoJob(job: CaptureJob): number {
  if (job.origem === "cnpj" && job.modo !== "filtro") return job.cnpjs.length;
  return job.limite;
}

export async function enqueueCapture(job: CaptureJob): Promise<void> {
  if (job.origem === "instagram") throw new CapturaInstagramSoPelaExtensao();
  // Status "na fila" ANTES do job existir: a tela já tem o que mostrar.
  await salvarStatusCaptura(
    job.teamId,
    novoStatusCaptura({
      lote: job.lote,
      origem: job.origem,
      estado: "na_fila",
      total: totalDoJob(job),
    }),
  );
  // A tela acha a busca pelo ponteiro (sobrevive a recarregar a página e a segunda aba).
  await marcarCapturaAtiva(job.teamId, job.origem, job.ownerId ?? null, job.lote);
  await queue().add("capture", job, {
    // Um job por LOTE: reenviar o mesmo lote não duplica a raspagem. (Clique
    // duplo gera dois lotes — cada clique cria o seu uuid na action; a tela
    // desabilita o botão enquanto enfileira.) BullMQ não aceita ":" no jobId.
    jobId: `captura_${job.lote}`,
    attempts: 1,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  });
}

export const CAPTURE_QUEUE_NAME = CAPTURE_QUEUE;
