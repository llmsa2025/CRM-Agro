import type { CallStatus } from "@prisma/client";
import type { CapacidadesDeLigacao } from "../provedor/capacidades";
import type { CausaDeLigacao, FatoDeLigacao } from "../provedor/fato";
import {
  instanteDoFatoDeLigacao,
  normalizarLinhaDoTempoDeLigacao,
  type EntradaDaLinhaDoTempoDeLigacao,
  type OrigemDeFatoDeLigacao,
} from "./linha-do-tempo";

/**
 * O DESFECHO da ligação: o resultado concluído do CONJUNTO de fatos,
 * por uma função PURA. Ninguém digita o resultado. O mesmo conjunto dá o mesmo desfecho em qualquer ordem, com
 * repetição, com aviso forjado e com fechamento sintético. Generaliza `desfechoDaLigacao` de
 * `calls/whatsapp-fatos.ts` da branch do WhatsApp (o `MOTIVO_POR_ERRO` da Meta fica para o adaptador da F4).
 *
 * Sem banco, fila nem efeito. Quem grava (status, resultado, `Call.evidencia`) é o aplicador (F1B-10a).
 */

/** Conversa = atendida com 30 s ou mais de duração conectada. Sem duração conectada comprovada, não é conversa. */
export const LIMIAR_CONVERSA_S = 30;

/** O fim do aviso e o fim da consulta precisam bater em até 5 s para o aviso valer ao lado da consulta. */
export const TOLERANCIA_DO_FIM_DE_LIGACAO_MS = 5_000;

/** Os status que o desfecho produz. Subconjunto de `CallStatus`: o desfecho nunca muda o enum. */
export type StatusDeLigacao = Extract<CallStatus, "completed" | "no_answer" | "busy" | "failed">;

/** O resultado da ligação. Espelha `CallOutcome` mais `rejected`, que nasce na F1B-06 (por isso o tipo é próprio). */
export type ResultadoDeLigacao = "answered" | "no_answer" | "busy" | "voicemail" | "wrong_number" | "rejected";

/** Prova da tentativa: `provedor` (comprovada) ou `aguardando_consulta` (falta só a confirmação pela consulta). */
export type EvidenciaDeLigacao = "provedor" | "aguardando_consulta";

// ─── A tabela de causa ──────────────────────────────────────────────────────────────────────────────────

/**
 * O que falta para o resultado (outcome) valer:
 *  - `nada`: vale sempre;
 *  - `causa_garantida`: só se a matriz diz `causaDoFimGarantida` (regra R6: `no_answer` e `wrong_number`);
 *  - `atendimento_real`: só com fato de atendida vindo do provedor.
 */
type ExigenciaDoResultado = "nada" | "causa_garantida" | "atendimento_real";

/**
 * Quando "houve tentativa" (a rede tocou ou respondeu):
 *  - `sim` / `nao`: a causa decide;
 *  - `tocou`: só se há fato do provedor de que tocou (`chamando`, `atendida` ou `recusada`);
 *  - `tocou_ou_garantida`: tocou, ou a causa do fim é garantida pela matriz.
 */
type ExigenciaDaTentativa = "sim" | "nao" | "tocou" | "tocou_ou_garantida";

export type RegraDeCausaDeLigacao = {
  /** `por_toque` = `no_answer` se a rede tocou, `failed` se não. */
  status: StatusDeLigacao | "por_toque";
  outcome: ResultadoDeLigacao | null;
  outcomeExige: ExigenciaDoResultado;
  tentativa: ExigenciaDaTentativa;
  /** Frase curta para a tela (§15 do AGENTS.md). Nulo quando não há o que explicar. */
  motivo: string | null;
  /** Frase quando o resultado não vale (causa não garantida). */
  motivoSemResultado?: string;
};

/**
 * A TABELA DE CAUSA (plano: Notas comuns da F1B, "Definições únicas"). Uma linha por causa neutra mais o fato
 * `falhou_ao_originar`. Em "desconhecida", "fato real" quer dizer fato de origem `webhook` ou `consulta`.
 */
