import { PassThrough, Readable } from "node:stream";
import ExcelJS from "exceljs";
import { EXPORT_COLUMNS, getColumnLabels, logger, type ExportRow } from "@crmagro/core";

/**
 * Planilha .xlsx em STREAMING (item 2.7, K2): `WorkbookWriter` do exceljs
 * escreve cada linha já comprimida na saída e descarta da memória. Antes, o
 * `Workbook` inteiro + `writeBuffer()` montava o arquivo todo em memória antes
 * do 1º byte.
 *
 * Contrapressão: se quem baixa está lento (buffer da saída cheio), para de
 * pedir lotes ao banco até a saída drenar. Download cancelado → a saída é
 * destruída e o laço para.
 *
 * Células vão como TEXTO (o exceljs só cria fórmula com `{ formula }`), então
 * `=HYPERLINK(...)` vindo de fora não executa no Excel — a proteção de fórmula
 * do CSV (item 3.7) não se aplica aqui.
 */
export function xlsxEmStream(lotes: AsyncIterable<ExportRow[]>): ReadableStream<Uint8Array> {
  const saida = new PassThrough();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: saida, useStyles: true, useSharedStrings: false });
  const sheet = workbook.addWorksheet("Contatos", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = getColumnLabels().map((label, i) => ({ header: label, key: String(i), width: 20 }));
  const cabecalho = sheet.getRow(1);
  cabecalho.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cabecalho.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };

  const drenou = () =>
    new Promise<void>((resolve) => {
      if (saida.destroyed || !saida.writableNeedDrain) return resolve();
      const fim = () => {
        saida.off("drain", fim);
        saida.off("close", fim);
        resolve();
      };
      saida.on("drain", fim);
      saida.on("close", fim);
    });
  // A compressão (zlib) e o pipe andam em callbacks: dar uma volta no event
  // loop depois de cada lote deixa a saída refletir o que já foi enviado.
  const umaVolta = () => new Promise<void>((resolve) => setImmediate(resolve));

  void (async () => {
    try {
      // `for await` chama o `return()` do gerador ao sair do laço (fim,
      // cancelamento ou erro) — mesma finalização do `cancel()` do CSV.
      for await (const lote of lotes) {
        if (saida.destroyed) return;
        for (const linha of lote) sheet.addRow(EXPORT_COLUMNS.map((c) => linha[c.key])).commit();
        await umaVolta();
        await drenou();
      }
      if (saida.destroyed) return;
      sheet.commit();
      await workbook.commit();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "[export] falha no meio da exportação XLSX");
      saida.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return Readable.toWeb(saida) as unknown as ReadableStream<Uint8Array>;
}
