/**
 * Busca por trechos na base de conhecimento. Puro (sem banco, sem IA): recebe os documentos e a pergunta e
 * devolve o texto que cabe no prompt.
 *
 * Sem vetor e sem serviço de busca: a base de uma equipe é pequena (dezenas de documentos), então um BM25
 * simples em memória acha o que importa. Duas regras seguram a qualidade:
 *  - base pequena (cabe no orçamento) entra INTEIRA, sem busca: nada fica de fora por azar de palavra;
 *  - base grande: os trechos mais parecidos com a pergunta; se nada casar, o começo de cada documento (é onde
 *    ficam "sobre a empresa", produtos e preços), para o agente não ficar sem nada.
 */

export type DocumentoParaBusca = { id: string; titulo: string; conteudo: string };

export type TrechoDaBase = { docId: string; titulo: string; ordem: number; texto: string };

export type TrechosEscolhidos = {
  /** Texto pronto para o prompt (títulos + trechos, na ordem do documento). */
  texto: string;
  /** Documentos que entraram, com quantos trechos de cada. */
  usados: Array<{ docId: string; titulo: string; trechos: number }>;
  /** A base inteira coube (não houve busca). */
  completa: boolean;
};

/** Tamanho-alvo de um trecho, em caracteres. */
export const TRECHO_ALVO = 900;
/** Quanto da base entra no prompt, em caracteres (~1.500 tokens). */
export const ORCAMENTO_PADRAO = 6000;

/** Quebra o texto em trechos de ~`alvo` caracteres, preferindo parágrafos e depois frases. */
export function dividirEmTrechos(texto: string, alvo = TRECHO_ALVO): string[] {
  const limpo = texto.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!limpo) return [];
  const pecas: string[] = [];
  for (const par of limpo.split(/\n\s*\n/)) {
    const p = par.trim();
    if (!p) continue;
    if (p.length <= alvo * 1.5) {
      pecas.push(p);
      continue;
    }
    // Parágrafo muito longo: por frase, e a frase gigante por tamanho.
    let atual = "";
    for (const frase of p.split(/(?<=[.!?;])\s+|\n/)) {
      if (frase.length > alvo * 1.5) {
        if (atual) pecas.push(atual);
        atual = "";
        for (let i = 0; i < frase.length; i += alvo) pecas.push(frase.slice(i, i + alvo));
        continue;
      }
      if (atual && atual.length + frase.length + 1 > alvo) {
        pecas.push(atual);
        atual = frase;
      } else atual = atual ? `${atual} ${frase}` : frase;
    }
    if (atual) pecas.push(atual);
  }
  // Junta peças curtas vizinhas até o alvo (títulos e itens de lista soltos não viram trecho sozinhos).
  const trechos: string[] = [];
  let atual = "";
  for (const p of pecas) {
    if (atual && atual.length + p.length + 2 > alvo) {
      trechos.push(atual);
      atual = p;
    } else atual = atual ? `${atual}\n\n${p}` : p;
  }
  if (atual) trechos.push(atual);
  return trechos;
}

// ─── Busca ──────────────────────────────────────────────────────────────────

