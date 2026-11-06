import { ErroDoMotor, type EventoDoMotor, type MotivoLocalDoFim, type MotorDeSoftphone } from "../motor";

/**
 * O motor FAKE do softphone. Não abre microfone nem rede: conta uma
 * ligação inventada por timers, para os testes e para ver a barra no preview sem provedor.
 *
 * Só existe quando o servidor liga o modo Fake (`registro.ts`, `modoFake`); em produção nunca é carregado.
 * O cenário vem do `localStorage["crmagro:ligacao:fake"]`, lido com try/catch (o storage pode estar bloqueado).
 */

export const CENARIOS_DO_FAKE = ["atende", "nao_atende", "ocupado", "microfone_negado", "cai_no_meio"] as const;
export type CenarioDoFake = (typeof CENARIOS_DO_FAKE)[number];

export const CHAVE_DO_CENARIO_NO_STORAGE = "crmagro:ligacao:fake";

/** Os tempos de cada cenário, em milissegundos. Exportados para o teste não repetir número. */
export const TEMPOS_DO_FAKE = {
  /** Toca isto e atende. */
  toqueAteAtender: 2_000,
  /** Depois de atender, conversa isto (acima dos 30 s que contam como conversa) e o contato desliga. */
  conversa: 35_000,
  /** No cenário `nao_atende`, toca isto e o contato não atende. */
  toqueSemAtender: 8_000,
  /** No cenário `ocupado`, o contato recusa depois disto. */
  ateOcupado: 1_000,
  /** No cenário `cai_no_meio`, a conexão cai isto depois de atender. */
  ateCair: 5_000,
} as const;

/** O cenário guardado no navegador. Qualquer problema (sem storage, valor estranho) vira `atende`. */
export function cenarioSalvo(storage?: Pick<Storage, "getItem"> | null): CenarioDoFake {
  try {
    const origem = storage === undefined ? globalThis.localStorage : storage;
    const valor = origem?.getItem(CHAVE_DO_CENARIO_NO_STORAGE);
    return (CENARIOS_DO_FAKE as readonly (string | null | undefined)[]).includes(valor) ? (valor as CenarioDoFake) : "atende";
  } catch {
    // Storage bloqueado ou ausente: o cenário padrão serve.
    return "atende";
  }
}

export type MotorFake = MotorDeSoftphone & {
  /** O que o motor recebeu, para o teste conferir. */
  readonly mudoAgora: () => boolean;
  readonly digitosRecebidos: () => readonly string[];
  readonly foiLiberado: () => boolean;
};

export type OpcoesDoMotorFake = {
  cenario?: CenarioDoFake;
  /** Relógio do `atendida`. */
  agora?: () => number;
};

const TECLAS = /^[0-9*#]$/;

export function criarMotorFake(opcoes: OpcoesDoMotorFake = {}): MotorFake {
  const cenario = opcoes.cenario ?? cenarioSalvo();
  const agora = opcoes.agora ?? Date.now;
  const ouvintes = new Set<(e: EventoDoMotor) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const digitos: string[] = [];
  let callId: string | null = null;
  let noAr = false;
  let mudo = false;
  let liberado = false;

  const emitir = (evento: EventoDoMotor) => {
    if (liberado) return;
    for (const ouvinte of [...ouvintes]) ouvinte(evento);
  };
  const depois = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!liberado && noAr) fn();
    }, ms);
    timers.add(t);
  };
  const limparTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
  const terminar = (motivoLocal: MotivoLocalDoFim) => {
    if (!noAr || callId === null) return;
    const id = callId;
    noAr = false;
    limparTimers();
    emitir({ tipo: "encerrada", callId: id, motivoLocal });
  };

  return {
    chave: "fake",
    capacidades: { mudo: true, teclado: true, aoVivo: true },

    async preparar() {
      if (liberado) throw new ErroDoMotor("provedor");
      if (cenario === "microfone_negado") throw new ErroDoMotor("microfone_negado");
      return {};
    },

    async iniciar({ callId: id }) {
      if (liberado || noAr || callId !== null) throw new ErroDoMotor("provedor");
      if (cenario === "microfone_negado") throw new ErroDoMotor("microfone_negado");
      callId = id;
      noAr = true;
      depois(0, () => emitir({ tipo: "chamando", callId: id }));
      switch (cenario) {
        case "atende":
          depois(TEMPOS_DO_FAKE.toqueAteAtender, () => emitir({ tipo: "atendida", callId: id, em: agora() }));
          depois(TEMPOS_DO_FAKE.toqueAteAtender + TEMPOS_DO_FAKE.conversa, () => terminar("contato_desligou"));
          break;
        case "nao_atende":
          depois(TEMPOS_DO_FAKE.toqueSemAtender, () => terminar("desconhecido"));
          break;
        case "ocupado":
          depois(TEMPOS_DO_FAKE.ateOcupado, () => terminar("contato_desligou"));
          break;
        case "cai_no_meio":
          depois(TEMPOS_DO_FAKE.toqueAteAtender, () => emitir({ tipo: "atendida", callId: id, em: agora() }));
          depois(TEMPOS_DO_FAKE.toqueAteAtender + TEMPOS_DO_FAKE.ateCair, () => terminar("falha_de_rede"));
          break;
      }
    },

    async desligar() {
      terminar("desligou");
    },

    silenciar(valor) {
      mudo = valor;
    },

    digito(d) {
      if (noAr && TECLAS.test(d)) digitos.push(d);
    },

    aoEvento(cb) {
      ouvintes.add(cb);
      return () => {
        ouvintes.delete(cb);
      };
    },

    liberar() {
      liberado = true;
      noAr = false;
      limparTimers();
      ouvintes.clear();
    },

    mudoAgora: () => mudo,
    digitosRecebidos: () => [...digitos],
    foiLiberado: () => liberado,
  };
}
