/**
 * Agente de conversa do nó `ai_agent` (modo "conversa"): o que NÃO precisa de banco nem de IA.
 *
 * O nó é um laço sobre ele mesmo. Cada execução é um TURNO e deixa no resultado do passo (`NodeResult.agente`)
 * o estado que o turno seguinte lê (o motor já grava o `result` inteiro em `FlowStepExecution`, então não há
 * tabela nova). As fases:
 *
 * - **sem estado**: abertura. Fala primeiro, e passa a `esperando`;
 * - **esperando**: acordou pela mensagem do contato, ou pelo fim do prazo. Só AVALIA (não envia): uma pessoa
 *   respondeu na conversa? o contato falou? passou do silêncio? chegou ao limite de mensagens? Se o contato
 *   falou, vai a `preparando`;
 * - **preparando**: uma pausa curta e humana, 8 a 20 s (e agrupa quem manda várias mensagens seguidas). Depois, fala;
 * - **tentando_de_novo**: a IA falhou; tenta de novo mais tarde, até `MAX_FALHAS_DA_IA` vezes seguidas;
 * - **encerrou**: o laço acabou (`fim` diz por quê) e o fluxo segue para o próximo passo.
 *
 * A execução com banco e canal fica em `executor.ts` (`executarAgenteDeConversa`), que usa estas regras.
 */

export const AGENTE_MAX_RESPOSTAS_PADRAO = 6;
export const AGENTE_SILENCIO_HORAS_PADRAO = 24;
/** Falhas seguidas da IA antes de passar a conversa para uma pessoa. */
export const MAX_FALHAS_DA_IA = 3;
/** Quanto esperar para tentar de novo depois de uma falha da IA. */
export const ESPERA_APOS_FALHA_DA_IA_MS = 5 * 60_000;
/**
 * De quanto em quanto tempo o agente confere a espera (rede de segurança para um evento perdido). Mais longo
 * que o da condição "respondeu?" (60 min): cada conferência é um passo do fluxo, e uma espera de dias com um
 * passo por hora estouraria o teto de passos por inscrição.
 */
export const RECHECK_DO_AGENTE_MS = 6 * 3_600_000;
/**
 * Pausa antes de responder: agrupa quem manda várias mensagens seguidas e não parece robô. Curta de propósito (o
 * agente tem que ser rápido): 8 a 20 s. Era 20 a 60 s.
 */
const PAUSA_MIN_S = 8;
const PAUSA_MAX_S = 20;

export type FaseDoAgente = "esperando" | "preparando" | "tentando_de_novo" | "encerrou";

export type FimDaConversa =
  /** A IA (ou o limite, ou uma falha repetida) pediu uma pessoa: o dono do contato é avisado. */
  | "passou_para_pessoa"
  /** O contato parou de responder pelo prazo do nó. */
  | "silencio"
  /** Uma pessoa escreveu na conversa: o agente se cala. */
  | "pessoa_respondeu"
  /** A IA encerrou (sem interesse, número errado, fim natural). */
  | "encerrado_pela_ia"
  /** O agente mandou todas as mensagens que podia e o contato ainda respondeu. */
  | "limite";

export type EstadoDoAgente = {
  acao: FaseDoAgente;
  /** A conversa de WhatsApp em que o agente fala. */
  conversationId: string;
  /** Mensagens do agente até aqui, contando a de abertura. */
  enviadas: number;
  /** As mensagens do contato até este instante (ISO) já foram lidas pela IA. */
  vistoAte: string;
  /** Quando saiu a última mensagem do agente (ISO), e o id dela. */
  enviadoEm?: string;
  mensagemId?: string;
  /** Falhas SEGUIDAS da IA (zera quando uma mensagem sai). */
  falhas: number;
  fim?: FimDaConversa;
};

