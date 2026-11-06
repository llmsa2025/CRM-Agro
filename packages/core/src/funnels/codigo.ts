/**
 * Geração de código estável para Funnel/Stage — a referência que as automações
 * usam ("mover para etapa X") sem depender do id volátil nem do nome editável.
 *
 * Formato: `<slug-do-nome>-<4 hex>`. O slug dá legibilidade; o sufixo aleatório
 * garante unicidade dentro do escopo (time / funil) sem uma ida ao banco.
 */

function slugify(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function rand4(): string {
  return Math.random().toString(16).slice(2, 6).padEnd(4, "0");
}

/** Código a partir do nome (ex.: "Em contato" → "em-contato-a1b2"). */
export function gerarCodigo(nome: string, fallback = "etapa"): string {
  const base = slugify(nome) || fallback;
  return `${base}-${rand4()}`;
}
