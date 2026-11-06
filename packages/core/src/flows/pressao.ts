import { logger } from "../logger/index";

/**
 * Freio da inscrição em massa (incidente de 02/10/2026): jogar milhares de inscrições na fila `flow` de uma vez
 * (tag aplicada em muitos contatos, importação, "quem já tem a tag entra") enche a fila mais rápido do que o worker
 * consome, atrasa os outros times e faz o health `motor` acusar "fila atrasada". A inscrição entra em lotes pequenos,
 * com uma pausa curta entre eles, e, enquanto a fila `flow` tem passos pendentes demais, espera ela baixar.
 *
 * A espera tem ORÇAMENTO por chamada: a inscrição roda dentro de uma requisição (ativar, salvar, aplicar tag) e nunca
 * pode ficar pendurada. Estourou o orçamento, segue: a fila aguenta, quem dita o ritmo é o worker.
 */

/** Contatos inscritos por lote (uma consulta `IN`, um `createMany` e os agendamentos no Redis). */
export const LOTE_INSCRICAO = 100;
/** Agendamentos no Redis em paralelo dentro de um lote (não afoga a conexão). */
export const AGENDAR_EM_PARALELO = 25;
/** Pausa curta entre lotes: deixa o banco e o Redis respirarem. */
export const PAUSA_ENTRE_LOTES_MS = 50;
/** Fila `flow` com mais passos pendentes (esperando + em execução) que isto segura a inscrição. Ajustável por env. */
export const LIMITE_FILA_PENDENTE = Number(process.env.FLOW_ENROLL_FILA_MAX ?? 3000);
/** Quanto uma chamada espera, no total, a fila baixar. */
export const ORCAMENTO_DE_ESPERA_MS = Number(process.env.FLOW_ENROLL_ESPERA_MAX_MS ?? 20_000);
const INTERVALO_DA_CHECAGEM_MS = 500;

/** Passos pendentes na fila `flow` (esperando + em execução; os adiados por jitter ou espera não pressionam o worker). */
export async function pendentesDaFila(): Promise<number> {
  // Import dinâmico: o health puxa a fila de entrada de mensagens, que importa este módulo de volta pelos gatilhos.
  const { metricasDaFila } = await import("../health/motor");
  const m = await metricasDaFila("flow");
  return m.waiting + m.active;
}

export type OpcoesDoFreio = {
  /** Mede os passos pendentes (padrão: a fila `flow` de verdade). */
  medir?: () => Promise<number>;
  dormir?: (ms: number) => Promise<void>;
  limite?: number;
  orcamentoMs?: number;
};

/**
 * Freio de UMA inscrição em massa: chame `entreLotes()` ao fim de cada lote (menos o último). Pausa curta sempre; com a
 * fila acima do limite, espera ela baixar até acabar o orçamento. Erro ao medir (Redis fora) não segura nada.
 */
export function criarFreioDeInscricao(opts: OpcoesDoFreio = {}): { entreLotes: () => Promise<void>; esperouAteOFim: () => boolean } {
  const medir = opts.medir ?? pendentesDaFila;
  const dormir = opts.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limite = opts.limite ?? LIMITE_FILA_PENDENTE;
  let restanteMs = opts.orcamentoMs ?? ORCAMENTO_DE_ESPERA_MS;
  let estourou = false;
  return {
    esperouAteOFim: () => estourou,
    async entreLotes() {
      await dormir(PAUSA_ENTRE_LOTES_MS);
      while (restanteMs > 0) {
        let pendentes: number;
        try {
          pendentes = await medir();
        } catch {
          return;
        }
        if (pendentes <= limite) return;
        await dormir(INTERVALO_DA_CHECAGEM_MS);
        restanteMs -= INTERVALO_DA_CHECAGEM_MS;
        if (restanteMs <= 0 && !estourou) {
          estourou = true;
          logger.warn({ limite, pendentes }, "[flows] fila `flow` cheia: a inscrição em massa seguiu sem esperar mais (o worker dita o ritmo)");
        }
      }
    },
  };
}
