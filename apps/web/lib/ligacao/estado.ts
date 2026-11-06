import type { CapacidadesDoMotor, CodigoDoMotor, EventoDoMotor, MotivoLocalDoFim } from "./motor";

/**
 * O estado da ligação do vendedor e a função pura que o move.
 *
 * Fica fora do React, no módulo da loja (`loja.ts`), para a ligação não cair quando o vendedor navega.
 * Tudo aqui é puro e testável sem DOM: `reduzir(estado, acao)` devolve o MESMO objeto quando a ação não
 * se aplica (a loja usa isso para não avisar os assinantes à toa).
 *
 * Invariantes:
 *  - uma ligação por vez: só se pede de `livre`;
 *  - `mudo` só existe em conversa, e só se o motor sabe silenciar;
 *  - de `encerrada` (e de `excecao` e `erro`) só se sai por `concluir`;
 *  - evento de outro `callId` é ignorado;
 *  - o estado não guarda telefone, credencial nem texto do SDK.
 *
 * O resultado da ligação (`ResultadoDaLigacao`) vem do servidor, que o recebe do provedor. Nada aqui o decide.
 */

export const FASES_DA_LIGACAO = ["livre", "pedindo", "preparando", "chamando", "em_conversa", "encerrada", "excecao", "erro"] as const;
export type FaseDaLigacao = (typeof FASES_DA_LIGACAO)[number];

export type ContatoDaLigacao = { id: string; nome: string };

/** Falha técnica da ligação: as do motor, mais o servidor que não respondeu. */
export type CodigoDeErroDaLigacao = CodigoDoMotor | "sem_resposta";

/**
 * O recorte do que o servidor sabe sobre a ligação que a barra mostra (o `LigacaoDTO` da F3-02 cabe aqui).
 * `provisorio` quer dizer que o fim chegou mas ainda não foi aplicado: não comprova nada nem conta em placar.
 */
export type ResultadoDaLigacao = {
  /** Como o provedor disse que terminou (`answered`, `no_answer`, `busy`...), ou nulo enquanto não houver fim. */
  outcome: string | null;
  motivo: string | null;
  duracaoS: number | null;
  comprovada: boolean;
  conversa: boolean;
  provisorio: boolean;
  /** Situação da gravação (`salva`, `aguardando`, `nao_pedida`...). */
  gravacao: string;
};

/** O que se sabe de uma ligação que o servidor já criou. */
type LigacaoNoAr = {
  contato: ContatoDaLigacao;
  callId: string;
  provedor: string;
  linhaRotulo: string | null;
  /** O pedido disse que esta ligação é gravada. */
  gravando: boolean;
  capacidades: Readonly<CapacidadesDoMotor>;
};

export type EstadoDaLigacao =
  | { fase: "livre" }
  /** O pedido está saindo (e o motor sendo carregado). `cancelando`: o vendedor já pediu para desligar. */
  | { fase: "pedindo"; contato: ContatoDaLigacao; cancelando: boolean }
  /** O servidor criou a ligação e o motor está começando. */
  | ({ fase: "preparando" } & LigacaoNoAr)
  | ({ fase: "chamando" } & LigacaoNoAr)
  /** `atendidaEm`: instante do SDK, só para o cronômetro. */
  | ({ fase: "em_conversa"; atendidaEm: number; mudo: boolean } & LigacaoNoAr)
  /** Acabou. `resultado` nulo = esperando o servidor; preenchido = o que o servidor sabe até agora. */
  | ({ fase: "encerrada"; atendidaEm: number | null; encerradaEm: number; motivoLocal: MotivoLocalDoFim; resultado: ResultadoDaLigacao | null } & LigacaoNoAr)
  /** O servidor recusou ligar (sem linha, contato que pediu para não ser procurado...). Tratada na F3-05. */
  | { fase: "excecao"; contato: ContatoDaLigacao; codigo: string }
  /** Falha técnica. `callId` nulo = o servidor não chegou a criar a ligação (ou a falha veio antes de ele responder). */
  | { fase: "erro"; contato: ContatoDaLigacao; codigo: CodigoDeErroDaLigacao; callId: string | null };

export type AcaoDaLigacao =
  | { tipo: "pedir"; contato: ContatoDaLigacao }
  /** O vendedor desligou enquanto o pedido ainda saía. */
  | { tipo: "cancelar_pedido" }
  /** Cancelou antes de o servidor ser chamado: volta a `livre`. */
  | { tipo: "desistir" }
  | { tipo: "pedido_aceito"; callId: string; provedor: string; linhaRotulo: string | null; gravando: boolean; capacidades: Readonly<CapacidadesDoMotor> }
  | { tipo: "pedido_recusado"; codigo: string }
  /** `callId`: a ligação que o servidor já criou, quando a falha vem antes de o estado saber dela (motor que não carregou). */
  | { tipo: "falhou"; codigo: CodigoDeErroDaLigacao; callId?: string }
  | { tipo: "evento"; evento: EventoDoMotor; agora: number }
  | { tipo: "silenciar"; mudo: boolean }
  /** O vendedor desligou. */
  | { tipo: "desligou"; agora: number }
  | { tipo: "resultado"; callId: string; resultado: ResultadoDaLigacao }
  | { tipo: "concluir" };

export const ESTADO_LIVRE: EstadoDaLigacao = Object.freeze({ fase: "livre" });

