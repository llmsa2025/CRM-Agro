import { z } from "zod";
import { FatoDeLigacaoSchema, type FatoDeLigacao } from "../provedor/fato";

/**
 * A LINHA DO TEMPO de uma ligação: a lista de fatos que o núcleo
 * de prova já aceitou para ela. É o que `Call.eventos` guarda e a única entrada do cálculo do desfecho.
 *
 * Funções PURAS: sem banco, fila nem efeito. Generaliza `calls/whatsapp-fatos.ts` da branch do WhatsApp
 * (`acrescentarEvento` e `lerEventos`), com duas correções: a entrada leva a ORIGEM do fato (webhook, consulta
 * ou crmagro) e a leitura não joga entrada fora em silêncio (ela conta o que descartou).
 */

/** De onde o fato veio. `webhook` e `consulta` são do provedor; `crmagro` é fechamento sintético nosso. */
export const ORIGENS_DE_FATO_DE_LIGACAO = ["webhook", "consulta", "crmagro"] as const;
export const OrigemDeFatoDeLigacaoSchema = z.enum(ORIGENS_DE_FATO_DE_LIGACAO);
export type OrigemDeFatoDeLigacao = z.infer<typeof OrigemDeFatoDeLigacaoSchema>;

/** Origens que vêm do provedor e, por isso, podem provar algo. A origem `crmagro` nunca prova. */
export const ehOrigemDoProvedorDeLigacao = (o: OrigemDeFatoDeLigacao): boolean => o !== "crmagro";

/**
 * Uma entrada da linha do tempo. O `idEvento` é o da caixa: `<origem>:<id do adaptador>`. A deduplicação vale
 * dentro da mesma origem: o fim pelo webhook e o fim pela consulta são DOIS eventos que dão o mesmo desfecho.
 */
export const EntradaDaLinhaDoTempoDeLigacaoSchema = z
  .object({
    idEvento: z.string().min(1).max(260),
    origem: OrigemDeFatoDeLigacaoSchema,
    fato: FatoDeLigacaoSchema,
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.idEvento !== idDeEventoDaLinhaDoTempoDeLigacao(e.origem, e.fato.idEvento)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["idEvento"], message: "O idEvento da entrada é <origem>:<id do fato>." });
    }
  });
export type EntradaDaLinhaDoTempoDeLigacao = z.infer<typeof EntradaDaLinhaDoTempoDeLigacaoSchema>;

/** O `idEvento` da caixa para um fato: a origem na frente, para o mesmo aviso por origens diferentes não colidir. */
export function idDeEventoDaLinhaDoTempoDeLigacao(origem: OrigemDeFatoDeLigacao, idDoFato: string): string {
  return `${origem}:${idDoFato}`;
}

/** Monta a entrada de um fato já validado pela origem dele. */
export function entradaDaLinhaDoTempoDeLigacao(origem: OrigemDeFatoDeLigacao, fato: FatoDeLigacao): EntradaDaLinhaDoTempoDeLigacao {
  return { idEvento: idDeEventoDaLinhaDoTempoDeLigacao(origem, fato.idEvento), origem, fato };
}

/** O instante do fato em milissegundos. O fato já passou pelo zod, então a data é válida. */
export const instanteDoFatoDeLigacao = (fato: Pick<FatoDeLigacao, "ocorridoEm">): number => Date.parse(fato.ocorridoEm);

/** Ordem estável da linha do tempo: por instante e, no empate, por `idEvento` (texto puro, sem localidade). */
function compararEntradas(a: EntradaDaLinhaDoTempoDeLigacao, b: EntradaDaLinhaDoTempoDeLigacao): number {
  const dt = instanteDoFatoDeLigacao(a.fato) - instanteDoFatoDeLigacao(b.fato);
  if (dt !== 0) return dt;
  return a.idEvento < b.idEvento ? -1 : a.idEvento > b.idEvento ? 1 : 0;
}

/**
 * Acrescenta um fato SEM duplicar. O provedor reentrega aviso e a consulta repete o que o aviso já trouxe, então
 * o mesmo `idEvento` só vale uma vez: o primeiro que chegou fica. Devolve a lista nova, ordenada por instante
 * (a ordem de chegada não aparece no que se grava), e `igual` quando nada mudou.
 */
export function acrescentarFatoDeLigacao(
  atual: readonly EntradaDaLinhaDoTempoDeLigacao[],
  nova: EntradaDaLinhaDoTempoDeLigacao,
): { entradas: EntradaDaLinhaDoTempoDeLigacao[]; igual: boolean } {
  if (atual.some((e) => e.idEvento === nova.idEvento)) return { entradas: [...atual], igual: true };
  return { entradas: [...atual, nova].sort(compararEntradas), igual: false };
}

export type LeituraDaLinhaDoTempoDeLigacao = {
  entradas: EntradaDaLinhaDoTempoDeLigacao[];
  /** Quantas entradas do JSON não passaram no schema. Quem lê decide: a tela segue, o aplicador registra o erro. */
  descartadas: number;
};

/**
 * Lê o JSON da coluna `Call.eventos` com segurança: entrada inválida não derruba a tela, mas é CONTADA em
 * `descartadas` (a leitura da branch do WhatsApp jogava fora o que não conhecia, sem avisar). Aceita as três
 * origens e repete a regra de "uma vez por `idEvento`", mantendo a primeira.
 */
export function lerLinhaDoTempoDeLigacao(bruto: unknown): LeituraDaLinhaDoTempoDeLigacao {
  if (bruto === null || bruto === undefined) return { entradas: [], descartadas: 0 };
  if (!Array.isArray(bruto)) return { entradas: [], descartadas: 1 };
  const vistos = new Set<string>();
  const entradas: EntradaDaLinhaDoTempoDeLigacao[] = [];
  let descartadas = 0;
  for (const item of bruto) {
    const r = EntradaDaLinhaDoTempoDeLigacaoSchema.safeParse(item);
    if (!r.success) {
      descartadas++;
      continue;
    }
    if (vistos.has(r.data.idEvento)) continue;
    vistos.add(r.data.idEvento);
    entradas.push(r.data);
  }
  return { entradas: entradas.sort(compararEntradas), descartadas };
}

/** Texto com as chaves em ordem, para comparar dois fatos sem depender da ordem dos campos. */
function textoCanonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(textoCanonico).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${textoCanonico(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Uma entrada por `idEvento`, em ordem estável, SEM depender da ordem em que a lista chegou. Se duas entradas
 * têm o mesmo `idEvento` e conteúdos diferentes (aviso forjado reusando o id), vale a de menor texto canônico:
 * o resultado é o mesmo em qualquer permutação. Usada pelo cálculo do desfecho.
 */
export function normalizarLinhaDoTempoDeLigacao(entradas: readonly EntradaDaLinhaDoTempoDeLigacao[]): EntradaDaLinhaDoTempoDeLigacao[] {
  const porId = new Map<string, { entrada: EntradaDaLinhaDoTempoDeLigacao; texto: string }>();
  for (const entrada of entradas) {
    const texto = textoCanonico(entrada);
    const atual = porId.get(entrada.idEvento);
    if (!atual || texto < atual.texto) porId.set(entrada.idEvento, { entrada, texto });
  }
  return [...porId.values()].map((v) => v.entrada).sort(compararEntradas);
}
