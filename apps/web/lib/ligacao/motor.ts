/**
 * O CONTRATO DO MOTOR DE SOFTPHONE.
 *
 * O vendedor liga do mesmo jeito por qualquer provedor (API4COM, Twilio, WhatsApp oficial). Cada provedor
 * traz o seu motor no navegador, que implementa esta interface e se registra em `registro.ts`. A loja
 * (`loja.ts`) e a barra de ligação só conhecem este contrato.
 *
 * Regras do motor, valem para todo motor:
 *  - o motor NUNCA decide o resultado da ligação. Quem diz como terminou é o provedor, pelo servidor;
 *  - o motor NUNCA manda duração ao servidor (o cronômetro da tela é só de exibição);
 *  - o motor NUNCA guarda telefone. O destino é lido do banco pelo servidor e o navegador não o conhece;
 *  - o motor NUNCA repassa texto livre do SDK. O que sobe para a loja é um código fechado
 *    (`CodigoDoMotor`, `MotivoLocalDoFim`); texto de SDK pode ter número de telefone e nome;
 *  - o motor só existe durante a ligação: a loja o cria no `ligar` e chama `liberar()` no `concluir`.
 *    Não há registro permanente, por isso também não há "aba líder" neste contrato;
 *  - a credencial (`CredencialDoNavegador`) fica só na memória do motor. Nunca vai para
 *    localStorage, sessionStorage, cookie, log nem estado da loja;
 *  - ao emitir `encerrada` ou `erro`, o motor já soltou microfone e áudio. `liberar()` solta o que sobrou
 *    (assinaturas, SDK) e pode ser chamado mais de uma vez.
 *
 * Sequência de uma ligação (a loja conduz):
 *   1. `preparar()`: abre o microfone e, se o provedor precisar, devolve um anexo para o pedido
 *      (por exemplo, a oferta de áudio do WhatsApp). Roda ANTES do pedido ao servidor quando a loja já
 *      sabe o provedor, e logo depois da resposta quando não sabe (nesse caso o anexo não é usado);
 *   2. o servidor cria a ligação e devolve `callId` e, se o provedor pedir, a credencial;
 *   3. `iniciar({ callId, credencialDoNavegador })`: o motor passa a emitir eventos com esse `callId`.
 *
 * Nada aqui roda no servidor e nada aqui é Node-only: o arquivo é carregado no navegador.
 */

/** Credencial que o servidor entrega ao navegador para abrir a voz. Mesmo formato da F2-02. */
export type CredencialDoNavegador =
  | { tipo: "sip_wss"; servidor: string; realm: string; usuario: string; senha: string }
  | { tipo: "token"; token: string; validaAte: string };

/** O que o motor sabe fazer. A barra só oferece o que a capacidade permite. */
export type CapacidadesDoMotor = {
  /** Dá para silenciar o microfone durante a conversa. */
  mudo: boolean;
  /** Aceita teclas (`digito`), por exemplo para a URA de uma empresa. */
  teclado: boolean;
  /** Avisa "chamando" e "atendida" enquanto a ligação acontece. Sem isso, só avisa o fim. */
  aoVivo: boolean;
};

/** Por que o motor não conseguiu ligar ou seguir ligando. Lista fechada: cada código tem texto em `texto.ts`. */
export const CODIGOS_DO_MOTOR = ["microfone_negado", "sem_microfone", "navegador_sem_suporte", "sem_audio", "conexao_caiu", "provedor"] as const;
export type CodigoDoMotor = (typeof CODIGOS_DO_MOTOR)[number];

/** Como o motor viu a ligação terminar. É só o lado do navegador; o resultado vale o do provedor. */
export const MOTIVOS_LOCAIS_DO_FIM = ["desligou", "contato_desligou", "falha_de_rede", "desconhecido"] as const;
export type MotivoLocalDoFim = (typeof MOTIVOS_LOCAIS_DO_FIM)[number];

/**
 * O que o motor conta para a loja. Todo evento leva o `callId` da ligação a que pertence: a loja ignora o
 * que vier de outra ligação (um motor antigo que demora a calar não mexe na ligação nova).
 */
export type EventoDoMotor =
  | { tipo: "chamando"; callId: string }
  /** `em` é o instante em que o SDK viu o atendimento (milissegundos desde 1970). */
  | { tipo: "atendida"; callId: string; em: number }
  | { tipo: "encerrada"; callId: string; motivoLocal: MotivoLocalDoFim }
  | { tipo: "erro"; callId: string; codigo: CodigoDoMotor };

/** Tamanho máximo do anexo do `preparar()`, em bytes. O servidor recusa acima disso. */
export const TAMANHO_MAXIMO_DO_ANEXO = 16 * 1024;

export interface MotorDeSoftphone {
  /** A chave do provedor que este motor atende (`api4com`, `whatsapp_cloud`, `fake`). */
  readonly chave: string;
  readonly capacidades: Readonly<CapacidadesDoMotor>;
  /** Abre o microfone e devolve o anexo do pedido, se houver. Rejeita com `ErroDoMotor`. */
  preparar(): Promise<{ anexo?: string }>;
  /** Começa a ligação que o servidor já criou. Rejeita com `ErroDoMotor`. */
  iniciar(p: { callId: string; credencialDoNavegador: CredencialDoNavegador | null }): Promise<void>;
  /** Desliga. Pode ser chamado em qualquer momento da ligação. */
  desligar(): Promise<void>;
  silenciar(mudo: boolean): void;
  /** Só existe com a capacidade `teclado`. */
  digito?(d: string): void;
  /** Assina os eventos. Devolve a função que cancela a assinatura. */
  aoEvento(cb: (e: EventoDoMotor) => void): () => void;
  /** Solta tudo. Idempotente. Depois dela o motor não emite mais nada. */
  liberar(): void;
}

/**
 * O único erro que um motor deixa escapar. Carrega só o código fechado; a mensagem é o próprio código
 * (serve para o log, nunca para a tela, que usa `mensagemDoCodigoDoMotor`). Nada do texto do SDK entra aqui.
 */
export class ErroDoMotor extends Error {
  readonly codigo: CodigoDoMotor;
  constructor(codigo: CodigoDoMotor) {
    super(codigo);
    this.name = "ErroDoMotor";
    this.codigo = codigo;
  }
}

/** Reconhece o erro do motor mesmo quando duas cópias do módulo (dois chunks) criaram a classe. */
export function ehErroDoMotor(e: unknown): e is ErroDoMotor {
  if (e instanceof ErroDoMotor) return true;
  if (typeof e !== "object" || e === null) return false;
  const { name, codigo } = e as { name?: unknown; codigo?: unknown };
  return name === "ErroDoMotor" && typeof codigo === "string" && (CODIGOS_DO_MOTOR as readonly string[]).includes(codigo);
}

/** O código de qualquer coisa que um motor lançou: o do `ErroDoMotor`, ou `padrao` para o resto. */
export function codigoDoErroDoMotor(e: unknown, padrao: CodigoDoMotor): CodigoDoMotor {
  return ehErroDoMotor(e) ? e.codigo : padrao;
}
