/**
 * Modo de exibição dos contatos no Mapa. Regras puras (sem DOM nem MapLibre em
 * execução) para o `MapaClient` decidir a config da fonte e das camadas — e
 * para o vitest, que roda sem jsdom, conseguir testar.
 *
 *  - "agrupar": como sempre foi — pontos próximos viram círculo verde com número
 *    (quando o zoom está afastado) e cada contato solto aparece como pino.
 *  - "pontos": todos os contatos soltos, sem agrupar, sempre como pino (o mesmo
 *    do modo agrupado, que encolhe com o zoom) — para afastar o zoom e ver tudo de cima.
 *
 * O modo só muda COMO o mapa desenha o que já foi buscado: a busca ao servidor
 * (filtros, camadas, bbox) e o resumo "Região visível" não dependem dele, então
 * as contagens são as mesmas nos dois modos.
 */

export const MODOS_PONTOS = ["agrupar", "pontos"] as const;
export type ModoPontos = (typeof MODOS_PONTOS)[number];

/** Padrão de quem nunca escolheu (e de quem tem valor estranho guardado). */
export const MODO_PONTOS_PADRAO: ModoPontos = "agrupar";

/** Chave no localStorage — mesmo prefixo das outras escolhas do Mapa (estilo, painel). */
export const CHAVE_MODO_PONTOS = "crmagro:mapa:pontos";

/** Valor lido do localStorage → modo. Qualquer coisa fora da lista cai no padrão. */
export function modoSalvo(valor: unknown): ModoPontos {
  return MODOS_PONTOS.find((m) => m === valor) ?? MODO_PONTOS_PADRAO;
}

/** Raio (px) e distância máxima de zoom do agrupamento feito no cliente — os de sempre. */
const RAIO_AGRUPAMENTO = 44;
const ZOOM_MAX_AGRUPAMENTO = 12;

/**
 * Opções de agrupamento da fonte GeoJSON "contatos" para o modo.
 * Na criação da fonte vai inteira; na troca de modo com o mapa aberto vai para
 * `GeoJSONSource.setClusterOptions`, que reprocessa os mesmos dados no worker
 * (sem recriar fonte, camadas nem perder a seleção).
 */
export function configFonteContatos(modo: ModoPontos): { cluster: boolean; clusterRadius: number; clusterMaxZoom: number } {
  return { cluster: modo === "agrupar", clusterRadius: RAIO_AGRUPAMENTO, clusterMaxZoom: ZOOM_MAX_AGRUPAMENTO };
}

/** Camadas dos contatos que dependem do modo: o círculo com número e seu rótulo (só agrupado) e o pino (nos dois). */
export const CAMADAS_DE_CONTATOS = ["grupo", "grupo-n", "ponto"] as const;

export type IdCamadaDeContatos = (typeof CAMADAS_DE_CONTATOS)[number];

/**
 * `visibility` de cada camada dos contatos no modo. As camadas do servidor
 * (`grupo-srv*`, acima de 5.000 pontos), a seleção e a rota não entram: valem
 * nos dois modos.
 */
export function visibilidadeCamadas(modo: ModoPontos): Record<IdCamadaDeContatos, "visible" | "none"> {
  // O pino aparece nos dois modos: sem agrupar, todo contato vira pino; agrupado, o pino só
  // aparece nos contatos que não entraram em nenhum círculo (o filtro da camada cuida disso).
  const agrupar = modo === "agrupar" ? "visible" : "none";
  return { grupo: agrupar, "grupo-n": agrupar, ponto: "visible" };
}

/**
 * Setas do teclado num grupo de opções (padrão WAI-ARIA de radiogroup):
 * devolve o índice da opção que ganha o foco/seleção, ou null se a tecla não
 * é de navegação. Dá a volta nas pontas.
 */
export function proximoIndiceRadio(atual: number, total: number, tecla: string): number | null {
  if (total <= 0) return null;
  switch (tecla) {
    case "ArrowRight":
    case "ArrowDown":
      return (atual + 1) % total;
    case "ArrowLeft":
    case "ArrowUp":
      return (atual - 1 + total) % total;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    default:
      return null;
  }
}
