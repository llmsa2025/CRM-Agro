import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { ArquivoNaoLido, fonteDoArquivo, lerArquivo, textoDoXmlDoWord } from "./leitor";
import { lerDocumentoDoGoogle, lerLinkDoGoogle } from "./google";

/** PDF mínimo com uma página e o texto dado (offsets calculados, para o leitor aceitar sem reparo). */
function pdfComTexto(texto: string): Uint8Array {
  const conteudo = `BT /F1 14 Tf 72 720 Td (${texto.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

async function docxComParagrafos(paragrafos: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const corpo = paragrafos.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${corpo}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

async function xlsxComLinhas(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("Preços");
  a.addRow(["Produto", "Preço"]);
  a.addRow(["Inoculante", "R$ 45,00"]);
  const b = wb.addWorksheet("Vazia");
  b.addRow([]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("fonteDoArquivo", () => {
  it("reconhece pela extensão, sem depender do tipo MIME", () => {
    expect(fonteDoArquivo("Manual.PDF")).toBe("pdf");
    expect(fonteDoArquivo("preços.xlsx")).toBe("excel");
    expect(fonteDoArquivo("proposta.docx")).toBe("word");
    expect(fonteDoArquivo("notas.md")).toBe("texto");
    expect(fonteDoArquivo("foto.png")).toBeNull();
  });

  it("formato antigo ganha o aviso de como resolver", () => {
    expect(() => fonteDoArquivo("velho.doc")).toThrow(/salve como \.docx/);
    expect(() => fonteDoArquivo("velho.xls")).toThrow(/salve como \.xlsx/);
    expect(() => fonteDoArquivo("apresentacao.pptx")).toThrow(/PDF/);
  });
});

describe("lerArquivo", () => {
  it("texto simples", async () => {
    const r = await lerArquivo("sobre.txt", new TextEncoder().encode("Somos a Agro Sul.\n\n\n\nVendemos adubo."));
    expect(r).toEqual({ fonte: "texto", texto: "Somos a Agro Sul.\n\nVendemos adubo." });
  });

  it("Word: parágrafos viram linhas e as entidades são decodificadas", async () => {
    const r = await lerArquivo("proposta.docx", await docxComParagrafos(["Garantia de 12 meses", "Cobre defeitos &amp; trocas"]));
    expect(r.fonte).toBe("word");
    expect(r.texto).toBe("Garantia de 12 meses\nCobre defeitos & trocas");
  });

  it("textoDoXmlDoWord: célula vira coluna e quebra de linha vira linha", () => {
    const xml = "<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p></w:tc></w:tr>";
    expect(textoDoXmlDoWord(xml)).toContain("A");
    expect(textoDoXmlDoWord(xml)).toContain("B\nC");
  });

  it("Excel: uma seção por aba, colunas separadas por barra, aba vazia some", async () => {
    const r = await lerArquivo("tabela.xlsx", await xlsxComLinhas());
    expect(r.fonte).toBe("excel");
    expect(r.texto).toContain("## Preços");
    expect(r.texto).toContain("Produto | Preço");
    expect(r.texto).toContain("Inoculante | R$ 45,00");
    expect(r.texto).not.toContain("Vazia");
  });

  it("PDF com texto", async () => {
    const r = await lerArquivo("catalogo.pdf", pdfComTexto("Catalogo de produtos Agro Sul"));
    expect(r.fonte).toBe("pdf");
    expect(r.texto).toContain("Catalogo de produtos Agro Sul");
  });

  it("PDF corrompido, Word corrompido e planilha corrompida dão aviso em português", async () => {
    const lixo = new TextEncoder().encode("isto não é um arquivo de verdade");
    await expect(lerArquivo("x.pdf", lixo)).rejects.toThrow(/PDF/);
    await expect(lerArquivo("x.docx", lixo)).rejects.toThrow(/Word/);
    await expect(lerArquivo("x.xlsx", lixo)).rejects.toThrow(/planilha/);
  });

  it("vazio, grande demais e formato não aceito", async () => {
    await expect(lerArquivo("a.txt", new Uint8Array())).rejects.toThrow(/vazio/);
    await expect(lerArquivo("a.txt", new Uint8Array(16 * 1024 * 1024))).rejects.toThrow(/15 MB/);
    await expect(lerArquivo("a.png", new Uint8Array([1, 2, 3]))).rejects.toThrow(/Formato não aceito/);
  });

  it("texto demais é recusado em vez de cortado em silêncio", async () => {
    const enorme = new TextEncoder().encode("palavra ".repeat(60_000));
    await expect(lerArquivo("grande.txt", enorme)).rejects.toThrow(/texto demais/);
  });

  it("o erro é do tipo ArquivoNaoLido (a tela mostra a frase como está)", async () => {
    await expect(lerArquivo("a.png", new Uint8Array([1]))).rejects.toBeInstanceOf(ArquivoNaoLido);
  });
});

describe("lerLinkDoGoogle", () => {
  it("reconhece Docs, Planilhas, Apresentações e Drive", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    expect(lerLinkDoGoogle(`https://docs.google.com/document/d/${id}/edit?usp=sharing`)).toEqual({ tipo: "doc", id });
    expect(lerLinkDoGoogle(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toEqual({ tipo: "planilha", id });
    expect(lerLinkDoGoogle(`https://docs.google.com/presentation/d/${id}/edit`)).toEqual({ tipo: "apresentacao", id });
    expect(lerLinkDoGoogle(`https://drive.google.com/file/d/${id}/view?usp=sharing`)).toEqual({ tipo: "arquivo", id });
    expect(lerLinkDoGoogle(`https://drive.google.com/open?id=${id}`)).toEqual({ tipo: "arquivo", id });
  });

  it("recusa o que não é do Google, não é https ou tem id estranho (SSRF)", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    expect(lerLinkDoGoogle(`http://docs.google.com/document/d/${id}/edit`)).toBeNull();
    expect(lerLinkDoGoogle(`https://evil.com/document/d/${id}/edit`)).toBeNull();
    expect(lerLinkDoGoogle(`https://docs.google.com.evil.com/document/d/${id}/edit`)).toBeNull();
    expect(lerLinkDoGoogle("https://docs.google.com/document/d/../../etc/passwd")).toBeNull();
    expect(lerLinkDoGoogle("https://docs.google.com/document/d/curto/edit")).toBeNull();
    expect(lerLinkDoGoogle("não é um link")).toBeNull();
  });
});