/** Há ligação em curso, ou prestes a existir: pedindo, preparando, chamando ou em conversa. */
export function ligacaoViva(e: EstadoDaLigacao): boolean {
  return e.fase === "pedindo" || e.fase === "preparando" || e.fase === "chamando" || e.fase === "em_conversa";
}

/** A loja está ocupada com alguma coisa (inclusive o fim e as telas de erro): não se pede outra ligação. */
export function ligacaoOcupada(e: EstadoDaLigacao): boolean {
  return e.fase !== "livre";
}

export function callIdDoEstado(e: EstadoDaLigacao): string | null {
  switch (e.fase) {
    case "preparando":
    case "chamando":
    case "em_conversa":
    case "encerrada":
    case "erro":
      return e.callId;
    case "livre":
    case "pedindo":
    case "excecao":
      return null;
  }
}

/** Os campos de uma ligação no ar, tirados de um estado que os tem. */
function dadosDaLigacao(e: LigacaoNoAr): LigacaoNoAr {
  return { contato: e.contato, callId: e.callId, provedor: e.provedor, linhaRotulo: e.linhaRotulo, gravando: e.gravando, capacidades: e.capacidades };
}

/** Um evento do motor da ligação que está no ar (o `callId` já foi conferido por quem chama). */
function reduzirEvento(estado: Extract<EstadoDaLigacao, { fase: "preparando" | "chamando" | "em_conversa" }>, ev: EventoDoMotor, agora: number): EstadoDaLigacao {
  switch (ev.tipo) {
    case "chamando":
      return estado.fase === "preparando" ? { ...dadosDaLigacao(estado), fase: "chamando" } : estado;
    case "atendida":
      // Alguns SDKs atendem sem avisar "chamando" antes: aceita de `preparando` também.
      return estado.fase === "em_conversa" ? estado : { ...dadosDaLigacao(estado), fase: "em_conversa", atendidaEm: ev.em, mudo: false };
    case "encerrada":
      return {
        ...dadosDaLigacao(estado),
        fase: "encerrada",
        atendidaEm: estado.fase === "em_conversa" ? estado.atendidaEm : null,
        encerradaEm: agora,
        motivoLocal: ev.motivoLocal,
        resultado: null,
      };
    case "erro":
      return { fase: "erro", contato: estado.contato, codigo: ev.codigo, callId: estado.callId };
  }
}

export function reduzir(estado: EstadoDaLigacao, acao: AcaoDaLigacao): EstadoDaLigacao {
  switch (acao.tipo) {
    case "pedir":
      return estado.fase === "livre" ? { fase: "pedindo", contato: acao.contato, cancelando: false } : estado;

    case "cancelar_pedido":
      return estado.fase === "pedindo" && !estado.cancelando ? { ...estado, cancelando: true } : estado;

    case "desistir":
      return estado.fase === "pedindo" && estado.cancelando ? ESTADO_LIVRE : estado;

    case "pedido_aceito":
      if (estado.fase !== "pedindo") return estado;
      return {
        fase: "preparando",
        contato: estado.contato,
        callId: acao.callId,
        provedor: acao.provedor,
        linhaRotulo: acao.linhaRotulo,
        gravando: acao.gravando,
        capacidades: acao.capacidades,
      };

    case "pedido_recusado":
      if (estado.fase !== "pedindo") return estado;
      // Quem já tinha desligado não precisa ver a recusa.
      return estado.cancelando ? ESTADO_LIVRE : { fase: "excecao", contato: estado.contato, codigo: acao.codigo };

    case "falhou":
      switch (estado.fase) {
        case "pedindo":
          return estado.cancelando ? ESTADO_LIVRE : { fase: "erro", contato: estado.contato, codigo: acao.codigo, callId: acao.callId ?? null };
        case "preparando":
        case "chamando":
        case "em_conversa":
          return { fase: "erro", contato: estado.contato, codigo: acao.codigo, callId: estado.callId };
        default:
          return estado;
      }

    case "evento":
      if (estado.fase !== "preparando" && estado.fase !== "chamando" && estado.fase !== "em_conversa") return estado;
      return acao.evento.callId === estado.callId ? reduzirEvento(estado, acao.evento, acao.agora) : estado;

    case "silenciar":
      return estado.fase === "em_conversa" && estado.capacidades.mudo && estado.mudo !== acao.mudo ? { ...estado, mudo: acao.mudo } : estado;

    case "desligou":
      if (estado.fase !== "preparando" && estado.fase !== "chamando" && estado.fase !== "em_conversa") return estado;
      return {
        ...dadosDaLigacao(estado),
        fase: "encerrada",
        atendidaEm: estado.fase === "em_conversa" ? estado.atendidaEm : null,
        encerradaEm: acao.agora,
        motivoLocal: "desligou",
        resultado: null,
      };

    case "resultado": {
      if (estado.fase !== "encerrada" || estado.callId !== acao.callId) return estado;
      // O que já foi aplicado não volta a provisório (uma leitura atrasada não desfaz a confirmação).
      if (estado.resultado && !estado.resultado.provisorio && acao.resultado.provisorio) return estado;
      return { ...estado, resultado: acao.resultado };
    }

    case "concluir":
      return estado.fase === "encerrada" || estado.fase === "excecao" || estado.fase === "erro" ? ESTADO_LIVRE : estado;
  }
}