/** `result` de passos anteriores do nó (do mais novo para o mais antigo) → o estado vigente, ou `null`. */
export function lerEstadoDoAgente(resultadosDoMaisNovoAoMaisAntigo: unknown[]): EstadoDoAgente | null {
  for (const r of resultadosDoMaisNovoAoMaisAntigo) {
    const a = (r as { agente?: unknown } | null)?.agente;
    if (!a || typeof a !== "object") continue;
    const e = a as Partial<EstadoDoAgente>;
    if (typeof e.conversationId !== "string" || typeof e.vistoAte !== "string" || typeof e.enviadas !== "number") continue;
    // A conversa anterior terminou: uma nova entrada no nó começa do zero.
    if (e.acao === "encerrou") return null;
    if (e.acao !== "esperando" && e.acao !== "preparando" && e.acao !== "tentando_de_novo") continue;
    return {
      acao: e.acao,
      conversationId: e.conversationId,
      enviadas: e.enviadas,
      vistoAte: e.vistoAte,
      enviadoEm: typeof e.enviadoEm === "string" ? e.enviadoEm : undefined,
      mensagemId: typeof e.mensagemId === "string" ? e.mensagemId : undefined,
      falhas: typeof e.falhas === "number" ? e.falhas : 0,
    };
  }
  return null;
}

export type AvaliacaoDaEspera =
  | { tipo: "pessoa_respondeu" }
  | { tipo: "silencio" }
  | { tipo: "limite" }
  | { tipo: "continuar_esperando"; restanteMs: number }
  | { tipo: "preparar" };

/**
 * O que fazer ao acordar do "esperando". A ordem importa: se uma pessoa já respondeu à mão, o agente se
 * cala mesmo que o contato tenha escrito de novo.
 */
export function avaliarEspera(i: {
  estado: Pick<EstadoDoAgente, "enviadas" | "enviadoEm">;
  agora: Date;
  silencioMs: number;
  maxRespostas: number;
  /** Mensagens do contato depois de `vistoAte`. */
  novasDoContato: number;
  /** Mensagens enviadas na conversa depois da última do agente (e que não são dele). */
  mensagensDeOutros: number;
}): AvaliacaoDaEspera {
  if (i.mensagensDeOutros > 0) return { tipo: "pessoa_respondeu" };
  if (i.novasDoContato > 0) return i.estado.enviadas >= i.maxRespostas ? { tipo: "limite" } : { tipo: "preparar" };
  const desde = i.estado.enviadoEm ? new Date(i.estado.enviadoEm).getTime() : i.agora.getTime();
  const restanteMs = desde + i.silencioMs - i.agora.getTime();
  return restanteMs > 0 ? { tipo: "continuar_esperando", restanteMs } : { tipo: "silencio" };
}

/** Pausa antes de responder: 8 a 20 s (configurável por env só para teste e emergência). */
export function pausaAntesDeResponderMs(): number {
  const min = Number(process.env.FLOW_AGENTE_PAUSA_MIN_S ?? PAUSA_MIN_S);
  const max = Number(process.env.FLOW_AGENTE_PAUSA_MAX_S ?? PAUSA_MAX_S);
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(lo, max);
  return Math.round((lo + Math.random() * (hi - lo)) * 1000);
}

/** Texto do porquê, para o log do fluxo e para o aviso ao vendedor. */
export function textoDoFim(fim: FimDaConversa, motivo?: string): string {
  switch (fim) {
    case "passou_para_pessoa":
      return motivo ? `O agente passou a conversa para uma pessoa: ${motivo}` : "O agente passou a conversa para uma pessoa";
    case "silencio":
      return "O contato parou de responder";
    case "pessoa_respondeu":
      return "Uma pessoa respondeu na conversa, o agente parou";
    case "encerrado_pela_ia":
      return motivo ? `O agente encerrou a conversa: ${motivo}` : "O agente encerrou a conversa";
    case "limite":
      return "O agente chegou ao limite de mensagens e o contato ainda estava respondendo";
  }
}

/** Fins que pedem uma pessoa: o dono do contato é avisado (se o nó deixar). */
export function fimPedeUmaPessoa(fim: FimDaConversa): boolean {
  return fim === "passou_para_pessoa" || fim === "limite";
}

/** Por que a IA falhou, em palavras de gente (vai para o aviso e para o log). */
export function motivoLegivelDaFalha(motivo: string): string {
  switch (motivo) {
    case "ia_desligada":
      return "a IA está desligada nas Integrações";
    case "sem_chave":
      return "não há chave de IA conectada";
    case "saida_recusada":
      return "a resposta da IA trazia um dado que não está no cadastro nem na orientação";
    case "resposta_invalida":
      return "a IA devolveu uma resposta que não deu para usar";
    default:
      return "a IA deu erro";
  }
}
