import {
  callIdDoEstado,
  ESTADO_LIVRE,
  ligacaoViva,
  reduzir,
  type AcaoDaLigacao,
  type ContatoDaLigacao,
  type EstadoDaLigacao,
  type ResultadoDaLigacao,
} from "./estado";
import type { FonteDoProximo } from "./fila";
import { codigoDoErroDoMotor, ehErroDoMotor, ErroDoMotor, TAMANHO_MAXIMO_DO_ANEXO, type CapacidadesDoMotor, type CredencialDoNavegador, type EventoDoMotor, type MotorDeSoftphone } from "./motor";

/**
 * A LOJA DA LIGAÇÃO. Guarda o estado fora da árvore React, num módulo,
 * para a ligação não cair quando o vendedor navega: a barra (F3-03) assina com `useSyncExternalStore`.
 *
 * Conduz a ligação: carrega o motor do provedor, pede ao servidor pelas `acoes` (a F3-02 as implementa com `fetch`
 * às rotas `/api/calls/*`), repassa os eventos do motor ao `reduzir` e limpa tudo no fim.
 *
 * O que a loja NUNCA faz:
 *  - mandar telefone, duração, status, resultado ou confirmação de opt-out ao servidor (o pedido tem só o
 *    contato, a linha, o identificador e o anexo do motor);
 *  - guardar a credencial: ela passa do servidor ao motor e não fica no estado nem em variável da loja;
 *  - consultar o servidor em intervalo (o estado ao vivo vem do motor; a espera do resultado é da F3-04).
 */

/** O pedido de ligação. Só isto sai do navegador: o destino o servidor lê do banco. */
export type PedidoDeInicio = {
  contactId: string;
  linhaId?: string;
  identificadorId?: string;
  /** O que o `preparar()` do motor devolveu (a oferta de áudio do WhatsApp, por exemplo). */
  anexo?: string;
};

export type RespostaDoInicio =
  | {
      ok: true;
      callId: string;
      provedor: string;
      linhaRotulo: string | null;
      gravando: boolean;
      credencialDoNavegador: CredencialDoNavegador | null;
    }
  /** `codigo` é o código neutro da recusa (a F3-05 o leva a um passo de tela). */
  | { ok: false; codigo: string };

/** As três coisas que o navegador pede ao servidor. A F3-02 as implementa; `acoes-falsas.ts` as simula. */
export interface AcoesDaLigacao {
  iniciar(pedido: PedidoDeInicio): Promise<RespostaDoInicio>;
  encerrar(callId: string): Promise<void>;
  /** O que o servidor sabe da ligação, ou nulo se ainda não há fato. */
  ler(callId: string): Promise<ResultadoDaLigacao | null>;
}

export type DependenciasDaLoja = {
  acoes: AcoesDaLigacao;
  /** Dado o provedor, devolve o motor (o registro, com o `modoFake` do servidor). */
  carregarMotor: (provedor: string) => Promise<MotorDeSoftphone>;
  agora: () => number;
};

export type OpcoesDeLigar = {
  linhaId?: string;
  identificadorId?: string;
  /**
   * O provedor da linha, quando a tela já sabe (a lista de linhas do BotaoLigar). Com ele, o motor é carregado e
   * preparado ANTES do pedido, e o anexo vai junto. Sem ele, o servidor escolhe a linha e a resposta diz o provedor.
   */
  provedor?: string;
};

export interface LojaDaLigacao {
  /** O estado de agora. O mesmo objeto até mudar (serve de `getSnapshot`). */
  ler(): EstadoDaLigacao;
  assinar(ouvinte: () => void): () => void;
  /** Pede uma ligação. `false` = ignorado, porque já há uma ligação (ou um fim ainda aberto). */
  ligar(contato: ContatoDaLigacao, opcoes?: OpcoesDeLigar): Promise<boolean>;
  desligar(): Promise<void>;
  silenciar(mudo: boolean): void;
  /** Fecha o fim, a exceção ou o erro e libera o motor. A loja volta a `livre`. */
  concluir(): void;
  definirFonteDoProximo(fonte: FonteDoProximo | null): void;
  lerFonte(): FonteDoProximo | null;
  /** A F3-04 leva aqui o que o servidor respondeu depois do fim. */
  informarResultado(callId: string, resultado: ResultadoDaLigacao): void;
}

