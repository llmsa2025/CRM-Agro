import { semAcento } from "@/lib/captacao-filtros";

/**
 * Regras puras do campo "Tags" do contato (`components/tags-input.tsx`). Ficam fora do componente para serem
 * testadas sem DOM: o que decide quais tags aparecem na lista, como o texto vira tag e o que o servidor lê do
 * formulário mora aqui. O nome final da tag é decidido pelo servidor (`nomeDaTag`, no core); aqui só se evita a
 * pílula repetida e se mostra a grafia que o time já usa.
 */

/** Tag do catálogo do time, como a tela recebe (com quantos contatos a têm). */
export type TagDoTime = { id: string; nome: string; cor: string | null; count: number };
export type OpcaoDeTag = { tipo: "tag"; tag: TagDoTime } | { tipo: "criar"; nome: string };

/** Mesmo limite do cadastro de tag no servidor (`TAG_NOME_MAX`). */
export const NOME_DE_TAG_MAX = 40;
/** Quantas sugestões desenhar de uma vez; o resto aparece ao digitar. */
export const MAX_SUGESTOES = 100;

/** Espaços colapsados e no máximo 40 caracteres, como o cadastro de tag. */
export function limparNomeDeTag(t: string): string {
  return t.replace(/\s+/g, " ").trim().slice(0, NOME_DE_TAG_MAX).trim();
}

/** Chave de comparação: sem acento e sem caixa ("Café" e "cafe" são a mesma tag). */
export function chaveDeTag(t: string): string {
  return semAcento(limparNomeDeTag(t));
}

/**
 * O que a lista de sugestões mostra para o texto digitado: as tags do time que ainda não estão no campo e batem
 * com o texto (a de nome IGUAL primeiro, depois as que COMEÇAM com ele, depois as que só o contêm), mais "criar"
 * quando o texto não existe. Campo vazio lista as mais usadas primeiro. `restantes` é quantas passaram do limite de
 * `max`. `destaquePadrao` é a opção que o Enter escolhe sem a pessoa ter usado as setas: a de nome igual ao texto,
 * senão "criar" (nunca uma sugestão parecida: escolher a tag errada sem querer pode disparar o fluxo dela), senão
 * nenhuma (-1).
 */
export function opcoesDeTags(entrada: {
  catalogo: readonly TagDoTime[];
  value: readonly string[];
  texto: string;
  max?: number;
}): { opcoes: OpcaoDeTag[]; restantes: number; destaquePadrao: number } {
  const { catalogo, value, texto, max = MAX_SUGESTOES } = entrada;
  const postas = new Set(value.map(chaveDeTag));
  const busca = chaveDeTag(texto);
  const livres = catalogo.filter((t) => !postas.has(chaveDeTag(t.nome)));
  let achadas: TagDoTime[];
  let temIgual = false;
  if (!busca) {
    achadas = [...livres].sort((a, b) => b.count - a.count || a.nome.localeCompare(b.nome, "pt-BR"));
  } else {
    const igual: TagDoTime[] = [];
    const comeca: TagDoTime[] = [];
    const contem: TagDoTime[] = [];
    for (const t of livres) {
      const k = chaveDeTag(t.nome);
      if (k === busca) igual.push(t);
      else if (k.startsWith(busca)) comeca.push(t);
      else if (k.includes(busca)) contem.push(t);
    }
    temIgual = igual.length > 0;
    achadas = [...igual, ...comeca, ...contem];
  }
  const opcoes: OpcaoDeTag[] = achadas.slice(0, max).map((tag) => ({ tipo: "tag", tag }));
  // Já existe (no catálogo ou já posta) não oferece criar de novo.
  const existe = !busca || postas.has(busca) || catalogo.some((t) => chaveDeTag(t.nome) === busca);
  if (!existe) opcoes.push({ tipo: "criar", nome: limparNomeDeTag(texto) });
  const destaquePadrao = temIgual ? 0 : opcoes.findIndex((o) => o.tipo === "criar");
  return { opcoes, restantes: Math.max(0, achadas.length - max), destaquePadrao };
}

/**
 * Põe as tags digitadas no fim da lista, na ordem, sem repetir (sem acento e sem caixa) e com a grafia do catálogo
 * quando a tag já existe ("soja" vira "Soja"). Devolve a MESMA lista (mesma referência) quando nada mudou.
 */
export function incluirTags(
  value: readonly string[],
  nomes: readonly string[],
  catalogo: readonly TagDoTime[],
): readonly string[] {
  let proximo = value;
  for (const n of nomes) {
    const limpo = limparNomeDeTag(n);
    if (!limpo) continue;
    const k = chaveDeTag(limpo);
    if (proximo.some((v) => chaveDeTag(v) === k)) continue;
    proximo = [...proximo, catalogo.find((t) => chaveDeTag(t.nome) === k)?.nome ?? limpo];
  }
  return proximo;
}

/** A tag do catálogo com este nome (sem acento e sem caixa), ou `undefined` quando o nome não existe lá. */
export function acharNoCatalogo(catalogo: readonly TagDoTime[], nome: string): TagDoTime | undefined {
  const k = chaveDeTag(nome);
  return k ? catalogo.find((t) => chaveDeTag(t.nome) === k) : undefined;
}

/**
 * Põe no catálogo que a tela já tem a tag que o servidor acabou de criar ou de achar (pedir para criar um nome que
 * existe devolve a tag que existe). Não repete a mesma tag e devolve a MESMA lista quando ela já estava lá.
 */
export function comTagNoCatalogo(catalogo: readonly TagDoTime[], tag: { id: string; nome: string }): readonly TagDoTime[] {
  if (catalogo.some((t) => t.id === tag.id)) return catalogo;
  return [...catalogo, { id: tag.id, nome: tag.nome, cor: null, count: 0 }];
}

/**
 * Vírgula, ponto e vírgula e quebra de linha fecham a tag, digitados ou num texto colado. Devolve as tags
 * prontas e o que sobra no campo; `null` quando o texto não tem separador.
 */
export function separarTagsDigitadas(v: string): { prontas: string[]; resto: string } | null {
  if (!/[,;\n]/.test(v)) return null;
  const partes = v.split(/[,;\n]/);
  const resto = partes.pop() ?? "";
  return { prontas: partes, resto };
}

/**
 * O que o servidor lê do campo `tags` de um formulário. O campo novo manda uma lista em JSON (`["Soja","Milho"]`),
 * que aceita vírgula dentro do nome; texto simples separado por vírgula também vale. `undefined` = o formulário
 * NÃO tem o campo, e quem recebe não mexe nas tags (o diálogo de edição rápida da lista não tem o campo, e antes
 * ele zerava as tags a cada salvar). `[]` = o campo veio vazio: tirou todas.
 */
export function tagsDoCampo(bruto: FormDataEntryValue | null): string[] | undefined {
  if (bruto === null) return undefined;
  const texto = String(bruto).trim();
  if (texto.startsWith("[")) {
    try {
      const lista: unknown = JSON.parse(texto);
      if (Array.isArray(lista)) return lista.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      // Texto que só começa com "[": segue como lista separada por vírgula.
    }
  }
  return texto ? texto.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
