import { db, runAsSystem } from "@crmagro/db";
import {
  CnpjInvalid,
  InstagramLimite,
  InstagramPerfilNaoEncontrado,
  InstagramSessaoInvalida,
} from "@crmagro/captation";
import { logger } from "../logger/index";
import { insertDrafts, type DraftInput } from "./service";
import { totalDoJob, type CaptureJob } from "./queue";
import type { ContinuacaoDaBusca } from "./busca-tipos";
import { consultarCnpjDetalhado, draftDoCnpj, motivoFalhaCnpj } from "./cnpj";
import { marcarTemWhatsAppDoLote } from "./extras";
import {
  lerStatusCaptura,
  mensagemDaCaptura,
  novoStatusCaptura,
  salvarStatusCaptura,
  type EstadoCaptura,
  type MotivoCaptura,
  type StatusCaptura,
} from "./status";

/**
 * Execução de um job da fila `capture` (item 3.2, INT-11/12/13) — a parte que
 * não depende de Playwright, para ser testável. O worker só entrega o COLETOR
 * (scraping do Maps, paginação do Instagram, lote de CNPJ) e isto cuida de:
 * - gravar os rascunhos AOS POUCOS (`ctx.gravar`) no time do job;
 * - manter o status visível (`captacao:status:<teamId>:<lote>`);
 * - distinguir "vazio" de "concluído" e "parcial" de "falhou";
 * - falhar o job (visível no BullMQ e no log) quando nada veio ou o Google
 *   bloqueou;
 * - NÃO raspar de novo um job devolvido à fila depois de uma queda do worker;
 * - marcar "tem WhatsApp?" nos rascunhos com telefone (produto §H.2) ANTES do
 *   status final: quando a tela vê "concluída", a marca já está na fila.
 */

/** Uma captura que termina com falha visível (o job do BullMQ fica `failed`). */
export class CapturaFalhou extends Error {
  constructor(
    public readonly motivo: MotivoCaptura,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CapturaFalhou";
  }
}

export type ContextoColeta = {
  /** Grava um bloco de rascunhos no time do job; devolve quantos entraram. */
  gravar: (itens: DraftInput[]) => Promise<number>;
  /** Progresso: quantos itens foram LIDOS até agora (gravados ou não). */
  progresso: (lidos: number) => void;
  /** Um item que não deu (CNPJ inválido/não encontrado…) — conta e guarda amostra. */
  falha: (item: string, motivo: string) => void;
  /** Busca por filtro: onde parou (para "Buscar mais"); null = chegou ao fim da fonte. */
  continuacao: (c: ContinuacaoDaBusca | null) => void;
};

export type ResultadoColeta = {
  /** Parou no meio de forma controlada (o que veio já foi gravado). */
  interrupcao: { motivo: MotivoCaptura; detalhe?: string } | null;
  /** Busca por filtro: a fonte acabou ANTES de juntar a quantidade pedida (o que veio é tudo o que ela tinha). */
  fonteEsgotada?: boolean;
};

export type Coletor = (ctx: ContextoColeta) => Promise<ResultadoColeta>;

const FINAIS: EstadoCaptura[] = ["concluida", "vazia", "parcial", "falhou", "interrompida"];
const AMOSTRA_FALHAS = 20;

/**
 * A checagem de "tem WhatsApp?" roda sozinha em todo lote com telefone, MENOS na busca
 * por filtro, onde fica desligada até a pessoa pedir (ela gasta a cota diária do número e,
 * em lista grande, aproxima o número de um bloqueio).
 */
function deveChecarWhatsApp(job: CaptureJob): boolean {
  return !(job.origem === "cnpj" && job.modo === "filtro" && !job.checarWhatsApp);
}

/** Erro do coletor → motivo visível. Só a 1ª linha: o Playwright anexa o "Call log" inteiro. */
function motivoDoErro(e: unknown): { motivo: MotivoCaptura; detalhe: string } {
  const detalhe = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.trim();
  if (e instanceof CapturaFalhou) return { motivo: e.motivo, detalhe };
  if (e instanceof InstagramSessaoInvalida) return { motivo: "sessao_instagram", detalhe };
  if (e instanceof InstagramLimite) return { motivo: "limite_instagram", detalhe };
  if (e instanceof InstagramPerfilNaoEncontrado) return { motivo: "perfil_nao_encontrado", detalhe };
  return { motivo: "erro", detalhe };
}

/**
 * Quantos rascunhos o lote tem DE FATO no banco. O contador em memória pode
 * ficar atrás: uma gravação que falha no meio de um bloco deixa linhas que ele
 * não contou, e o status salvo antes de uma queda pode estar atrasado. Null se
 * o banco não respondeu (fica o contador em memória).
 */