/** Roda e engole o erro: o que a loja faz "por melhor esforço" não pode derrubar a ligação. */
async function seguro(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    // Melhor esforço: o servidor aprende o fim pelo provedor de qualquer jeito.
  }
}

const bytesDe = (texto: string) => new TextEncoder().encode(texto).length;

/** Para a ligação que o vendedor cancelou antes de haver motor: ela só é encerrada, nada é oferecido na barra. */
const SEM_CAPACIDADES: Readonly<CapacidadesDoMotor> = Object.freeze({ mudo: false, teclado: false, aoVivo: false });

export function criarLoja({ acoes, carregarMotor, agora }: DependenciasDaLoja): LojaDaLigacao {
  let estado: EstadoDaLigacao = ESTADO_LIVRE;
  let fonte: FonteDoProximo | null = null;
  const ouvintes = new Set<() => void>();
  let motor: MotorDeSoftphone | null = null;
  let cancelarEventos: (() => void) | null = null;
  /** Sobe a cada `ligar` e a cada `concluir`: o fluxo antigo, que ainda espera um `await`, percebe e para. */
  let geracao = 0;

  const avisar = () => {
    for (const ouvinte of [...ouvintes]) {
      try {
        ouvinte();
      } catch {
        // Um assinante com defeito não derruba a ligação nem os outros assinantes.
      }
    }
  };

  const despachar = (acao: AcaoDaLigacao) => {
    const proximo = reduzir(estado, acao);
    if (proximo === estado) return;
    estado = proximo;
    avisar();
  };

  const soltarMotor = () => {
    const m = motor;
    const cancelar = cancelarEventos;
    motor = null;
    cancelarEventos = null;
    try {
      cancelar?.();
    } catch {
      // A assinatura já estava solta.
    }
    try {
      m?.liberar();
    } catch {
      // `liberar` é idempotente e melhor esforço.
    }
  };

  const aoEventoDoMotor = (evento: EventoDoMotor) => {
    const antes = estado;
    despachar({ tipo: "evento", evento, agora: agora() });
    // O motor desistiu no meio da ligação: solta o motor e avisa o servidor, para a linha não ficar tocando.
    if (estado.fase === "erro" && antes.fase !== "erro" && ligacaoViva(antes)) {
      const callId = callIdDoEstado(antes);
      soltarMotor();
      if (callId) void seguro(() => acoes.encerrar(callId));
    }
  };

  const adotar = (m: MotorDeSoftphone) => {
    motor = m;
    cancelarEventos = m.aoEvento(aoEventoDoMotor);
  };

  /** Carrega, adota e prepara o motor do provedor. Devolve o anexo do pedido. Só lança `ErroDoMotor`. */
  const prepararMotor = async (provedor: string): Promise<string | undefined> => {
    let m: MotorDeSoftphone;
    try {
      m = await carregarMotor(provedor);
    } catch (e) {
      // Sem motor para a chave, ou o SDK não baixou (rede).
      throw new ErroDoMotor(codigoDoErroDoMotor(e, "conexao_caiu"));
    }
    adotar(m);
    let anexo: string | undefined;
    try {
      anexo = (await m.preparar()).anexo;
    } catch (e) {
      throw new ErroDoMotor(codigoDoErroDoMotor(e, "provedor"));
    }
    if (anexo !== undefined && bytesDe(anexo) > TAMANHO_MAXIMO_DO_ANEXO) throw new ErroDoMotor("provedor");
    return anexo;
  };

  async function ligar(contato: ContatoDaLigacao, opcoes: OpcoesDeLigar = {}): Promise<boolean> {
    if (estado.fase !== "livre") return false;
    const minha = ++geracao;
    try {
      await conduzir(contato, opcoes, minha);
    } catch (e) {
      // Defeito que ninguém previu (uma ação que devolve lixo, por exemplo). A tela não pode ficar presa em
      // "pedindo", sem saída, com o motor aberto: vira erro, solta o motor e avisa o servidor.
      if (minha !== geracao || !ligacaoViva(estado)) return true;
      const callId = callIdDoEstado(estado);
      soltarMotor();
      despachar({ tipo: "falhou", codigo: ehErroDoMotor(e) ? e.codigo : "sem_resposta" });
      if (callId) void seguro(() => acoes.encerrar(callId));
    }
    return true;
  }

  /** O caminho da ligação, do pedido ao `iniciar` do motor. `minha` é a geração que o `ligar` abriu. */
  async function conduzir(contato: ContatoDaLigacao, opcoes: OpcoesDeLigar, minha: number): Promise<void> {
    const cancelando = () => estado.fase === "pedindo" && estado.cancelando;
    despachar({ tipo: "pedir", contato });

    // 1. Provedor já conhecido: o motor abre o microfone e prepara o anexo antes de o servidor ser chamado.
    let anexo: string | undefined;
    if (opcoes.provedor) {
      try {
        anexo = await prepararMotor(opcoes.provedor);
      } catch (e) {
        soltarMotor();
        despachar({ tipo: "falhou", codigo: codigoDoErroDoMotor(e, "provedor") });
        return;
      }
      if (cancelando()) {
        soltarMotor();
        despachar({ tipo: "desistir" });
        return;
      }
    }

    // 2. O pedido. O destino é lido do banco pelo servidor: aqui só vão ids.
    const pedido: PedidoDeInicio = { contactId: contato.id };
    if (opcoes.linhaId) pedido.linhaId = opcoes.linhaId;
    if (opcoes.identificadorId) pedido.identificadorId = opcoes.identificadorId;
    if (anexo !== undefined) pedido.anexo = anexo;

    let resposta: RespostaDoInicio;
    try {
      resposta = await acoes.iniciar(pedido);
    } catch {
      soltarMotor();
      despachar({ tipo: "falhou", codigo: "sem_resposta" });
      return;
    }
    if (!resposta.ok) {
      soltarMotor();
      despachar({ tipo: "pedido_recusado", codigo: resposta.codigo });
      return;
    }
    const { callId, provedor, credencialDoNavegador } = resposta;

    // 3. O motor certo. Se a tela não sabia o provedor, ou o servidor escolheu outro, carrega agora (o anexo,
    //    se houver, já não vale: o pedido saiu sem ele). Quem já desligou não ganha um pedido de microfone
    //    para uma ligação que cancelou: ela só é encerrada, sem motor.
    if (!motor || motor.chave !== provedor) {
      soltarMotor();
      if (!cancelando()) {
        try {
          await prepararMotor(provedor);
        } catch (e) {
          soltarMotor();
          void seguro(() => acoes.encerrar(callId));
          despachar({ tipo: "falhou", codigo: codigoDoErroDoMotor(e, "provedor"), callId });
          return;
        }
      }
    }

    // 4. O vendedor desligou enquanto o pedido ia: a ligação existe no servidor, então encerra e mostra o fim.
    const jaDesligou = cancelando();
    const motorAtual = motor;
    despachar({ tipo: "pedido_aceito", callId, provedor, linhaRotulo: resposta.linhaRotulo, gravando: resposta.gravando, capacidades: motorAtual?.capacidades ?? SEM_CAPACIDADES });
    if (jaDesligou) {
      despachar({ tipo: "desligou", agora: agora() });
      soltarMotor();
      void seguro(() => acoes.encerrar(callId));
      return;
    }
    // Sem desistência e sem motor não se chega aqui; se chegar, o `ligar` trata como falha do provedor.
    if (!motorAtual) throw new ErroDoMotor("provedor");

    // 5. Começa. A credencial vai direto ao motor e não fica em lugar nenhum da loja.
    try {
      await motorAtual.iniciar({ callId, credencialDoNavegador });
    } catch (e) {
      // Se o vendedor já concluiu o fim e começou outra ligação, este fluxo é velho e não mexe em nada.
      if (minha !== geracao) return;
      const antes = estado;
      despachar({ tipo: "falhou", codigo: codigoDoErroDoMotor(e, "provedor") });
      soltarMotor();
      if (ligacaoViva(antes)) void seguro(() => acoes.encerrar(callId));
    }
  }

  async function desligar(): Promise<void> {
    const atual = estado;
    if (atual.fase === "pedindo") {
      despachar({ tipo: "cancelar_pedido" });
      return;
    }
    if (atual.fase !== "preparando" && atual.fase !== "chamando" && atual.fase !== "em_conversa") return;
    const { callId } = atual;
    const m = motor;
    // Primeiro a tela (um segundo desligar já não faz nada); depois o motor e o servidor, por melhor esforço.
    despachar({ tipo: "desligou", agora: agora() });
    await Promise.all([seguro(() => m?.desligar()), seguro(() => acoes.encerrar(callId))]);
  }

  function silenciar(mudo: boolean): void {
    if (estado.fase !== "em_conversa" || !estado.capacidades.mudo || estado.mudo === mudo || !motor) return;
    try {
      motor.silenciar(mudo);
    } catch {
      // O motor não conseguiu: a tela não finge que silenciou.
      return;
    }
    despachar({ tipo: "silenciar", mudo });
  }

  function concluir(): void {
    if (estado.fase !== "encerrada" && estado.fase !== "excecao" && estado.fase !== "erro") return;
    geracao++;
    soltarMotor();
    despachar({ tipo: "concluir" });
  }

  return {
    ler: () => estado,
    assinar(ouvinte) {
      ouvintes.add(ouvinte);
      return () => {
        ouvintes.delete(ouvinte);
      };
    },
    ligar,
    desligar,
    silenciar,
    concluir,
    definirFonteDoProximo(nova) {
      fonte = nova;
      avisar();
    },
    lerFonte: () => fonte,
    informarResultado(callId, resultado) {
      despachar({ tipo: "resultado", callId, resultado });
    },
  };
}

