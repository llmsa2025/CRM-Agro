import { describe, expect, it } from "vitest";
import {
  ANEXO_ACCEPT,
  MAX_ANEXO_BYTES,
  arquivosColados,
  arrasteTemArquivos,
  contadorDeArraste,
  tipoAceito,
  tipoDoAnexo,
  validarAnexos,
} from "./anexar-arquivos";
// Arquivo puro do servidor (sem imports): serve de fiscal para o espelho daqui não se afastar da regra real.
import { MAX_MEDIA_BYTES, isMediaMimeAllowed } from "../../../packages/core/src/storage/media-policy";

const MB = 1024 * 1024;
const arq = (name: string, type: string, size = 1024) => ({ name, type, size });

describe("arrasteTemArquivos", () => {
  it("arraste de arquivo (types com Files) conta", () => {
    expect(arrasteTemArquivos(["Files"])).toBe(true);
    expect(arrasteTemArquivos(["text/uri-list", "Files", "text/html"])).toBe(true);
  });
  it("texto selecionado e link arrastado NÃO contam", () => {
    expect(arrasteTemArquivos(["text/plain"])).toBe(false);
    expect(arrasteTemArquivos(["text/plain", "text/html"])).toBe(false);
    expect(arrasteTemArquivos(["text/uri-list", "text/plain"])).toBe(false);
  });
  it("sem types (null, undefined, vazio) não conta", () => {
    expect(arrasteTemArquivos(null)).toBe(false);
    expect(arrasteTemArquivos(undefined)).toBe(false);
    expect(arrasteTemArquivos([])).toBe(false);
  });
  it("aceita array-like (DOMStringList de navegador antigo)", () => {
    const parecidoComDOMStringList = { length: 2, 0: "text/plain", 1: "Files" } as ArrayLike<string>;
    expect(arrasteTemArquivos(parecidoComDOMStringList)).toBe(true);
    expect(arrasteTemArquivos({ length: 1, 0: "text/plain" } as ArrayLike<string>)).toBe(false);
  });
  it("não confunde com tipo parecido", () => {
    expect(arrasteTemArquivos(["files"])).toBe(false);
    expect(arrasteTemArquivos(["application/x-moz-file"])).toBe(false);
  });
});

describe("contadorDeArraste", () => {
  it("passar por elementos filhos não faz a sobreposição sumir", () => {
    // entra na área (1), entra num filho (2), sai do filho (1): segue arrastando.
    let c = 0;
    c = contadorDeArraste(c, "entrou");
    c = contadorDeArraste(c, "entrou");
    c = contadorDeArraste(c, "saiu");
    expect(c).toBe(1);
    // sai da área de vez: zera.
    c = contadorDeArraste(c, "saiu");
    expect(c).toBe(0);
  });
  it("nunca fica negativo (saída sem entrada)", () => {
    expect(contadorDeArraste(0, "saiu")).toBe(0);
    expect(contadorDeArraste(contadorDeArraste(0, "saiu"), "entrou")).toBe(1);
  });
  it("soltar e reiniciar zeram, mesmo com contagem alta", () => {
    expect(contadorDeArraste(3, "soltou")).toBe(0);
    expect(contadorDeArraste(5, "reiniciar")).toBe(0);
  });
});

describe("tipoDoAnexo", () => {
  it("escolhe imagem, áudio ou documento como o servidor", () => {
    expect(tipoDoAnexo("image/png")).toBe("image");
    expect(tipoDoAnexo("audio/webm")).toBe("audio");
    expect(tipoDoAnexo("audio/ogg; codecs=opus")).toBe("audio");
    expect(tipoDoAnexo("application/pdf")).toBe("doc");
    expect(tipoDoAnexo("video/mp4")).toBe("doc");
    expect(tipoDoAnexo("")).toBe("doc");
  });
  it("ignora maiúsculas e espaços", () => {
    expect(tipoDoAnexo("  IMAGE/JPEG ")).toBe("image");
  });
});

