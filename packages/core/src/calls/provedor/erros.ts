import type { ChaveDeProvedorDeLigacao } from "./capacidades";

/**
 * Os 8 ERROS NEUTROS da ligação.
 *
 * O adaptador de cada provedor traduz TODO erro do provedor para um destes. O resto do CRM Agro só conhece
 * estes. Duas regras:
 *
 * 1. **O texto do provedor nunca sai do adaptador.** Pode carregar telefone, nome e pedaço de chave. Por isso
 *    estas classes NÃO aceitam mensagem livre: o texto é fixo, em português (AGENTS.md (texto da interface)), escolhido aqui.
 *    Não há `cause` com o erro original. Para o log vai só o código e o provedor (`erroDeLigacaoParaLog`).
 * 2. **Cada erro diz o que quem chamou faz** (`acao`). O núcleo decide por `acao` e `codigo`, nunca por texto.
 *
 * Os nomes levam "Ligacao" porque o barrel do core reúne muitos módulos e nome repetido dá TS2308.
 */

export const CODIGOS_DE_ERRO_DE_LIGACAO = [
  "credencial_invalida",
  "provedor_indisponivel",
  "limite_de_requisicoes",
  "destino_invalido",
  "recusado_pelo_provedor",
  "linha_ocupada",
  "nao_encontrado",
  "nao_suportado",
] as const;
export type CodigoDeErroDeLigacao = (typeof CODIGOS_DE_ERRO_DE_LIGACAO)[number];

/** O que quem chamou deve fazer com o erro. */
export type AcaoDoErroDeLigacao =
  | "parar_e_alertar" // credencial: pausa a linha ou a conta, alerta, não tenta de novo
  | "tentar_de_novo" // indisponível: espera crescente
  | "tentar_depois_do_intervalo" // 429: respeita o intervalo
  | "corrigir_o_destino" // destino inválido: mostra ao vendedor, sem tentar de novo
  | "mostrar_o_motivo" // recusado: mostra o motivo fechado
  | "esperar_a_linha" // linha ocupada: a linha já está numa ligação
  | "marcar_divergencia" // não encontrado: divergência
  | "recusar_a_operacao"; // não suportado: a matriz manda, a operação nem é oferecida

export abstract class ErroDeLigacao extends Error {
  abstract readonly codigo: CodigoDeErroDeLigacao;
  abstract readonly acao: AcaoDoErroDeLigacao;
  /** Pode valer a pena tentar de novo, depois de esperar? */
  abstract readonly retentavel: boolean;
  /** Provedor de onde veio (a chave, nunca dado do provedor). */
  readonly provedor: ChaveDeProvedorDeLigacao | null;

  protected constructor(mensagem: string, provedor: ChaveDeProvedorDeLigacao | null) {
    super(mensagem);
    this.provedor = provedor;
  }

  /** Só dados seguros. Nunca inclui o texto do provedor (que a classe nem guarda). */
  toJSON(): {
    codigo: CodigoDeErroDeLigacao;
    acao: AcaoDoErroDeLigacao;
    retentavel: boolean;
    provedor: ChaveDeProvedorDeLigacao | null;
    mensagem: string;
  } {
    return { codigo: this.codigo, acao: this.acao, retentavel: this.retentavel, provedor: this.provedor, mensagem: this.message };
  }
}

export class CredencialInvalidaDeLigacao extends ErroDeLigacao {
  readonly codigo = "credencial_invalida" as const;
  readonly acao = "parar_e_alertar" as const;
  readonly retentavel = false;
  constructor(provedor: ChaveDeProvedorDeLigacao | null = null) {
    super("O provedor não aceitou a credencial da conta ou da linha.", provedor);
    this.name = "CredencialInvalidaDeLigacao";
  }
}

export class ProvedorIndisponivelDeLigacao extends ErroDeLigacao {
  readonly codigo = "provedor_indisponivel" as const;
  readonly acao = "tentar_de_novo" as const;
  readonly retentavel = true;
  constructor(provedor: ChaveDeProvedorDeLigacao | null = null) {
    super("O provedor de ligação não respondeu. O CRM Agro tenta de novo daqui a pouco.", provedor);
    this.name = "ProvedorIndisponivelDeLigacao";
  }
}

export class LimiteDeRequisicoesDeLigacao extends ErroDeLigacao {
  readonly codigo = "limite_de_requisicoes" as const;
  readonly acao = "tentar_depois_do_intervalo" as const;
  readonly retentavel = true;
  /** Quanto esperar, em milissegundos, quando o provedor informa. */
  readonly esperarMs: number | null;
  constructor(provedor: ChaveDeProvedorDeLigacao | null = null, esperarMs: number | null = null) {
    super("O provedor pediu para esperar um pouco antes de novas chamadas.", provedor);
    this.name = "LimiteDeRequisicoesDeLigacao";
    this.esperarMs = esperarMs !== null && Number.isFinite(esperarMs) && esperarMs >= 0 ? Math.floor(esperarMs) : null;
  }
  override toJSON() {
    return { ...super.toJSON(), esperarMs: this.esperarMs };
  }
}

