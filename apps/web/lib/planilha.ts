/**
 * Arquivo enviado na importação (produto §C) → texto CSV para o core.
 *
 * - `.xlsx`: 1ª aba, linha por linha (inclusive as vazias, para a numeração
 *   bater com a do Excel), cada célula como texto;
 * - CSV/TXT: UTF-8; se não for UTF-8 válido, Windows-1252 (o "CSV do Excel" em
 *   português sai assim, e "São" virava "S�o").
 *
 * O separador (`,` `;` tab) fica com o core (`lerPlanilha`).
 */

/** Teto do arquivo (o server action aceita até 30 MB). */
export const ARQUIVO_MAX_BYTES = 20 * 1024 * 1024;
/**
 * Teto do `.xlsx`: o exceljs descompacta a planilha INTEIRA na memória do web
 * (20 MB zipados passam de 1 GB) — 5 MB já cobrem ~50 mil linhas.
 */
export const XLSX_MAX_BYTES = 5 * 1024 * 1024;

export class ArquivoInvalido extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "ArquivoInvalido";
  }
}

function ehExcel(file: File): boolean {
  return file.name.toLowerCase().endsWith(".xlsx");
}

/** Valor de célula do exceljs → texto (rich text, link, fórmula, data). */
function textoDaCelula(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: unknown; richText?: { text: string }[]; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((p) => p.text).join("");
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined) return textoDaCelula(o.result);
    return "";
  }
  return String(v);
}

function celulaCsv(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export async function planilhaParaCsv(file: File): Promise<string> {
  if (file.size === 0) throw new ArquivoInvalido("arquivo vazio");
  if (file.size > ARQUIVO_MAX_BYTES) throw new ArquivoInvalido("arquivo maior que 20 MB: divida em partes");
  if (ehExcel(file)) {
    if (file.size > XLSX_MAX_BYTES) throw new ArquivoInvalido("Excel maior que 5 MB: salve como CSV ou divida em partes");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) throw new ArquivoInvalido("planilha sem abas");
    const linhas: string[] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const vals = ((row.values as unknown[]) ?? []).slice(1);
      linhas.push(vals.map((v) => celulaCsv(textoDaCelula(v))).join(","));
    });
    return linhas.join("\n");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