async function rascunhosNoLote(teamId: string, lote: string): Promise<number | null> {
  try {
    return await runAsSystem(teamId, () => db().prospectDraft.count({ where: { lote } }));
  } catch (err) {
    logger.warn({ lote, err: err instanceof Error ? err.message : String(err) }, "[captura] não contei os rascunhos do lote");
    return null;
  }
}

/**
 * "Tem WhatsApp?" do lote (produto §H.2), sem nunca derrubar a captura: se a
 * checagem falhar, os rascunhos ficam sem a marca (a tela mostra "não sei").
 */
async function marcarWhatsAppSemFalhar(teamId: string, lote: string, checar = true): Promise<void> {
  if (!checar) return;
  try {
    await runAsSystem(teamId, () => marcarTemWhatsAppDoLote(lote));
  } catch (err) {
    logger.warn({ lote, err: err instanceof Error ? err.message : String(err) }, "[captura] checagem de WhatsApp do lote falhou — fila segue sem a marca");
  }
}

/**
 * Roda `coletar` para o job e devolve o status final. Lança `CapturaFalhou`
 * quando o job deve ficar `failed`: nada gravado, bloqueio do Google ou erro
 * inesperado (o parcial, se houver, já está gravado e no status).
 */
export async function executarCaptura(job: CaptureJob, coletar: Coletor): Promise<StatusCaptura> {
  const { teamId, lote, origem } = job;
  const checarWhatsApp = deveChecarWhatsApp(job);

  const anterior = await lerStatusCaptura(teamId, lote);
  if (anterior && FINAIS.includes(anterior.estado)) {
    // Re-entrega de um job que já terminou: idempotente, não raspa de novo.
    logger.info({ lote, estado: anterior.estado }, "[captura] lote já terminado — ignorando a re-entrega");
    return anterior;
  }
  if (anterior?.estado === "rodando") {
    // Job devolvido à fila depois de uma queda do worker (stalled). Raspar de
    // novo martelaria o Google/Instagram (risco de ban) e duplicaria os
    // rascunhos já gravados. Fecha como interrompido com o que já veio.
    // Risco aceito: com o Redis fora bem nessa hora, `lerStatusCaptura` volta
    // null e a raspagem recomeça (duplica rascunhos) — raro, e o BullMQ também
    // depende do Redis para devolver o job.
    await marcarWhatsAppSemFalhar(teamId, lote, checarWhatsApp);
    const criados = (await rascunhosNoLote(teamId, lote)) ?? anterior.criados;
    const estado: EstadoCaptura = criados > 0 ? "parcial" : "falhou";
    const st: StatusCaptura = {
      ...anterior,
      criados,
      estado,
      motivo: "interrompida",
      mensagem: mensagemDaCaptura("interrompida", origem),
    };
    await salvarStatusCaptura(teamId, st);
    logger.warn({ lote, origem, criados }, "[captura] job retomado após queda — fechado como interrompido, sem raspar de novo");
    if (estado === "falhou") throw new CapturaFalhou("interrompida", st.mensagem!);
    return st;
  }

  const st = novoStatusCaptura({ lote, origem, estado: "rodando", total: totalDoJob(job) });
  st.iniciadoEm = new Date().toISOString();

  // Escritas do status em fila (uma de cada vez): progresso e gravação chegam
  // intercalados e a última escrita tem de ser a mais nova.
  let escrita: Promise<void> = Promise.resolve();
  const salvar = () => {
    const copia: StatusCaptura = { ...st, falhasAmostra: [...st.falhasAmostra] };
    escrita = escrita.then(() => salvarStatusCaptura(teamId, copia));
    return escrita;
  };
  await salvar();

  const ctx: ContextoColeta = {
    gravar: async (itens) => {
      if (!itens.length) return 0;
      const n = await runAsSystem(teamId, () => insertDrafts(origem, lote, itens, job.ownerId ?? null));
      st.criados += n;
      void salvar();
      return n;
    },
    progresso: (lidos) => {
      st.processados = lidos;
      void salvar();
    },
    falha: (item, motivo) => {
      st.falhas++;
      if (st.falhasAmostra.length < AMOSTRA_FALHAS) st.falhasAmostra.push({ item, motivo: motivo.slice(0, 200) });
      void salvar();
    },
    continuacao: (c) => {
      st.continuacao = c;
      void salvar();
    },
  };

  let resultado: ResultadoColeta;
  try {
    resultado = await coletar(ctx);
  } catch (e) {
    const { motivo, detalhe } = motivoDoErro(e);
    await marcarWhatsAppSemFalhar(teamId, lote, checarWhatsApp);
    st.criados = (await rascunhosNoLote(teamId, lote)) ?? st.criados;
    st.estado = st.criados > 0 ? "parcial" : "falhou";
    st.motivo = motivo;
    st.mensagem = mensagemDaCaptura(motivo, origem, motivo === "erro" ? detalhe.slice(0, 200) : null);
    await salvar();
    logger.error({ lote, origem, motivo, criados: st.criados, err: detalhe }, "[captura] falhou");
    throw e instanceof CapturaFalhou ? e : new CapturaFalhou(motivo, detalhe, { cause: e });
  }

  await marcarWhatsAppSemFalhar(teamId, lote, checarWhatsApp);
  st.criados = (await rascunhosNoLote(teamId, lote)) ?? st.criados;
  const interrupcao = resultado.interrupcao;
  if (interrupcao?.motivo === "parada_pelo_usuario") {
    // Parar não é falha: com ou sem contatos, o que veio está na fila e não derruba o job.
    st.estado = st.criados > 0 ? "parcial" : "interrompida";
    st.motivo = interrupcao.motivo;
    st.mensagem = mensagemDaCaptura(interrupcao.motivo, origem, interrupcao.detalhe ?? null);
  } else if (interrupcao) {
    st.estado = st.criados > 0 ? "parcial" : "falhou";
    st.motivo = interrupcao.motivo;
    st.mensagem = mensagemDaCaptura(interrupcao.motivo, origem, interrupcao.detalhe ?? null);
  } else if (st.criados > 0) {
    st.estado = "concluida";
    if (resultado.fonteEsgotada) {
      st.motivo = "fonte_esgotada";
      st.mensagem = mensagemDaCaptura("fonte_esgotada", origem, `${st.criados} ${st.criados === 1 ? "empresa" : "empresas"}`);
    }
  } else {
    // Terminou sem erro e sem nada: "vazio" não é "concluído" (INT-11).
    st.estado = st.falhas > 0 ? "falhou" : "vazia";
    st.motivo = st.falhas > 0 ? "erro" : "sem_resultados";
    st.mensagem = st.falhas > 0 ? `Nenhum item deu certo (${st.falhas} falha(s)).` : mensagemDaCaptura("sem_resultados", origem);
  }
  await salvar();
  logger.info(
    { lote, origem, estado: st.estado, motivo: st.motivo, criados: st.criados, lidos: st.processados, falhas: st.falhas },
    "[captura] fim",
  );

  if (st.estado === "falhou" || st.motivo === "bloqueio_google") {
    throw new CapturaFalhou(st.motivo ?? "erro", st.mensagem ?? "captura falhou");
  }
  return st;
}