export const TABELA_DE_CAUSA_DE_LIGACAO = {
  atendida: { status: "completed", outcome: "answered", outcomeExige: "nada", tentativa: "sim", motivo: null },
  nao_atendeu: {
    status: "no_answer",
    outcome: "no_answer",
    outcomeExige: "causa_garantida",
    tentativa: "tocou_ou_garantida",
    motivo: "Chamou e ninguém atendeu.",
    motivoSemResultado: "O provedor não confirmou o motivo.",
  },
  ocupado: { status: "busy", outcome: "busy", outcomeExige: "nada", tentativa: "sim", motivo: "Linha ocupada." },
  recusou: { status: "no_answer", outcome: "rejected", outcomeExige: "nada", tentativa: "sim", motivo: "O contato recusou a ligação." },
  caixa_postal: { status: "no_answer", outcome: "voicemail", outcomeExige: "nada", tentativa: "sim", motivo: "Caiu na caixa postal." },
  numero_inexistente: {
    status: "failed",
    outcome: "wrong_number",
    outcomeExige: "causa_garantida",
    tentativa: "nao",
    motivo: "O número não existe.",
  },
  cancelada_por_quem_ligou: {
    status: "por_toque",
    outcome: null,
    outcomeExige: "nada",
    tentativa: "tocou",
    motivo: "A ligação foi encerrada antes de atender.",
  },
  falha_de_rede: { status: "failed", outcome: null, outcomeExige: "nada", tentativa: "nao", motivo: "A ligação não completou por falha de rede." },
  sem_permissao: {
    status: "failed",
    outcome: null,
    outcomeExige: "nada",
    tentativa: "nao",
    motivo: "O contato ainda não deu permissão para esta ligação.",
  },
  destino_nao_recebe: {
    status: "failed",
    outcome: null,
    outcomeExige: "nada",
    tentativa: "nao",
    motivo: "O número não recebe ligação por este canal.",
  },
  desconhecida: {
    status: "completed",
    outcome: "answered",
    outcomeExige: "atendimento_real",
    tentativa: "tocou",
    motivo: "O provedor não confirmou o fim da ligação.",
  },
  // O fato `falhou_ao_originar`: o texto vem da causa que ele traz (ver `motivoDeLigacaoQueNaoSaiu`).
  falhou_ao_originar: { status: "failed", outcome: null, outcomeExige: "nada", tentativa: "nao", motivo: null },
} as const satisfies Record<CausaDeLigacao | "falhou_ao_originar", RegraDeCausaDeLigacao>;

/** Texto quando a falha ao originar não traz uma causa que explique. */
const MOTIVO_GENERICO_DE_FALHA_AO_ORIGINAR = "A ligação não saiu.";

/** Causas que explicam por que a ligação nem saiu. As outras não dizem nada útil num fato `falhou_ao_originar`. */
const CAUSAS_QUE_EXPLICAM_A_FALHA: readonly CausaDeLigacao[] = ["numero_inexistente", "falha_de_rede", "sem_permissao", "destino_nao_recebe"];

/** O texto neutro de uma ligação que não saiu. */
export function motivoDeLigacaoQueNaoSaiu(causa: CausaDeLigacao): string {
  return CAUSAS_QUE_EXPLICAM_A_FALHA.includes(causa) ? (TABELA_DE_CAUSA_DE_LIGACAO[causa].motivo as string) : MOTIVO_GENERICO_DE_FALHA_AO_ORIGINAR;
}

/**
 * Causas que afirmam o que a REDE fez. O fechamento sintético (origem `crmagro`) não sabe isso: se ele traz uma
 * delas, vira `desconhecida`. O CRM Agro só afirma o que é dele: cancelou, falhou, não tinha permissão.
 */
