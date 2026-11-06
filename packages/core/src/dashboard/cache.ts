import { logger } from "../logger/index";
import { redisCache } from "../shared/redis-cache";

/**
 * Cache do Painel (item 2.3, DP-07). Os números do Painel (contagens de
 * prospecção/respostas/contatos e o gráfico de 7 dias) ficam 30 s no Redis por
 * time: `dash:<teamId>:<bloco>`. Sem Redis, calcula direto (é cache, fail-open).
 *
 * Invalidação por GERAÇÃO em vez de só `DEL`: `invalidarPainel` sobe o contador
 * `dash:<teamId>:ger`, e o bloco guardado carrega a geração com que nasceu. Um
 * cálculo que começou ANTES da mensagem nova e terminou DEPOIS da invalidação
 * grava com a geração velha — a próxima leitura vê a diferença e recalcula (com
 * `DEL` puro, esse cálculo atrasado recolocaria o número velho por 30 s).
 *
 * O bloco também carrega o dia-calendário do time: virou o dia, o "hoje" do
 * cache antigo não vale mais, mesmo dentro dos 30 s.
 */

export const PAINEL_CACHE_TTL_S = 30;
/** A geração só precisa viver mais que o bloco (30 s); 1 dia sobra. */
const GERACAO_TTL_S = 86_400;

export type BlocoPainel = "contagens" | "dias";

const chaveGeracao = (teamId: string) => `dash:${teamId}:ger`;
// Escopo por dono (F3): cada pessoa tem os seus números — a chave leva o
// escopo ("tudo" ou o userId). A geração continua por time: invalidar zera todos.
const chaveBloco = (teamId: string, bloco: BlocoPainel, escopo: string) => `dash:${teamId}:${bloco}:${escopo}`;

type Guardado<T> = { ger: string; dia: string; valor: T };

/**
 * Cálculos em andamento neste processo. O Painel chama `prospeccaoResumo`,
 * `prospeccaoPorCanal` e `taxas` em paralelo: sem isto, os três perderiam o
 * cache juntos e fariam a mesma consulta três vezes.
 */
const emAndamento = new Map<string, Promise<unknown>>();

/**
 * Devolve o bloco do cache (mesma geração e mesmo dia) ou calcula, guarda e
 * devolve. `teamId` vem do contexto do serviço (nunca do cliente).
 */
export async function lerOuCalcularPainel<T>(
  teamId: string,
  bloco: BlocoPainel,
  dia: string,
  calcular: () => Promise<T>,
  /** "tudo" ou o userId (F3) — obrigatório: esquecer o escopo misturaria os números de pessoas. */
  escopo: string,
): Promise<T> {
  const chave = chaveBloco(teamId, bloco, escopo);
  let ger = "0";
  let comRedis = true;
  try {
    const [g, bruto] = await redisCache().mget(chaveGeracao(teamId), chave);
    ger = g ?? "0";
    if (bruto) {
      const guardado = JSON.parse(bruto) as Guardado<T>;
      if (guardado.ger === ger && guardado.dia === dia) return guardado.valor;
    }
  } catch {
    comRedis = false; // sem Redis: calcula direto, sem guardar
  }

  const chaveVoo = `${chave}:${ger}:${dia}`;
  const emVoo = emAndamento.get(chaveVoo) as Promise<T> | undefined;
  if (emVoo) return emVoo;

  const calculo = (async () => {
    const valor = await calcular();
    if (comRedis) {
      const guardado: Guardado<T> = { ger, dia, valor };
      try {
        await redisCache().set(chave, JSON.stringify(guardado), "EX", PAINEL_CACHE_TTL_S);
      } catch {
        /* cache é opcional */
      }
    }
    return valor;
  })();
  emAndamento.set(chaveVoo, calculo);
  try {
    return await calculo;
  } finally {
    emAndamento.delete(chaveVoo);
  }
}

/**
 * Invalida os números do Painel do time (chamado a cada mensagem que entra ou
 * sai — `emitConversationEvent`). Best-effort: nunca lança; sem Redis, o bloco
 * expira sozinho em 30 s.
 */
export async function invalidarPainel(teamId: string): Promise<void> {
  try {
    await redisCache()
      .multi()
      .incr(chaveGeracao(teamId))
      .expire(chaveGeracao(teamId), GERACAO_TTL_S)
      .exec();
  } catch (err) {
    logger.debug(
      { teamId, err: err instanceof Error ? err.message : String(err) },
      "[painel] cache não invalidado (Redis indisponível) — expira em 30 s",
    );
  }
}
