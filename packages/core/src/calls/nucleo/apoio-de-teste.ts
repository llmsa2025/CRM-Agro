import { definirCapacidadesDeLigacao, type CapacidadesDeLigacao } from "../provedor/capacidades";
import type { CausaDeLigacao, FatoDeLigacao } from "../provedor/fato";
import { matrizDeTeste } from "../provedor/apoio-de-teste";
import { entradaDaLinhaDoTempoDeLigacao, type EntradaDaLinhaDoTempoDeLigacao, type OrigemDeFatoDeLigacao } from "./linha-do-tempo";

/**
 * Apoio SÓ dos testes do núcleo (F1B-08): monta fatos e entradas da linha do tempo com o relógio em segundos
 * a partir de um instante fixo, e gera permutações. Nada daqui entra no barrel.
 */

export const INICIO_DE_TESTE = Date.parse("2026-10-18T12:00:00-03:00");

/** O instante `s` segundos depois do início, em ISO 8601 com fuso. */
export const em = (s: number): string => new Date(INICIO_DE_TESTE + s * 1000).toISOString();

type Extras = { atendidaEm?: number; duracaoConectadaS?: number };

/** Uma entrada da linha do tempo. O `id` é o do adaptador; a caixa acrescenta a origem. */
export function entradaDeTeste(origem: OrigemDeFatoDeLigacao, id: string, s: number, tipo: "chamando" | "atendida" | "recusada"): EntradaDaLinhaDoTempoDeLigacao;
export function entradaDeTeste(
  origem: OrigemDeFatoDeLigacao,
  id: string,
  s: number,
  tipo: "encerrada" | "falhou_ao_originar",
  causa: CausaDeLigacao,
  extras?: Extras,
): EntradaDaLinhaDoTempoDeLigacao;
export function entradaDeTeste(origem: OrigemDeFatoDeLigacao, id: string, s: number, tipo: string, causa?: CausaDeLigacao, extras: Extras = {}): EntradaDaLinhaDoTempoDeLigacao {
  const base = { idEvento: id, ocorridoEm: em(s), providerCallId: "pc_1" };
  let fato: FatoDeLigacao;
  if (tipo === "encerrada") {
    fato = {
      ...base,
      tipo,
      causa: causa!,
      ...(extras.atendidaEm !== undefined ? { atendidaEm: em(extras.atendidaEm) } : {}),
      ...(extras.duracaoConectadaS !== undefined ? { duracaoConectadaS: extras.duracaoConectadaS } : {}),
    };
  } else if (tipo === "falhou_ao_originar") {
    fato = { ...base, tipo, causa: causa! };
  } else {
    fato = { ...base, tipo: tipo as "chamando" | "atendida" | "recusada" };
  }
  return entradaDaLinhaDoTempoDeLigacao(origem, fato);
}

/** Atalhos: o mesmo `id` por origem vira `webhook:id`, `consulta:id`, `crmagro:id`. */
export const webhook = (id: string, s: number, tipo: "chamando" | "atendida" | "recusada") => entradaDeTeste("webhook", id, s, tipo);
export const consulta = (id: string, s: number, tipo: "chamando" | "atendida" | "recusada") => entradaDeTeste("consulta", id, s, tipo);

export const fimDoWebhook = (id: string, s: number, causa: CausaDeLigacao, extras?: Extras) => entradaDeTeste("webhook", id, s, "encerrada", causa, extras);
export const fimDaConsulta = (id: string, s: number, causa: CausaDeLigacao, extras?: Extras) => entradaDeTeste("consulta", id, s, "encerrada", causa, extras);
export const fimDoCrmAgro = (id: string, s: number, causa: CausaDeLigacao, extras?: Extras) => entradaDeTeste("crmagro", id, s, "encerrada", causa, extras);

/** Uma matriz válida, com troca pontual. Por padrão: URL assinada, com consulta, causa do fim NÃO garantida. */
export const matriz = (troca: Partial<CapacidadesDeLigacao> = {}): Readonly<CapacidadesDeLigacao> => definirCapacidadesDeLigacao(matrizDeTeste(troca));

/** A matriz de um provedor que garante a causa do fim, avisa ao vivo e prova a origem do aviso por assinatura. */
export const matrizGarantida = (troca: Partial<CapacidadesDeLigacao> = {}) =>
  matriz({ causaDoFimGarantida: true, eventosAoVivo: true, duracaoDesdeAtendimento: true, webhook: "assinatura_do_provedor", ...troca });

/** Todas as permutações de uma lista (algoritmo de Heap). Com 6 itens são 720. */
export function permutacoes<T>(itens: readonly T[]): T[][] {
  const saida: T[][] = [];
  const a = [...itens];
  const gerar = (k: number) => {
    if (k <= 1) {
      saida.push([...a]);
      return;
    }
    gerar(k - 1);
    for (let i = 0; i < k - 1; i++) {
      const j = k % 2 === 0 ? i : 0;
      [a[j], a[k - 1]] = [a[k - 1]!, a[j]!];
      gerar(k - 1);
    }
  };
  gerar(a.length);
  return saida;
}

/** Todos os subconjuntos de tamanho `de` a `ate` (na ordem original). */
export function subconjuntos<T>(itens: readonly T[], de: number, ate: number): T[][] {
  const saida: T[][] = [];
  const andar = (inicio: number, atual: T[]) => {
    if (atual.length >= de) saida.push([...atual]);
    if (atual.length === ate) return;
    for (let i = inicio; i < itens.length; i++) {
      atual.push(itens[i]!);
      andar(i + 1, atual);
      atual.pop();
    }
  };
  andar(0, []);
  return saida;
}