/** Chave do singleton da aba. `Symbol.for` sobrevive a duas cópias do módulo (chunks) e ao reload de dev. */
const CHAVE_DA_LOJA = Symbol.for("crmagro.ligacao.loja");

export class LojaDaLigacaoNaoCriada extends Error {
  constructor() {
    super("A loja da ligação ainda não foi criada nesta aba.");
    this.name = "LojaDaLigacaoNaoCriada";
  }
}

/**
 * A loja da aba: UMA por aba, fora do React. A primeira chamada, com as dependências, a cria (o
 * `LigacaoProvider` da F3-03); as seguintes devolvem a mesma. No servidor (sem `window`) nunca há singleton: a
 * renderização do servidor atende vários vendedores e o estado de uma ligação não pode passar de um para outro.
 */
export function lojaDaLigacao(deps?: DependenciasDaLoja): LojaDaLigacao {
  if (typeof window === "undefined") {
    if (!deps) throw new LojaDaLigacaoNaoCriada();
    return criarLoja(deps);
  }
  const g = globalThis as unknown as Record<symbol, LojaDaLigacao | undefined>;
  const existente = g[CHAVE_DA_LOJA];
  if (existente) return existente;
  if (!deps) throw new LojaDaLigacaoNaoCriada();
  const nova = criarLoja(deps);
  g[CHAVE_DA_LOJA] = nova;
  return nova;
}

/** Só para teste: esquece a loja da aba. */
export function esquecerLojaDaLigacao(): void {
  (globalThis as unknown as Record<symbol, LojaDaLigacao | undefined>)[CHAVE_DA_LOJA] = undefined;
}