const PARADAS = new Set(
  (
    "a o as os um uma uns umas de do da dos das em no na nos nas por para com sem sob sobre e ou mas que se ao aos " +
    "ja nao sim mais menos muito muita muitos muitas pouco ser ter foi sao esta estao tem tinha como qual quais " +
    "quando onde quem seu sua seus suas meu minha meus minhas nosso nossa esse essa esses essas este esta estes " +
    "estas isso isto aquele aquela voce voces eu nos ele ela eles elas lhe me te vai vou pode podem ate entre " +
    "depois antes tambem so apenas ainda cada todo toda todos todas outro outra outros outras"
  ).split(/\s+/),
);

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Palavras da busca: minúsculas, sem acento, sem palavras comuns, plural simples. */
export function palavrasDaBusca(texto: string): string[] {
  const out: string[] = [];
  for (const w of semAcento(texto.toLowerCase()).split(/[^a-z0-9]+/)) {
    if (w.length < 3 || PARADAS.has(w)) continue;
    out.push(w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return out;
}

const K1 = 1.5;
const B = 0.75;

/** Nota BM25 de cada trecho para a pergunta (mesma ordem de `trechos`). */
export function notasDosTrechos(trechos: readonly TrechoDaBase[], consulta: string): number[] {
  const termos = [...new Set(palavrasDaBusca(consulta))];
  if (termos.length === 0 || trechos.length === 0) return trechos.map(() => 0);
  const docs = trechos.map((t) => palavrasDaBusca(`${t.titulo} ${t.texto}`));
  const media = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const freqDoc = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) freqDoc.set(t, (freqDoc.get(t) ?? 0) + 1);
  return docs.map((d) => {
    const contagem = new Map<string, number>();
    for (const t of d) contagem.set(t, (contagem.get(t) ?? 0) + 1);
    let nota = 0;
    for (const termo of termos) {
      const f = contagem.get(termo) ?? 0;
      if (!f) continue;
      const n = freqDoc.get(termo) ?? 0;
      const idf = Math.log(1 + (trechos.length - n + 0.5) / (n + 0.5));
      nota += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / media)));
    }
    return nota;
  });
}

function montar(trechos: readonly TrechoDaBase[]): { texto: string; usados: TrechosEscolhidos["usados"] } {
  const porDoc = new Map<string, TrechoDaBase[]>();
  for (const t of trechos) porDoc.set(t.docId, [...(porDoc.get(t.docId) ?? []), t]);
  const partes: string[] = [];
  const usados: TrechosEscolhidos["usados"] = [];
  for (const [docId, lista] of porDoc) {
    const ordenados = [...lista].sort((a, b) => a.ordem - b.ordem);
    partes.push(`### ${ordenados[0]!.titulo}\n${ordenados.map((t) => t.texto).join("\n\n")}`);
    usados.push({ docId, titulo: ordenados[0]!.titulo, trechos: ordenados.length });
  }
  return { texto: partes.join("\n\n"), usados };
}

/** Escolhe o que vai para o prompt. `orcamento` é o teto de caracteres de trechos. */
export function escolherTrechos(docs: readonly DocumentoParaBusca[], consulta: string, orcamento = ORCAMENTO_PADRAO): TrechosEscolhidos {
  const ativos = docs.filter((d) => d.conteudo.trim());
  if (ativos.length === 0) return { texto: "", usados: [], completa: true };

  const total = ativos.reduce((a, d) => a + d.conteudo.trim().length, 0);
  const todos: TrechoDaBase[] = ativos.flatMap((d) =>
    dividirEmTrechos(d.conteudo).map((texto, ordem) => ({ docId: d.id, titulo: d.titulo, ordem, texto })),
  );

  // Base pequena: entra inteira, sem busca.
  if (total <= orcamento) {
    return { ...montar(todos), completa: true };
  }

  const notas = notasDosTrechos(todos, consulta);
  const ranque = todos.map((t, i) => ({ t, nota: notas[i]! })).filter((x) => x.nota > 0).sort((a, b) => b.nota - a.nota);

  const escolhidos: TrechoDaBase[] = [];
  let gasto = 0;
  const cabe = (t: TrechoDaBase) => gasto + t.texto.length <= orcamento;
  const pegar = (t: TrechoDaBase) => {
    escolhidos.push(t);
    gasto += t.texto.length;
  };
  for (const { t } of ranque) if (cabe(t)) pegar(t);

  // Nada casou: o começo de cada documento, um por vez, até encher.
  if (escolhidos.length === 0) {
    const jaTem = new Set<string>();
    for (const t of todos) {
      if (t.ordem !== 0 || jaTem.has(t.docId) || !cabe(t)) continue;
      jaTem.add(t.docId);
      pegar(t);
    }
  }
  return { ...montar(escolhidos), completa: false };
}