// ---------------------------------------------------------------------------
// CNPJ em lote (fila `capture`, origem `cnpj`)
// ---------------------------------------------------------------------------

/** Teto do lote de CNPJ na fila (o resto vira "parcial: tempo esgotado"). */
export const CNPJ_LOTE_TETO_MS = Number(process.env.CAPTURE_CNPJ_TETO_MS ?? 20 * 60_000);

/**
 * Coletor do lote de CNPJ: consulta um a um pelo consultor compartilhado
 * (cache + fichas do CNPJá) e grava cada rascunho assim que chega. Pausa curta
 * entre idas à rede (a BrasilAPI também barra rajada); do cache não pausa.
 */
export function coletarLoteCnpj(
  cnpjs: string[],
  opts: { tetoMs?: number; pausaMs?: number; agora?: () => number } = {},
): Coletor {
  const teto = opts.tetoMs ?? CNPJ_LOTE_TETO_MS;
  const pausa = opts.pausaMs ?? 400;
  const agora = opts.agora ?? Date.now;
  return async (ctx) => {
    const inicio = agora();
    let lidos = 0;
    for (const raw of cnpjs) {
      if (agora() - inicio > teto) {
        return { interrupcao: { motivo: "tempo_esgotado", detalhe: `${cnpjs.length - lidos} CNPJ(s) não consultado(s)` } };
      }
      let foiNaRede = false;
      try {
        const { resultado, origem } = await consultarCnpjDetalhado(raw);
        foiNaRede = origem !== "cache";
        await ctx.gravar([draftDoCnpj(resultado)]);
      } catch (e) {
        foiNaRede = !(e instanceof CnpjInvalid);
        ctx.falha(raw, motivoFalhaCnpj(e));
      }
      lidos++;
      ctx.progresso(lidos);
      if (foiNaRede && pausa > 0 && lidos < cnpjs.length) {
        await new Promise((r) => setTimeout(r, pausa + Math.random() * pausa));
      }
    }
    return { interrupcao: null };
  };
}
