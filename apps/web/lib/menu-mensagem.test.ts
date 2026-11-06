import { describe, expect, it } from "vitest";
import {
  MAX_DESTINOS_ENCAMINHAR,
  MAX_MENSAGENS_ENCAMINHAR,
  dedoAndouDemais,
  ehTeclaDoMenu,
  podeCompartilhar,
  proximoIndiceDaLista,
  resumoDoEncaminhamento,
  rotuloDaMensagem,
  rotuloDeSelecionadas,
  selecionadasEmOrdem,
  situacaoDoCompartilhar,
  textoCopiavel,
  textoDasMensagens,
  textoParaCopiar,
  type MensagemDoMenu,
} from "./menu-mensagem";
// Arquivo puro do servidor (sem imports): fiscal para os limites daqui não se afastarem dos de lá.
import * as limitesDoServidor from "../../../packages/core/src/conversations/encaminhar-limites";

const msg = (o: Partial<MensagemDoMenu> & { id?: string } = {}): MensagemDoMenu => ({
  id: o.id ?? "m1",
  tipo: o.tipo ?? "text",
  conteudo: o.conteudo === undefined ? "Olá" : o.conteudo,
  mediaUrl: o.mediaUrl ?? null,
  status: o.status ?? "sent",
});

describe("limites", () => {
  it("são os mesmos do servidor", () => {
    expect(MAX_DESTINOS_ENCAMINHAR).toBe(limitesDoServidor.MAX_DESTINOS_ENCAMINHAR);
    expect(MAX_MENSAGENS_ENCAMINHAR).toBe(limitesDoServidor.MAX_MENSAGENS_ENCAMINHAR);
  });
});

describe("textoCopiavel", () => {
  it("texto e legenda de mídia copiam; documento e vazio não", () => {
    expect(textoCopiavel(msg({ conteudo: "Bom dia" }))).toBe("Bom dia");
    expect(textoCopiavel(msg({ tipo: "image", conteudo: "Legenda" }))).toBe("Legenda");
    expect(textoCopiavel(msg({ tipo: "doc", conteudo: "proposta.pdf" }))).toBeNull();
    expect(textoCopiavel(msg({ conteudo: "   " }))).toBeNull();
    expect(textoCopiavel(msg({ conteudo: null }))).toBeNull();
  });
  it("copia exatamente como está (sem cortar espaços nem quebras)", () => {
    expect(textoCopiavel(msg({ conteudo: "  a\nb  " }))).toBe("  a\nb  ");
  });
});

describe("textoParaCopiar (menu)", () => {
  it("trecho selecionado da própria mensagem vence; sem trecho, a mensagem toda", () => {
    expect(textoParaCopiar(msg({ conteudo: "Bom dia, tudo bem?" }), "tudo bem")).toBe("tudo bem");
    expect(textoParaCopiar(msg({ conteudo: "Bom dia" }), "")).toBe("Bom dia");
    expect(textoParaCopiar(msg({ conteudo: "Bom dia" }), "   ")).toBe("Bom dia");
    expect(textoParaCopiar(msg({ tipo: "doc", conteudo: "x.pdf" }), "")).toBeNull();
  });
});

describe("textoDasMensagens", () => {
  it("junta só as que têm texto, na ordem, uma por bloco", () => {
    const lista = [msg({ conteudo: "um" }), msg({ tipo: "doc", conteudo: "a.pdf" }), msg({ tipo: "image", conteudo: null }), msg({ conteudo: "dois" })];
    expect(textoDasMensagens(lista)).toBe("um\n\ndois");
  });
  it("nenhuma com texto: null", () => {
    expect(textoDasMensagens([msg({ tipo: "audio", conteudo: null })])).toBeNull();
    expect(textoDasMensagens([])).toBeNull();
  });
});