const CAUSAS_QUE_SO_O_PROVEDOR_AFIRMA: readonly CausaDeLigacao[] = ["atendida", "nao_atendeu", "ocupado", "recusou", "caixa_postal", "numero_inexistente"];

// ─── O resultado ────────────────────────────────────────────────────────────────────────────────────────

/** O que o desfecho precisa da matriz do provedor. A matriz inteira também serve. */
export type MatrizDoDesfechoDeLigacao = Pick<CapacidadesDeLigacao, "causaDoFimGarantida" | "webhook" | "consulta">;

export type DesfechoDeLigacao = {
  /** O fato terminal que mandou na causa. */
  terminal: { idEvento: string; origem: OrigemDeFatoDeLigacao; tipo: "encerrada" | "falhou_ao_originar"; causa: CausaDeLigacao };
  status: StatusDeLigacao;
  outcome: ResultadoDeLigacao | null;
  /** Frase curta para a tela e para o gestor. */
  motivo: string | null;
  atendidaEm: Date | null;
  encerradaEm: Date;
  /** Segundos conectados, desde o atendimento. Nulo quando o provedor não informou ou não houve atendimento. */
  duracaoConectadaS: number | null;
  conversa: boolean;
  tentativaComprovada: boolean;
  /** Sem olhar a lista de provedores comprovados: isso é do aplicador. */
  evidencia: EvidenciaDeLigacao | null;
};

type EntradaDe<T extends FatoDeLigacao["tipo"]> = EntradaDaLinhaDoTempoDeLigacao & { fato: Extract<FatoDeLigacao, { tipo: T }> };

const ehDoTipo =
  <T extends FatoDeLigacao["tipo"]>(tipo: T) =>
  (e: EntradaDaLinhaDoTempoDeLigacao): e is EntradaDe<T> =>
    e.fato.tipo === tipo;

/** Os fatos que encerram a ligação: o fim com causa e a falha ao originar. */
type TerminalDeLigacao = EntradaDe<"encerrada"> | EntradaDe<"falhou_ao_originar">;
const ehTerminal = (e: EntradaDaLinhaDoTempoDeLigacao): e is TerminalDeLigacao => e.fato.tipo === "encerrada" || e.fato.tipo === "falhou_ao_originar";

/** Quanto pesa a origem: a consulta diz o fim real, o aviso pode ser forjado, o fechamento sintético é só nosso. */
const PESO_DA_ORIGEM: Record<OrigemDeFatoDeLigacao, number> = { consulta: 3, webhook: 2, crmagro: 1 };

/** Ordem de força: origem, depois o instante mais recente, depois o maior `idEvento`. Negativo = `a` é mais forte. */
function maisForte(a: EntradaDaLinhaDoTempoDeLigacao, b: EntradaDaLinhaDoTempoDeLigacao): number {
  const porOrigem = PESO_DA_ORIGEM[b.origem] - PESO_DA_ORIGEM[a.origem];
  if (porOrigem !== 0) return porOrigem;
  const porInstante = instanteDoFatoDeLigacao(b.fato) - instanteDoFatoDeLigacao(a.fato);
  if (porInstante !== 0) return porInstante;
  return a.idEvento < b.idEvento ? 1 : a.idEvento > b.idEvento ? -1 : 0;
}

/** Candidato a um campo (hora do atendimento ou duração): vale o de origem mais forte, depois o valor mais recente. */
type Candidato<V> = { origem: OrigemDeFatoDeLigacao; idEvento: string; instante: number; valor: V };

function melhorCandidato<V>(candidatos: readonly Candidato<V>[]): Candidato<V> | null {
  let melhor: Candidato<V> | null = null;
  for (const c of candidatos) {
    if (
      melhor === null ||
      PESO_DA_ORIGEM[c.origem] > PESO_DA_ORIGEM[melhor.origem] ||
      (c.origem === melhor.origem && (c.instante > melhor.instante || (c.instante === melhor.instante && c.idEvento > melhor.idEvento)))
    ) {
      melhor = c;
    }
  }
  return melhor;
}

