import type { AcoesDaLigacao, PedidoDeInicio } from "./loja";
import type { ResultadoDaLigacao } from "./estado";
import type { CredencialDoNavegador } from "./motor";

/**
 * As ações FALSAS da ligação: o servidor simulado em memória, para
 * os testes da loja e para ver a barra no preview antes de as rotas existirem (F3-02). Não faz rede nem toca
 * em banco. Quem usa em tela é o modo Fake, que o servidor liga (F3-03).
 */

export type OpcoesDasAcoesFalsas = {
  /** O provedor que a resposta diz. Padrão `fake`. */
  provedor?: string;
  linhaRotulo?: string | null;
  gravando?: boolean;
  credencialDoNavegador?: CredencialDoNavegador | null;
  /** Se informado, `iniciar` recusa com este código neutro (por exemplo `opt_out`). */
  recusarCom?: string;
  /** Se verdadeiro, `iniciar` falha como se a rede tivesse caído (lança). */
  semResposta?: boolean;
  /** Demora de cada ação, em milissegundos. Padrão 0. */
  atrasoMs?: number;
  /** O que `ler` devolve. Padrão nulo (o servidor ainda não tem o fim). */
  resultado?: ResultadoDaLigacao | null;
};

export type AcoesFalsas = AcoesDaLigacao & {
  /** O que a loja pediu, na ordem, para o teste conferir. */
  readonly pedidos: readonly PedidoDeInicio[];
  readonly encerradas: readonly string[];
  readonly leituras: readonly string[];
};

export function criarAcoesFalsas(opcoes: OpcoesDasAcoesFalsas = {}): AcoesFalsas {
  const pedidos: PedidoDeInicio[] = [];
  const encerradas: string[] = [];
  const leituras: string[] = [];
  let contador = 0;
  const esperar = (): Promise<void> => (opcoes.atrasoMs && opcoes.atrasoMs > 0 ? new Promise((resolve) => setTimeout(resolve, opcoes.atrasoMs)) : Promise.resolve());

  return {
    pedidos,
    encerradas,
    leituras,

    async iniciar(pedido) {
      pedidos.push({ ...pedido });
      await esperar();
      if (opcoes.semResposta) throw new Error("sem resposta");
      if (opcoes.recusarCom) return { ok: false, codigo: opcoes.recusarCom };
      contador += 1;
      return {
        ok: true,
        callId: `fake-call-${contador}`,
        provedor: opcoes.provedor ?? "fake",
        linhaRotulo: opcoes.linhaRotulo === undefined ? "Linha de teste" : opcoes.linhaRotulo,
        gravando: opcoes.gravando ?? false,
        credencialDoNavegador: opcoes.credencialDoNavegador ?? null,
      };
    },

    async encerrar(callId) {
      encerradas.push(callId);
      await esperar();
    },

    async ler(callId) {
      leituras.push(callId);
      await esperar();
      return opcoes.resultado ?? null;
    },
  };
}