describe("podeCompartilhar", () => {
  it("texto com conteúdo e mídia com arquivo sim", () => {
    expect(podeCompartilhar(msg())).toBe(true);
    expect(podeCompartilhar(msg({ tipo: "image", conteudo: null, mediaUrl: "https://x/y.png" }))).toBe(true);
    expect(podeCompartilhar(msg({ tipo: "audio", conteudo: null, mediaUrl: "https://x/y.ogg" }))).toBe(true);
  });
  it("otimista, enviando, texto vazio e mídia sem arquivo não", () => {
    expect(podeCompartilhar(msg({ id: "temp-123" }))).toBe(false);
    expect(podeCompartilhar(msg({ status: "sending" }))).toBe(false);
    expect(podeCompartilhar(msg({ conteudo: "  " }))).toBe(false);
    expect(podeCompartilhar(msg({ tipo: "image", conteudo: "legenda", mediaUrl: null }))).toBe(false);
  });
});

describe("situacaoDoCompartilhar (barra de seleção)", () => {
  it("de 1 a 10 mensagens compartilháveis: pode", () => {
    expect(situacaoDoCompartilhar([msg()])).toEqual({ ok: true });
    const dez = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}` }));
    expect(situacaoDoCompartilhar(dez)).toEqual({ ok: true });
  });
  it("11 mensagens: recusa com o limite na frase", () => {
    const onze = Array.from({ length: 11 }, (_, i) => msg({ id: `m${i}` }));
    expect(situacaoDoCompartilhar(onze)).toEqual({ ok: false, motivo: "Para compartilhar, escolha até 10 mensagens." });
  });
  it("nenhuma, ou alguma que não dá: recusa", () => {
    expect(situacaoDoCompartilhar([]).ok).toBe(false);
    expect(situacaoDoCompartilhar([msg(), msg({ id: "temp-1" })]).ok).toBe(false);
  });
});

describe("selecionadasEmOrdem", () => {
  it("devolve na ordem da conversa, não na ordem do clique", () => {
    const lista = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(selecionadasEmOrdem(lista, new Set(["d", "b"])).map((m) => m.id)).toEqual(["b", "d"]);
    expect(selecionadasEmOrdem(lista, new Set(["zzz"]))).toEqual([]);
  });
});

describe("rótulos", () => {
  it("selecionadas no singular e no plural", () => {
    expect(rotuloDeSelecionadas(1)).toBe("1 selecionada");
    expect(rotuloDeSelecionadas(2)).toBe("2 selecionadas");
    expect(rotuloDeSelecionadas(10)).toBe("10 selecionadas");
  });
  it("resumo da mensagem: texto curto ou o tipo da mídia", () => {
    expect(rotuloDaMensagem(msg({ conteudo: "Olá,\n  tudo bem?" }))).toBe("Olá, tudo bem?");
    expect(rotuloDaMensagem(msg({ conteudo: "a".repeat(200) })).length).toBe(80);
    expect(rotuloDaMensagem(msg({ tipo: "image", conteudo: null }))).toBe("Imagem");
    expect(rotuloDaMensagem(msg({ tipo: "image", conteudo: "Foto da obra" }))).toBe("Imagem: Foto da obra");
    expect(rotuloDaMensagem(msg({ tipo: "audio", conteudo: "" }))).toBe("Áudio");
    expect(rotuloDaMensagem(msg({ tipo: "doc", conteudo: "proposta.pdf" }))).toBe("Documento");
  });
});

describe("teclado", () => {
  it("tecla de menu e Shift+F10 abrem; F10 sozinho e outras não", () => {
    expect(ehTeclaDoMenu({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(ehTeclaDoMenu({ key: "F10", shiftKey: true })).toBe(true);
    expect(ehTeclaDoMenu({ key: "F10", shiftKey: false })).toBe(false);
    expect(ehTeclaDoMenu({ key: "Enter", shiftKey: false })).toBe(false);
  });
  it("setas andam pela lista sem passar das pontas; Home e End vão às pontas", () => {
    expect(proximoIndiceDaLista(0, 5, "ArrowDown")).toBe(1);
    expect(proximoIndiceDaLista(4, 5, "ArrowDown")).toBe(4);
    expect(proximoIndiceDaLista(0, 5, "ArrowUp")).toBe(0);
    expect(proximoIndiceDaLista(3, 5, "ArrowUp")).toBe(2);
    expect(proximoIndiceDaLista(2, 5, "Home")).toBe(0);
    expect(proximoIndiceDaLista(2, 5, "End")).toBe(4);
  });
  it("outras teclas e lista vazia: sem movimento", () => {
    expect(proximoIndiceDaLista(2, 5, "a")).toBeNull();
    expect(proximoIndiceDaLista(0, 0, "ArrowDown")).toBeNull();
  });
});

describe("toque longo", () => {
  it("dedo parado ou quase parado ainda é toque longo; andou, é rolagem", () => {
    expect(dedoAndouDemais(0, 0)).toBe(false);
    expect(dedoAndouDemais(6, 6)).toBe(false); // ~8,5 px
    expect(dedoAndouDemais(10, 0)).toBe(false); // no limite
    expect(dedoAndouDemais(8, 8)).toBe(true); // ~11,3 px
    expect(dedoAndouDemais(0, -30)).toBe(true);
  });
});

describe("resumoDoEncaminhamento", () => {
  const destino = (nome: string, enviadas: number, total: number, erro: string | null = null, naoConfirmadas = 0) => ({
    conversationId: nome,
    nome,
    enviadas,
    naoConfirmadas,
    total,
    erro,
  });
  it("tudo certo: uma mensagem para uma conversa", () => {
    const r = resumoDoEncaminhamento({ destinos: [destino("Ana", 1, 1)], ok: 1, falhas: 0 }, 1);
    expect(r).toEqual({ tipo: "ok", titulo: "Mensagem encaminhada", detalhes: [], aviso: null });
  });
  it("tudo certo: várias mensagens para várias conversas", () => {
    const r = resumoDoEncaminhamento({ destinos: [destino("Ana", 3, 3), destino("Bia", 3, 3)], ok: 2, falhas: 0 }, 3);
    expect(r.titulo).toBe("3 mensagens encaminhadas para 2 conversas");
  });
  it("falha parcial: diz para quantas foi e por que as outras não", () => {
    const r = resumoDoEncaminhamento(
      { destinos: [destino("Ana", 1, 1), destino("Bia", 0, 1, "O número está pausado.")], ok: 1, falhas: 1 },
      1,
    );
    expect(r).toMatchObject({ tipo: "parcial", titulo: "Encaminhada para 1 de 2 conversas", detalhes: ["Bia: O número está pausado."] });
  });
  it("nada saiu", () => {
    const r = resumoDoEncaminhamento({ destinos: [destino("Bia", 0, 1, "Conversa não encontrada.")], ok: 0, falhas: 1 }, 1);
    expect(r).toMatchObject({ tipo: "erro", titulo: "Não foi possível encaminhar" });
  });
  it("saiu só uma parte das mensagens em todos os destinos", () => {
    const r = resumoDoEncaminhamento({ destinos: [destino("Ana", 1, 3, "Enviadas 1 de 3. Limite.")], ok: 0, falhas: 1 }, 3);
    expect(r).toMatchObject({ tipo: "parcial", titulo: "Só uma parte foi encaminhada" });
  });
  it("mídia sem confirmação vira aviso", () => {
    const r = resumoDoEncaminhamento({ destinos: [destino("Ana", 1, 1, null, 1)], ok: 1, falhas: 0 }, 1);
    expect(r.aviso).toMatch(/pode já ter chegado/);
  });
  it("as frases não usam travessão", () => {
    const todas = [
      resumoDoEncaminhamento({ destinos: [destino("A", 1, 1, null, 1)], ok: 1, falhas: 0 }, 1),
      resumoDoEncaminhamento({ destinos: [destino("A", 0, 1, "x")], ok: 0, falhas: 1 }, 1),
      resumoDoEncaminhamento({ destinos: [destino("A", 1, 3, "x")], ok: 0, falhas: 1 }, 3),
    ];
    for (const r of todas) expect([r.titulo, r.aviso ?? "", ...r.detalhes].join(" ")).not.toMatch(/[—–]/);
    expect(situacaoDoCompartilhar([])).toMatchObject({ motivo: expect.not.stringMatching(/[—–]/) });
  });
});
