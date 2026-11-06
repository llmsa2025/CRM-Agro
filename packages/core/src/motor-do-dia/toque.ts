import { Prisma } from "@prisma/client";
import { CHAVE_COMPROVADA } from "../calls/comprovacao";

/**
 * Fonte única do "toque". Duas perguntas diferentes, duas respostas:
 *
 * 1. "Conta no placar?" (Painel, orçamento do dia, prospecção por canal, gráfico da semana, taxa de resposta)
 *    Só o toque de SAÍDA que o sistema consegue provar: WhatsApp e e-mail enviados, e ligação só com
 *    `meta.comprovada = true` (a prova do provedor, ver `calls/comprovacao.ts`). Ligação declarada, anotação e
 *    clique no botão NÃO contam. `whereToqueDeSaida()` (Prisma) e `sqlToqueDeSaida()` (SQL cru) são a mesma regra.
 *
 * 2. "Sai da lista do dia?" (lead sem toque, prioridade do contato)
 *    Qualquer contato abordado: saída de WhatsApp, e-mail ou ligação, comprovada ou declarada, e também a
 *    anotação de ligação feita fora do CRM Agro. `whereContatoAbordado()`.
 *
 * A separação é de propósito: o placar é honesto (só o que tem prova) sem atrapalhar o dia do vendedor, que não
 * deve ouvir "ligue de novo" para quem acabou de ser abordado. Qualquer contagem nova de toque entra por aqui,
 * nunca por um `tipo in ["whatsapp", "email", "call"]` escrito à mão.
 *
 * Os dados são puros (sem banco): as funções só montam filtros. Quem as usa roda dentro de `runWithTeam`.
 */

/** Tipos de Activity que são um canal de abordagem. Ordem usada na tela de prospecção por canal. */
export const TIPOS_DE_TOQUE = ["whatsapp", "email", "call"] as const;
export type TipoDeToque = (typeof TIPOS_DE_TOQUE)[number];

/** Chave de `Activity.meta` da anotação "ligação feita fora do CRM Agro" (a F1A-05 grava; a tela a lê como texto). */
export const CHAVE_LIGACAO_FORA_DO_CRMAGRO = "ligacaoForaDoCrmAgro";

/**
 * Placar, lado Prisma: toque de saída com prova. WhatsApp e e-mail de saída contam; ligação de saída só quando
 * `meta.comprovada` é o booleano `true`. Entrada (`direcao = "in"`) e direção nula nunca contam.
 */
export function whereToqueDeSaida(): Prisma.ActivityWhereInput {
  return {
    direcao: "out",
    OR: [
      { tipo: { in: ["whatsapp", "email"] } },
      { tipo: "call", meta: { path: [CHAVE_COMPROVADA], equals: true } },
    ],
  };
}

/**
 * Placar, lado SQL cru: a MESMA regra de `whereToqueDeSaida()`, como expressão booleana sobre a tabela "Activity".
 * As colunas vão qualificadas (`"Activity".`), então o pedaço serve em qualquer `FROM "Activity"` sem apelido,
 * inclusive com junção. A chave sai como parâmetro e a comparação é com o JSON `true` (um texto "true" não conta).
 * O `teamId` continua por conta de quem monta a consulta (§12f).
 */
export function sqlToqueDeSaida(): Prisma.Sql {
  return Prisma.sql`("Activity"."direcao" = 'out' AND ("Activity"."tipo" IN ('whatsapp', 'email') OR ("Activity"."tipo" = 'call' AND ("Activity"."meta" -> ${CHAVE_COMPROVADA}::text) = 'true'::jsonb)))`;
}

/**
 * Lista do dia: contato abordado. Saída de WhatsApp, e-mail ou ligação (declarada ou comprovada, não importa) ou
 * uma anotação de ligação feita fora do CRM Agro. Ligação sem direção (como a tarefa de ligar pendente do fluxo)
 * e nota comum NÃO abordam ninguém.
 */
export function whereContatoAbordado(): Prisma.ActivityWhereInput {
  return {
    OR: [
      { direcao: "out", tipo: { in: [...TIPOS_DE_TOQUE] } },
      { tipo: "note", meta: { path: [CHAVE_LIGACAO_FORA_DO_CRMAGRO], equals: true } },
    ],
  };
}
