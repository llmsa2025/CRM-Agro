/**
 * Formatação de texto do WhatsApp para a prévia: `*negrito*`, `_itálico_`,
 * `~riscado~`, `` `código` `` e ```` ```bloco``` ````. Mesmas regras do app:
 * o marcador abre colado no texto (sem espaço depois), fecha colado (sem
 * espaço antes), não vale no meio de palavra e não atravessa linha. Negrito,
 * itálico e riscado se aninham (`*_assim_*`); código não.
 */
export type Trecho =
  | { tipo: "texto"; texto: string }
  | { tipo: "negrito" | "italico" | "riscado"; filhos: Trecho[] }
  | { tipo: "codigo"; texto: string };

const TIPO_DO_MARCADOR = { "*": "negrito", _: "italico", "~": "riscado" } as const;

// 1: bloco ```...```  2: `código`  3: marcador de estilo  4: conteúdo do estilo
const PADRAO = /```([\s\S]+?)```|`([^`\n]+)`|(?<![\p{L}\p{N}])([*_~])(?!\3)(?=\S)([^\n]*?\S)\3(?![\p{L}\p{N}])/gu;

export function formatarWhatsApp(texto: string): Trecho[] {
  const saida: Trecho[] = [];
  let fim = 0;
  for (const m of texto.matchAll(PADRAO)) {
    const inicio = m.index ?? 0;
    if (inicio > fim) saida.push({ tipo: "texto", texto: texto.slice(fim, inicio) });
    if (m[1] !== undefined) saida.push({ tipo: "codigo", texto: m[1] });
    else if (m[2] !== undefined) saida.push({ tipo: "codigo", texto: m[2] });
    else saida.push({ tipo: TIPO_DO_MARCADOR[m[3] as keyof typeof TIPO_DO_MARCADOR], filhos: formatarWhatsApp(m[4]!) });
    fim = inicio + m[0].length;
  }
  if (fim < texto.length) saida.push({ tipo: "texto", texto: texto.slice(fim) });
  return saida;
}