describe("lerDocumentoDoGoogle (rede falsa)", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const resposta = (corpo: BodyInit | null, init: ResponseInit & { headers?: Record<string, string> } = {}) => new Response(corpo, init);

  it("Documento: busca o endereço de exportação montado aqui (não o link colado)", async () => {
    const pedidos: string[] = [];
    const r = await lerDocumentoDoGoogle({ tipo: "doc", id }, async (url) => {
      pedidos.push(url);
      return resposta("﻿Somos a Agro Sul.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    });
    expect(pedidos).toEqual([`https://docs.google.com/document/d/${id}/export?format=txt`]);
    expect(r).toMatchObject({ fonte: "texto", texto: "Somos a Agro Sul." });
  });

  it("Planilha: lê as abas do xlsx exportado", async () => {
    const xlsx = await xlsxComLinhas();
    const r = await lerDocumentoDoGoogle({ tipo: "planilha", id }, async () => resposta(xlsx as unknown as BodyInit, { headers: { "content-type": "application/octet-stream" } }));
    expect(r.fonte).toBe("excel");
    expect(r.texto).toContain("Inoculante | R$ 45,00");
  });

  it("Arquivo do Drive: o tipo vem do conteúdo quando o nome não ajuda", async () => {
    const r = await lerDocumentoDoGoogle({ tipo: "arquivo", id }, async () => resposta(pdfComTexto("Tabela de precos") as unknown as BodyInit, { headers: { "content-type": "application/pdf" } }));
    expect(r.fonte).toBe("pdf");
    expect(r.texto).toContain("Tabela de precos");
  });

  it("arquivo privado: o Google manda para o login e a pessoa recebe o passo a passo", async () => {
    await expect(
      lerDocumentoDoGoogle({ tipo: "doc", id }, async () => resposta(null, { status: 302, headers: { location: "https://accounts.google.com/ServiceLogin?x=1" } })),
    ).rejects.toThrow(/Qualquer pessoa com o link/);
    await expect(lerDocumentoDoGoogle({ tipo: "doc", id }, async () => resposta("<html>login</html>", { headers: { "content-type": "text/html" } }))).rejects.toThrow(/Qualquer pessoa com o link/);
    await expect(lerDocumentoDoGoogle({ tipo: "doc", id }, async () => resposta("", { status: 403 }))).rejects.toThrow(/Qualquer pessoa com o link/);
  });

  it("redirecionamento para fora do Google é recusado", async () => {
    let chamadas = 0;
    await expect(
      lerDocumentoDoGoogle({ tipo: "doc", id }, async () => {
        chamadas += 1;
        return resposta(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
      }),
    ).rejects.toThrow(ArquivoNaoLido);
    expect(chamadas).toBe(1);
  });

  it("segue redirecionamento para o domínio de download do Google", async () => {
    const r = await lerDocumentoDoGoogle({ tipo: "doc", id }, async (url) =>
      url.startsWith("https://docs.google.com")
        ? resposta(null, { status: 307, headers: { location: "https://doc-0s-abc.googleusercontent.com/export/x" } })
        : resposta("Texto do documento", { headers: { "content-type": "text/plain" } }),
    );
    expect(r.texto).toBe("Texto do documento");
  });

  it("404 e erro de rede viram frases claras", async () => {
    await expect(lerDocumentoDoGoogle({ tipo: "doc", id }, async () => resposta("", { status: 404 }))).rejects.toThrow(/Confira o link/);
    await expect(
      lerDocumentoDoGoogle({ tipo: "doc", id }, async () => {
        throw new Error("ECONNRESET");
      }),
    ).rejects.toThrow(/Tente de novo/);
  });
});
