import type { WebhookCru } from "../comum";
import type { CapacidadeBooleanaDeLigacao } from "../capacidades";
import type { DescritorDeLigacao } from "../descritor";
import type { CodigoDeErroDeLigacao } from "../erros";
import type { CausaDeLigacao } from "../fato";
import type { ContextoDaLigacao, ProvedorDeLigacao } from "../interface";

/**
 * Os tipos da SUÍTE DE CONTRATO do provedor de ligação.
 *
 * A suíte é a mesma para todo adaptador. O que muda é o CENÁRIO: o adaptador, o contexto e o ROTEIRO, que é
 * a parte que sabe provocar, no provedor de verdade ou nas respostas gravadas dele, o que a suíte precisa ver
 * (uma ligação atendida, um aviso assinado, uma gravação pronta). Quem escreve um adaptador escreve o cenário
 * dele e roda a mesma suíte. Contra o Fake, o cenário vive em `fake/cenario.ts`.
 */

/** O que a suíte mede na matriz através de `roteiro.comprovar` (o que a interface não deixa ver). */
export type CapacidadeComprovadaPeloRoteiroDeLigacao = Extract<CapacidadeBooleanaDeLigacao, "causaDoFimGarantida">;

export const CAPACIDADES_COMPROVADAS_PELO_ROTEIRO_DE_LIGACAO: readonly CapacidadeComprovadaPeloRoteiroDeLigacao[] = ["causaDoFimGarantida"];

export type ProvocacaoDeErroDeLigacao = {
  nome: string;
  /** O erro neutro que a suíte espera ver. */
  esperado: CodigoDeErroDeLigacao;
  /** Provoca o erro pelo caminho que o adaptador tem (resposta gravada, sandbox, script). Deve REJEITAR. */
  provocar: () => Promise<unknown>;
};

/** O que a rede faz com a ligação, para o roteiro conduzir. */
export type DesfechoDeLigacaoDeTeste = {
  causa: CausaDeLigacao;
  /** Segundos de conversa (só com `atendida`). */
  duracaoS?: number;
  /** Segundos de toque antes do atendimento ou do fim. */
  toqueS?: number;
  /** O provedor conta o fim como falha ao originar (só onde o provedor avisa isso). */
  falhouAoOriginar?: boolean;
};

export interface RoteiroDeContratoDeLigacao {
  /** Um id de ligação do CRM Agro novo a cada chamada (uuid). */
  novoCallId(): string;
  /** Um número de destino novo a cada chamada, em E.164. Os testes não podem colidir entre si. */
  novoDestino(): string;
  /** O contato deu permissão para esta ligação (só importa para provedor que não liga a frio). */
  permitirDestino(destinoE164: string): void;
  /** A rede conduz a ligação até o fim e o provedor monta os avisos e a gravação (acontece fora do CRM Agro). */
  conduzir(providerCallId: string, desfecho: DesfechoDeLigacaoDeTeste): Promise<void>;
  /** Anda o relógio do provedor (e do cenário, quando ele é simulado). */
  avancar(ms: number): Promise<void>;
  /** Os avisos que o provedor mandaria desde a última coleta, no formato real, assinados como o adaptador espera. */
  sacarAvisos(): Promise<WebhookCru[]>;
  /** Um aviso de um tipo de evento que o provedor manda e o CRM Agro não entende (ex.: "em espera"). */
  avisoQueOCrmAgroNaoEntende(): Promise<WebhookCru>;
  /** O mesmo aviso, mas com 1 byte do corpo ou da assinatura trocado. */
  adulterar(req: WebhookCru): WebhookCru;
  /**
   * Uma provocação por erro neutro que o adaptador consegue produzir. Recebe o cenário para chamar
   * `c.provedor` (assim a suíte consegue trocar o adaptador por um defeituoso e ver a conferência reprovar).
   */
  respostasDeErro(c: CenarioDeContratoDeLigacao): ProvocacaoDeErroDeLigacao[];
  /**
   * Prova das capacidades que a interface não exercita. Ausente = "não comprovo". Capacidade `true` sem
   * prova REPROVA.
   */
  comprovar?: Partial<Record<CapacidadeComprovadaPeloRoteiroDeLigacao, () => Promise<boolean>>>;
  /** A query do GET de verificação. Só para provedor que tem `responderVerificacao`. */
  queryDeVerificacao?(desafio: string, certa: boolean): Record<string, string>;
}

export interface CenarioDeContratoDeLigacao {
  nome: string;
  provedor: ProvedorDeLigacao;
  descritor: DescritorDeLigacao;
  /** O contexto TEM a linha: toda ligação de teste sai por ela. */
  ctx: ContextoDaLigacao;
  /** Mesma forma, com credencial errada. */
  ctxComCredencialErrada: ContextoDaLigacao;
  /** Valores que NUNCA podem aparecer em erro, log nem resposta. */
  segredos: readonly string[];
  roteiro: RoteiroDeContratoDeLigacao;
}

export type FabricaDeCenarioDeLigacao = () => CenarioDeContratoDeLigacao | Promise<CenarioDeContratoDeLigacao>;