export class DestinoInvalidoDeLigacao extends ErroDeLigacao {
  readonly codigo = "destino_invalido" as const;
  readonly acao = "corrigir_o_destino" as const;
  readonly retentavel = false;
  constructor(provedor: ChaveDeProvedorDeLigacao | null = null) {
    super("O provedor não aceitou o número de destino.", provedor);
    this.name = "DestinoInvalidoDeLigacao";
  }
}

/** O motivo é uma lista fechada: nunca texto do provedor. */
export const MOTIVOS_DE_RECUSA_DE_LIGACAO = ["sem_permissao", "destino_bloqueado", "sem_saldo", "destino_nao_permitido"] as const;
export type MotivoDeRecusaDeLigacao = (typeof MOTIVOS_DE_RECUSA_DE_LIGACAO)[number];

/** Texto fixo por motivo (AGENTS.md (texto da interface)). `sem_permissao` repete o texto da tabela de causas do plano. */
export const TEXTO_DA_RECUSA_DE_LIGACAO: Readonly<Record<MotivoDeRecusaDeLigacao, string>> = {
  sem_permissao: "O contato ainda não deu permissão para esta ligação.",
  destino_bloqueado: "O provedor bloqueou este destino.",
  sem_saldo: "A conta no provedor está sem saldo.",
  destino_nao_permitido: "A conta no provedor não pode ligar para este destino.",
};

export class RecusadoPeloProvedorDeLigacao extends ErroDeLigacao {
  readonly codigo = "recusado_pelo_provedor" as const;
  readonly acao = "mostrar_o_motivo" as const;
  readonly retentavel = false;
  readonly motivo: MotivoDeRecusaDeLigacao;
  /** Motivo fora da lista cai em `destino_nao_permitido`, o mais genérico. */
  constructor(provedor: ChaveDeProvedorDeLigacao | null = null, motivo: MotivoDeRecusaDeLigacao = "destino_nao_permitido") {
    const valido: MotivoDeRecusaDeLigacao = (MOTIVOS_DE_RECUSA_DE_LIGACAO as readonly string[]).includes(motivo) ? motivo : "destino_nao_permitido";
    super(TEXTO_DA_RECUSA_DE_LIGACAO[valido], provedor);
    this.name = "RecusadoPeloProvedorDeLigacao";
    this.motivo = valido;
  }
  override toJSON() {
    return { ...super.toJSON(), motivo: this.motivo };
  }
}

export class LinhaOcupadaDeLigacao extends ErroDeLigacao {
  readonly codigo = "linha_ocupada" as const;
  readonly acao = "esperar_a_linha" as const;
  readonly retentavel = true;
  constructor(provedor: ChaveDeProvedorDeLigacao | null = null) {
    super("A linha já está em uma ligação.", provedor);
    this.name = "LinhaOcupadaDeLigacao";
  }
}

export class NaoEncontradoDeLigacao extends ErroDeLigacao {
  readonly codigo = "nao_encontrado" as const;
  readonly acao = "marcar_divergencia" as const;
  readonly retentavel = false;
  constructor(provedor: ChaveDeProvedorDeLigacao | null = null) {
    super("O provedor não conhece essa ligação.", provedor);
    this.name = "NaoEncontradoDeLigacao";
  }
}

export class NaoSuportadoDeLigacao extends ErroDeLigacao {
  readonly codigo = "nao_suportado" as const;
  readonly acao = "recusar_a_operacao" as const;
  readonly retentavel = false;
  /** O nome da operação que o provedor não faz (ex.: `originar`). Texto fixo do código, nunca do provedor. */
  readonly operacao: string | null;
  constructor(provedor: ChaveDeProvedorDeLigacao | null = null, operacao: string | null = null) {
    super("O provedor não faz isso. A matriz de capacidades diz o que ele faz.", provedor);
    this.name = "NaoSuportadoDeLigacao";
    this.operacao = operacao !== null && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(operacao) ? operacao : null;
  }
  override toJSON() {
    return { ...super.toJSON(), operacao: this.operacao };
  }
}

export const ehErroDeLigacao = (e: unknown): e is ErroDeLigacao => e instanceof ErroDeLigacao;

/**
 * Garante que o que sai do adaptador é um erro neutro. Erro já neutro passa; tempo esgotado, rede caída
 * e qualquer outra coisa viram `ProvedorIndisponivelDeLigacao`, SEM carregar o erro original.
 */
export function comoErroDeLigacao(e: unknown, provedor: ChaveDeProvedorDeLigacao): ErroDeLigacao {
  if (e instanceof ErroDeLigacao) return e;
  return new ProvedorIndisponivelDeLigacao(provedor);
}

/** Texto curto e seguro para log: só o código e o provedor. Nunca a mensagem do provedor. */
export function erroDeLigacaoParaLog(e: unknown): string {
  if (e instanceof ErroDeLigacao) return e.provedor ? `${e.codigo}(${e.provedor})` : e.codigo;
  // Erro de fora do contrato: só o nome da classe, nunca a mensagem (pode carregar telefone ou chave).
  return e instanceof Error ? `ErroNaoMapeado(${e.name})` : "ErroNaoMapeado";
}