/**
 * Conclui o desfecho do conjunto de fatos, ou devolve nulo se a ligação ainda está em andamento (sem fato
 * terminal). Regras (plano F1B-08):
 *
 *  - **Terminal vencedor**: `consulta`, depois `webhook`, depois `crmagro`; na mesma origem, o instante mais recente
 *    e, no empate, o maior `idEvento`. Ele manda na causa (tabela). O sintético nunca vence fato real.
 *  - **Mescla por campo**: hora do atendimento e duração vêm do fato que os tiver, mas o valor de outro fato só
 *    vale se não contradiz o terminal vencedor (o fim bate em até 5 s, a duração não passa do tempo entre o
 *    atendimento e o fim, e o atendimento não vem depois do fim). Fato `atendida` é ignorado quando o terminal
 *    diz que não atendeu. Fato de origem `crmagro` não dá hora nem duração.
 *  - **R6**: `no_answer` e `wrong_number` só com `causaDoFimGarantida`.
 *  - **Duração só desde o atendimento**: toque longo sem atender nunca vira `answered`.
 *  - **Tentativa comprovada**: só fato de origem `webhook` ou `consulta` prova que a rede tocou ou respondeu.
 */
export function calcularDesfechoDeLigacao(entradas: readonly EntradaDaLinhaDoTempoDeLigacao[], matriz: MatrizDoDesfechoDeLigacao): DesfechoDeLigacao | null {
  const linha = normalizarLinhaDoTempoDeLigacao(entradas);

  const vencedor = linha.filter(ehTerminal).sort(maisForte)[0];
  if (!vencedor) return null;

  const fim = instanteDoFatoDeLigacao(vencedor.fato);
  const reais = linha.filter((e) => e.origem !== "crmagro");
  const falhouAoOriginar = vencedor.fato.tipo === "falhou_ao_originar";

  // 1. A causa do terminal vencedor. O fechamento sintético só afirma o que é do CRM Agro.
  const causaDoFato = vencedor.fato.causa;
  let causa: CausaDeLigacao =
    !falhouAoOriginar && vencedor.origem === "crmagro" && CAUSAS_QUE_SO_O_PROVEDOR_AFIRMA.includes(causaDoFato) ? "desconhecida" : causaDoFato;

  // 2. Fatos do provedor que descrevem a ligação. Atendimento só vale se o terminal deixa (atendida ou desconhecida)
  //    e nunca vem depois do fim.
  const terminalAceitaAtendimento = !falhouAoOriginar && (causa === "atendida" || causa === "desconhecida");
  const atendidasAoVivo = terminalAceitaAtendimento ? reais.filter(ehDoTipo("atendida")).filter((e) => instanteDoFatoDeLigacao(e.fato) <= fim) : [];
  // Fins do provedor que repetem o mesmo fim do vencedor (ele próprio e, no máximo, 5 s de diferença).
  const fimsDoMesmoFim = terminalAceitaAtendimento
    ? reais
        .filter(ehDoTipo("encerrada"))
        .filter((e) => e.fato.causa === "atendida" || e.fato.causa === "desconhecida")
        .filter((e) => e.idEvento === vencedor.idEvento || Math.abs(instanteDoFatoDeLigacao(e.fato) - fim) <= TOLERANCIA_DO_FIM_DE_LIGACAO_MS)
    : [];
  const chamando = reais.filter(ehDoTipo("chamando"));
  const recusadas = reais.filter(ehDoTipo("recusada"));

  const atendimentoAtestado = atendidasAoVivo.length > 0 || fimsDoMesmoFim.some((e) => e.fato.causa === "atendida");

  // 3. Quem recusou: o aviso de recusa explica um fim genérico. Não desfaz um atendimento comprovado.
  if (!falhouAoOriginar && (causa === "nao_atendeu" || causa === "desconhecida") && recusadas.length > 0 && !atendimentoAtestado) causa = "recusou";

  const regra: RegraDeCausaDeLigacao = TABELA_DE_CAUSA_DE_LIGACAO[falhouAoOriginar ? "falhou_ao_originar" : causa];
  const tocou = chamando.length > 0 || recusadas.length > 0 || atendimentoAtestado;

  // 4. Resultado, status e tentativa pela tabela.
  const outcomeVale =
    regra.outcomeExige === "nada" || (regra.outcomeExige === "causa_garantida" && matriz.causaDoFimGarantida) || (regra.outcomeExige === "atendimento_real" && atendimentoAtestado);
  const outcome = outcomeVale ? regra.outcome : null;
  const status: StatusDeLigacao = regra.status === "por_toque" ? (tocou ? "no_answer" : "failed") : regra.status;
  const tentativaComprovada =
    regra.tentativa === "sim" ||
    (regra.tentativa === "tocou" && tocou) ||
    (regra.tentativa === "tocou_ou_garantida" && (tocou || matriz.causaDoFimGarantida));

  const motivo = falhouAoOriginar
    ? motivoDeLigacaoQueNaoSaiu(causaDoFato)
    : outcome === null && regra.motivoSemResultado !== undefined
      ? regra.motivoSemResultado
      : regra.motivo;

  // 5. Hora do atendimento e duração, só de quem atendeu e só de fato do provedor que não contradiz o fim.
  const atendeu = outcome === "answered";
  let atendidaEm: Date | null = null;
  let duracaoConectadaS: number | null = null;
  if (atendeu) {
    const horas: Candidato<number>[] = [];
    for (const e of atendidasAoVivo) horas.push({ origem: e.origem, idEvento: e.idEvento, instante: instanteDoFatoDeLigacao(e.fato), valor: instanteDoFatoDeLigacao(e.fato) });
    for (const e of fimsDoMesmoFim) {
      const t = e.fato.atendidaEm === undefined ? null : Date.parse(e.fato.atendidaEm);
      if (t !== null && t <= fim) horas.push({ origem: e.origem, idEvento: e.idEvento, instante: t, valor: t });
    }
    const hora = melhorCandidato(horas);
    atendidaEm = hora ? new Date(hora.valor) : null;

    // A duração conectada não passa do tempo entre o atendimento e o fim (em segundos inteiros).
    const teto = hora ? Math.ceil((fim - hora.valor) / 1000) : null;
    const duracoes: Candidato<number>[] = [];
    for (const e of fimsDoMesmoFim) {
      const d = e.fato.duracaoConectadaS;
      if (d === undefined) continue;
      if (e.idEvento !== vencedor.idEvento && teto !== null && d > teto) continue;
      duracoes.push({ origem: e.origem, idEvento: e.idEvento, instante: instanteDoFatoDeLigacao(e.fato), valor: d });
    }
    duracaoConectadaS = melhorCandidato(duracoes)?.valor ?? null;
  }
  const conversa = atendeu && duracaoConectadaS !== null && duracaoConectadaS >= LIMIAR_CONVERSA_S;

  // 6. Prova. Com a URL assinada por nós e uma consulta possível, o aviso sozinho ainda não basta.
  const faltaConsulta = matriz.webhook === "url_assinada" && matriz.consulta.porId && !linha.some((e) => e.origem === "consulta");
  const evidencia: EvidenciaDeLigacao | null = tentativaComprovada ? (faltaConsulta ? "aguardando_consulta" : "provedor") : null;

  return {
    terminal: {
      idEvento: vencedor.idEvento,
      origem: vencedor.origem,
      tipo: vencedor.fato.tipo,
      causa: falhouAoOriginar ? causaDoFato : causa,
    },
    status,
    outcome,
    motivo,
    atendidaEm,
    encerradaEm: new Date(fim),
    duracaoConectadaS,
    conversa,
    tentativaComprovada,
    evidencia,
  };
}