describe("tipoAceito", () => {
  it("aceita imagem, áudio, PDF, Office e CSV", () => {
    for (const t of [
      "image/png",
      "image/jpeg",
      "audio/mpeg",
      "audio/ogg; codecs=opus",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
    ]) {
      expect(tipoAceito(t), t).toBe(true);
    }
  });
  it("recusa SVG, HTML, executável, texto puro e sem tipo", () => {
    for (const t of ["image/svg+xml", "text/html", "application/x-msdownload", "application/octet-stream", "text/plain", "application/zip", ""]) {
      expect(tipoAceito(t), t || "(vazio)").toBe(false);
    }
  });
  it("bate com a regra do servidor para uma lista de tipos", () => {
    const tipos = [
      "image/png", "image/webp", "image/svg+xml", "IMAGE/PNG", "audio/webm", "audio/ogg; codecs=opus",
      "video/mp4", "video/webm", "application/pdf", "application/zip", "application/octet-stream",
      "text/csv", "text/plain", "text/html", "application/msword", "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint", "application/vnd.oasis.opendocument.text", "application/json", "",
    ];
    for (const t of tipos) expect(tipoAceito(t), t || "(vazio)").toBe(isMediaMimeAllowed(t));
  });
  it("o teto de tamanho é o mesmo do servidor", () => {
    expect(MAX_ANEXO_BYTES).toBe(MAX_MEDIA_BYTES);
  });
});

describe("validarAnexos", () => {
  it("um arquivo válido passa e volta o próprio arquivo", () => {
    const f = arq("foto.png", "image/png", 2 * MB);
    const r = validarAnexos([f]);
    expect(r).toEqual({ ok: true, arquivo: f });
  });
  it("lista vazia: nada a fazer, sem aviso", () => {
    expect(validarAnexos([])).toEqual({ ok: false, erro: "" });
  });
  it("mais de um arquivo: recusa tudo e diz quantos vieram", () => {
    const r = validarAnexos([arq("a.png", "image/png"), arq("b.png", "image/png"), arq("c.pdf", "application/pdf")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toBe("Anexe um arquivo por vez. Vieram 3.");
  });
  it("arquivo vazio", () => {
    const r = validarAnexos([arq("vazio.pdf", "application/pdf", 0)]);
    expect(r).toEqual({ ok: false, erro: "“vazio.pdf” está vazio." });
  });
  it("passou de 25 MB (o limite exato passa)", () => {
    expect(validarAnexos([arq("ok.pdf", "application/pdf", MAX_ANEXO_BYTES)]).ok).toBe(true);
    const r = validarAnexos([arq("grande.pdf", "application/pdf", MAX_ANEXO_BYTES + 1)]);
    expect(r).toEqual({ ok: false, erro: "“grande.pdf” passa de 25 MB." });
  });
  it("tipo não aceito diz o que dá para enviar", () => {
    const r = validarAnexos([arq("programa.exe", "application/x-msdownload")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.erro).toContain("programa.exe");
      expect(r.erro).toContain("imagem, áudio, PDF ou documento");
    }
  });
  it("arquivo sem tipo (o navegador não soube dizer) é recusado", () => {
    expect(validarAnexos([arq("coisa", "")]).ok).toBe(false);
  });
  it("nome enorme é encurtado no aviso", () => {
    const r = validarAnexos([arq(`${"a".repeat(200)}.exe`, "application/x-msdownload")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro.length).toBeLessThan(120);
  });
  it("as mensagens não usam travessão", () => {
    const erros = [
      validarAnexos([arq("a", "image/png"), arq("b", "image/png")]),
      validarAnexos([arq("v", "image/png", 0)]),
      validarAnexos([arq("g", "image/png", MAX_ANEXO_BYTES + 1)]),
      validarAnexos([arq("x", "application/zip")]),
    ];
    for (const r of erros) if (!r.ok) expect(r.erro).not.toMatch(/[—–]/);
  });
});

describe("arquivosColados", () => {
  it("print de tela (só imagem, sem texto) vira anexo", () => {
    const img = arq("image.png", "image/png");
    expect(arquivosColados([img], "")).toEqual([img]);
    expect(arquivosColados([img], "   ")).toEqual([img]);
  });
  it("trecho copiado do Excel/Word (texto + imagem do trecho) continua sendo texto", () => {
    expect(arquivosColados([arq("image.png", "image/png")], "A1\tB1")).toEqual([]);
  });
  it("sem arquivo nenhum não há o que anexar", () => {
    expect(arquivosColados([], "")).toEqual([]);
    expect(arquivosColados([], "texto")).toEqual([]);
  });
});

describe("ANEXO_ACCEPT", () => {
  it("continua oferecendo no seletor do clipe imagem, áudio e PDF", () => {
    expect(ANEXO_ACCEPT).toContain("image/*");
    expect(ANEXO_ACCEPT).toContain("audio/*");
    expect(ANEXO_ACCEPT).toContain("application/pdf");
  });
});
