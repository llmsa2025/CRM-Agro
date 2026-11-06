import type { Prisma } from "@prisma/client";

/**
 * Prova da ligação, como a Activity a enxerga.
 *
 * `meta.comprovada` é a PROJEÇÃO, na Activity, da prova guardada na Call: a
 * verdade mora em `Call.evidencia`, que só o aplicador de fatos do provedor
 * grava (F1B-10a). Quem escreve esta chave é só o projetor da Activity (F1B-09),
 * a partir dessa prova, e sempre por `marcarTentativaComprovada`. Hoje ninguém
 * escreve: por isso o placar de ligação do Painel está em zero até o primeiro
 * provedor comprovar uma chamada (F2-23).
 *
 * Duas regras seguram isto, ambas em `comprovacao.catraca.test.ts`:
 * - só os arquivos da lista `APLICADORES_DE_PROVA` importam `marcarTentativaComprovada`;
 * - nenhum outro arquivo escreve a chave `comprovada` em `Activity.meta`.
 *
 * Ler a chave é livre (`ehAtividadeComprovada`, `sqlToqueDeSaida`, `whereToqueDeSaida`).
 * Quem pergunta "esta ligação conta no placar?" usa `motor-do-dia/toque.ts`.
 */

/** Nome da chave em `Activity.meta`. A catraca confere o valor desta constante. A tela (web, F1A-07) só a lê, como texto: o literal não pode mudar sem ela. */
export const CHAVE_COMPROVADA = "comprovada";

/** `Activity.meta` chega do banco como JSON qualquer; só um objeto simples serve de base. */
function comoObjeto(meta: unknown): Record<string, unknown> | null {
  return meta !== null && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
}

/**
 * ÚNICA função que escreve `meta.comprovada`. Devolve uma cópia de `meta` com a chave posta em `sim`
 * (`true` = o provedor comprovou a tentativa; `false` = projeção refeita sem prova). Não muda o objeto de entrada
 * e mantém as outras chaves (`callId`, `status` e o resto).
 */
export function marcarTentativaComprovada(meta: unknown, sim: boolean): Prisma.InputJsonObject {
  return { ...((comoObjeto(meta) ?? {}) as Prisma.JsonObject), [CHAVE_COMPROVADA]: sim };
}

/** `true` só quando a chave existe e é o booleano `true`. Texto "true", número 1 e ausência dão `false`. */
export function ehAtividadeComprovada(meta: unknown): boolean {
  return comoObjeto(meta)?.[CHAVE_COMPROVADA] === true;
}
