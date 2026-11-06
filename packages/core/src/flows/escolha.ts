import { z } from "zod";

/**
 * A opção que um passo de decisão escolheu, para o log do fluxo dizer o caminho e não só o passo
 * ("condição: Já tem histórico (WhatsApp): não", em vez de só "condição").
 *
 * Fica no `result` do passo (`NodeResult.escolha`). O rótulo é o que o editor mostra na saída do nó;
 * o fluxo congelado na inscrição é quem manda, então editar o rótulo depois não muda o log antigo.
 */
export const escolhaDoPassoSchema = z.object({
  /** `condicao`: ramo que casou ou "senão". `sorteio`: variante do teste A/B. */
  tipo: z.enum(["condicao", "sorteio"]),
  /** Nome da saída seguida: rótulo do ramo, da variante, ou "senão". */
  saida: z.string(),
  /** Nenhum ramo casou e o fluxo foi pelo "senão". */
  senao: z.boolean(),
  /** Rótulos de TODOS os ramos da condição, na ordem (explicam o "senão"). Vazio no sorteio. */
  testadas: z.array(z.string()),
});
export type EscolhaDoPasso = z.infer<typeof escolhaDoPassoSchema>;

/** Rótulo em branco não pode virar texto vazio no log. */
const nomeDaSaida = (label: string, indice: number, padrao: string) => label.trim() || `${padrao} ${indice + 1}`;

/** Condição: `casou` é a posição do ramo que casou, ou `null` quando nenhum casou (vai pelo "senão"). */
export function escolhaDaCondicao(ramos: ReadonlyArray<{ label: string }>, casou: number | null): EscolhaDoPasso {
  const testadas = ramos.map((r, i) => nomeDaSaida(r.label, i, "saída"));
  if (casou === null) return { tipo: "condicao", saida: "senão", senao: true, testadas };
  return { tipo: "condicao", saida: testadas[casou] ?? "saída", senao: false, testadas };
}

/** Teste A/B: `indice` é a posição da variante sorteada. */
export function escolhaDoSorteio(label: string, indice: number): EscolhaDoPasso {
  return { tipo: "sorteio", saida: nomeDaSaida(label, indice, "variante"), senao: false, testadas: [] };
}

/** Lê a escolha do `result` gravado no banco (JSON de fora: valida antes de confiar). */
export function lerEscolha(result: unknown): EscolhaDoPasso | null {
  const bruto = (result as { escolha?: unknown } | null | undefined)?.escolha;
  const lida = escolhaDoPassoSchema.safeParse(bruto);
  return lida.success ? lida.data : null;
}

export type TextoDaEscolha = {
  /** Cabe no balão do passo: "Já tem histórico (WhatsApp): sim". */
  curto: string;
  /** Frase inteira, para o texto de ajuda do balão. */
  longo: string;
};

/**
 * Texto da escolha. Condição com uma saída só é uma pergunta de sim ou não ("Tem WhatsApp: sim");
 * com várias, o balão mostra a saída que casou, ou "senão" quando nenhuma casou.
 */
export function textoDaEscolha(e: EscolhaDoPasso): TextoDaEscolha {
  if (e.tipo === "sorteio") return { curto: e.saida, longo: `Sorteou "${e.saida}".` };
  const unica = e.testadas.length === 1;
  if (!e.senao) {
    return { curto: unica ? `${e.saida}: sim` : e.saida, longo: `Casou a saída "${e.saida}".` };
  }
  if (unica) {
    const t = e.testadas[0]!;
    return { curto: `${t}: não`, longo: `A saída "${t}" não casou, então seguiu pelo "senão".` };
  }
  return {
    curto: "senão",
    longo:
      e.testadas.length > 0
        ? `Nenhuma saída casou (${e.testadas.join(", ")}), então seguiu pelo "senão".`
        : 'Nenhuma saída casou, então seguiu pelo "senão".',
  };
}
