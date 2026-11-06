/**
 * Regras PURAS da tela "Enriquecer empresa": quais itens vêm marcados, como marcar (um valor por
 * campo), como mostrar a data e a confiança, e o resumo do botão. Sem React e sem rede.
 */

export type ItemDaTela = {
  id: string;
  campo: string;
  acao: "preencher" | "trocar" | "igual";
  confianca: "alta" | "media" | "baixa";
};

/**
 * Marcados de saída: campo vazio ("preencher") com confiança alta ou média, o melhor de cada campo. Troca
 * de valor que já existe ("trocar") e sugestão de confiança baixa NUNCA vêm marcadas: a pessoa decide.
 */
export function selecaoInicial(itens: readonly ItemDaTela[]): Set<string> {
  const marcados = new Set<string>();
  const campos = new Set<string>();
  for (const i of itens) {
    if (i.acao !== "preencher" || i.confianca === "baixa" || campos.has(i.campo)) continue;
    campos.add(i.campo);
    marcados.add(i.id);
  }
  return marcados;
}

/** Marca ou desmarca um item. Marcar tira o outro item do mesmo campo (a coluna só guarda um valor). */
export function alternar(selecao: ReadonlySet<string>, itens: readonly ItemDaTela[], id: string): Set<string> {
  const novo = new Set(selecao);
  if (novo.has(id)) {
    novo.delete(id);
    return novo;
  }
  const item = itens.find((i) => i.id === id);
  if (!item || item.acao === "igual") return novo;
  for (const outro of itens) if (outro.campo === item.campo) novo.delete(outro.id);
  novo.add(id);
  return novo;
}

/** "2026-10-05T12:00:00.000Z" → "05/10/2026" (data de São Paulo). */
export function dataCurta(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export function rotuloDaConfianca(c: "alta" | "media" | "baixa"): string {
  return c === "alta" ? "Confiança alta" : c === "media" ? "Confiança média" : "Confiança baixa";
}

/** Texto do botão de aplicar: "Aplicar 3 campos", "Aplicar 1 campo", ou "Nada marcado". */
export function textoDoAplicar(marcados: number, comDadosPublicos: boolean): string {
  if (marcados === 0) return comDadosPublicos ? "Guardar dados públicos" : "Nada marcado";
  return `Aplicar ${marcados} ${marcados === 1 ? "campo" : "campos"}`;
}

/** Quantos itens trocariam um valor que já existe entre os marcados (a tela avisa antes de aplicar). */
export function trocasMarcadas(selecao: ReadonlySet<string>, itens: readonly ItemDaTela[]): number {
  return itens.filter((i) => selecao.has(i.id) && i.acao === "trocar").length;
}
