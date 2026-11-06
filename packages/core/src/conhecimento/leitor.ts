/**
 * Leitura de arquivos da base de conhecimento: texto, PDF, Word (.docx) e Excel (.xlsx).
 *
 * Só extrai o TEXTO. O arquivo em si não é guardado: o que a IA consulta é o texto, e guardar o original só
 * aumentaria o que há para proteger. As bibliotecas pesadas entram por `import()` na hora de ler (o resto do
 * core não paga o custo de carregá-las).
 *
 * Formatos antigos (.doc, .xls) não são lidos: o aviso diz para salvar de novo como .docx ou .xlsx.
 */

export type FonteDoArquivo = "texto" | "pdf" | "word" | "excel";

export const TAMANHO_MAX_ARQUIVO = 15 * 1024 * 1024;
/** Teto de texto extraído por documento (o que a IA consegue consultar de forma útil). */
export const CARACTERES_MAX_DOC = 300_000;
const LINHAS_MAX_POR_ABA = 5000;

/** Erro com texto escrito para a pessoa ler (a tela mostra como está). */
export class ArquivoNaoLido extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ArquivoNaoLido";
  }
}

const EXTENSOES: Record<string, FonteDoArquivo> = {
  pdf: "pdf",
  docx: "word",
  xlsx: "excel",
  txt: "texto",
  md: "texto",
  csv: "texto",
};

/** Qual leitor serve ao arquivo, pela extensão (o tipo MIME que o navegador manda não é confiável). */
export function fonteDoArquivo(nome: string): FonteDoArquivo | null {
  const ext = nome.toLowerCase().split(".").pop() ?? "";
  if (ext === "doc" || ext === "xls") {
    throw new ArquivoNaoLido(`Arquivo .${ext} é de um formato antigo e não dá para ler. Abra no Word ou no Excel e salve como .${ext}x.`);
  }
  if (ext === "ppt" || ext === "pptx") {
    throw new ArquivoNaoLido("Apresentações ainda não são lidas. Salve como PDF e envie de novo.");
  }
  return EXTENSOES[ext] ?? null;
}

/** Texto limpo: sem caracteres de controle, sem linhas em excesso. */
export function limparTextoExtraido(t: string): string {
  return t
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function exigirTexto(texto: string, o_que: string, dicaSemTexto = ""): string {
  const t = limparTextoExtraido(texto);
  if (!t) throw new ArquivoNaoLido(`Não achei texto neste ${o_que}.${dicaSemTexto ? ` ${dicaSemTexto}` : ""}`);
  if (t.length > CARACTERES_MAX_DOC) {
    throw new ArquivoNaoLido(
      `Este ${o_que} tem texto demais (${Math.round(t.length / 1000)} mil caracteres, o limite é ${CARACTERES_MAX_DOC / 1000} mil). Divida em partes menores.`,
    );
  }
  return t;
}

// ─── Word (.docx) ───────────────────────────────────────────────────────────

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodificarEntidades(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTIDADES[e.toLowerCase()] ?? m;
  });
}

/** Do XML do documento do Word para texto: parágrafo vira linha, célula vira coluna. */
export function textoDoXmlDoWord(xml: string): string {
  return decodificarEntidades(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

async function lerWord(bytes: Uint8Array): Promise<string> {
  const { default: JSZip } = await import("jszip");
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ArquivoNaoLido("Não consegui abrir este arquivo do Word. Confira se ele não está corrompido.");
  }
  const doc = zip.file("word/document.xml");
  if (!doc) throw new ArquivoNaoLido("Este arquivo não parece um documento do Word (.docx).");
  return textoDoXmlDoWord(await doc.async("string"));
}

// ─── Excel (.xlsx) ──────────────────────────────────────────────────────────

async function lerExcel(bytes: Uint8Array): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new ArquivoNaoLido("Não consegui abrir esta planilha. Confira se ela não está corrompida ou protegida por senha.");
  }
  const partes: string[] = [];
  for (const ws of wb.worksheets) {
    const linhas: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (linhas.length >= LINHAS_MAX_POR_ABA) return;
      const celulas: string[] = [];
      row.eachCell({ includeEmpty: true }, (c) => celulas.push(String(c.text ?? "").replace(/\s+/g, " ").trim()));
      const linha = celulas.join(" | ").replace(/(?:\s\|\s)+$/, "").trim();
      if (linha) linhas.push(linha);
    });
    if (linhas.length > 0) partes.push(`## ${ws.name}\n${linhas.join("\n")}`);
  }
  return partes.join("\n\n");
}

// ─── PDF ────────────────────────────────────────────────────────────────────

async function lerPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  try {
    // Cópia: o leitor de PDF toma posse do buffer que recebe.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n\n") : text;
  } catch {
    throw new ArquivoNaoLido("Não consegui abrir este PDF. Confira se ele não está corrompido ou protegido por senha.");
  }
}

// ─── Entrada ────────────────────────────────────────────────────────────────

/** Lê o arquivo e devolve o tipo e o texto extraído. Lança `ArquivoNaoLido` com a frase para a pessoa. */
export async function lerArquivo(nome: string, bytes: Uint8Array): Promise<{ fonte: FonteDoArquivo; texto: string }> {
  const fonte = fonteDoArquivo(nome);
  if (!fonte) throw new ArquivoNaoLido("Formato não aceito. Envie PDF, Word (.docx), Excel (.xlsx) ou texto (.txt, .md, .csv).");
  if (bytes.byteLength === 0) throw new ArquivoNaoLido("O arquivo está vazio.");
  if (bytes.byteLength > TAMANHO_MAX_ARQUIVO) {
    throw new ArquivoNaoLido(`O arquivo tem mais de ${TAMANHO_MAX_ARQUIVO / 1024 / 1024} MB. Envie uma versão menor ou divida em partes.`);
  }
  switch (fonte) {
    case "pdf":
      return { fonte, texto: exigirTexto(await lerPdf(bytes), "PDF", "Se ele for escaneado (só imagem), use um PDF com texto selecionável.") };
    case "word":
      return { fonte, texto: exigirTexto(await lerWord(bytes), "documento") };
    case "excel":
      return { fonte, texto: exigirTexto(await lerExcel(bytes), "planilha") };
    case "texto":
      return { fonte, texto: exigirTexto(new TextDecoder("utf-8").decode(bytes), "arquivo") };
  }
}

export { exigirTexto as conferirTextoExtraido };
