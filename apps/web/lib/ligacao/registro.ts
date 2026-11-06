import { ErroDoMotor, type MotorDeSoftphone } from "./motor";

/**
 * O REGISTRO dos motores do navegador. Dado o provedor da linha,
 * devolve o motor que liga por ele. O SDK de cada provedor só baixa na primeira ligação (`import()` dinâmico):
 * quem nunca liga não paga o peso.
 *
 * Quem acrescenta um motor: a F2-13 registra `api4com` e a F4-06 registra `whatsapp_cloud`, cada um com a sua
 * linha em `CARREGADORES`.
 *
 * A chave `fake` só existe com `modoFake` verdadeiro. Esse valor vem do SERVIDOR (layout, F3-03) e nunca de uma
 * variável pública do Next (as que começam com NEXT e PUBLIC), que qualquer um poderia ligar no navegador.
 */

export type OpcoesDoRegistro = { modoFake: boolean };

type Carregador = () => Promise<MotorDeSoftphone>;

/** Os motores de provedor real. Vazio até a F2-13. */
const CARREGADORES = new Map<string, Carregador>();

const CARREGADOR_DO_FAKE: Carregador = async () => (await import("./motores/fake")).criarMotorFake();

/** As chaves que `carregarMotor` aceita agora. */
export function chavesDeMotor(opcoes: OpcoesDoRegistro): string[] {
  return [...CARREGADORES.keys(), ...(opcoes.modoFake ? ["fake"] : [])];
}

/**
 * Carrega o motor do provedor. Chave desconhecida, ou `fake` fora do modo Fake, rejeita com
 * `ErroDoMotor("navegador_sem_suporte")`: para a tela, é um navegador que não sabe ligar por esse caminho.
 */
export async function carregarMotor(provedor: string, opcoes: OpcoesDoRegistro): Promise<MotorDeSoftphone> {
  if (provedor === "fake") {
    if (!opcoes.modoFake) throw new ErroDoMotor("navegador_sem_suporte");
    return CARREGADOR_DO_FAKE();
  }
  const carregador = CARREGADORES.get(provedor);
  if (!carregador) throw new ErroDoMotor("navegador_sem_suporte");
  return carregador();
}
