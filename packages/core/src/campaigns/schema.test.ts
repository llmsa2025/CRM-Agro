import { describe, it, expect } from "vitest";
import { renderTemplate } from "../flows/executor";
import { VARIAVEIS_DA_MENSAGEM, etapaMensagemSchema, etapaRitmoSchema, variaveisDesconhecidas } from "./schema";

/**
 * A lista de variáveis aceitas na mensagem da campanha precisa bater com o que
 * o `renderTemplate` do motor preenche: variável aceita e não trocada iria
 * LITERAL para o lead ("Oi {cultura}").
 */
describe("variáveis da mensagem", () => {
  it("toda variável aceita é trocada pelo renderTemplate (nenhuma fica literal)", () => {
    const vars = {
      id: "c1",
      nome: "Ana Paula",
      tags: [],
      ownerId: null,
      sobrenome: "Souza",
      empresa: "Fazenda X",
      cargo: "Gerente",
      cidade: "Sorriso",
      estado: "MT",
      empresaCidade: "Sorriso",
      empresaEstado: "MT",
    };
    for (const v of VARIAVEIS_DA_MENSAGEM) {
      expect(renderTemplate(`{${v}}`, vars), v).not.toContain("{");
    }
    expect(variaveisDesconhecidas("Oi {primeiro_nome|tudo bem}, {cultura} e {saudacao}")).toEqual(["cultura"]);
  });

  it("recusa link (http e www) e aceita fallback com espaço", () => {
    expect(etapaMensagemSchema.safeParse({ mensagem: "veja www.site.com.br" }).success).toBe(false);
    expect(etapaMensagemSchema.safeParse({ mensagem: "{saudacao}, {primeiro_nome|tudo bem}?" }).success).toBe(true);
  });

  it("ritmo: almoço dentro da janela, mínimo ≤ máximo e piso de 30 s entre mensagens", () => {
    const base = {
      channelAccountId: "00000000-0000-0000-0000-000000000001",
      janelaInicio: "08:30",
      janelaFim: "17:30",
      pausaAlmocoInicio: "11:30",
      pausaAlmocoFim: "13:30",
      intervaloMinS: 60,
      intervaloMaxS: 180,
      loteTamanho: 20,
      pausaLoteMinM: 15,
      pausaLoteMaxM: 25,
      freioSaidasPct: 3,
      freioFalhasSeq: 5,
    };
    expect(etapaRitmoSchema.safeParse(base).success).toBe(true);
    expect(etapaRitmoSchema.safeParse({ ...base, pausaAlmocoInicio: "07:00" }).success).toBe(false);
    expect(etapaRitmoSchema.safeParse({ ...base, intervaloMinS: 200 }).success).toBe(false);
    expect(etapaRitmoSchema.safeParse({ ...base, intervaloMinS: 10, intervaloMaxS: 20 }).success).toBe(false);
    expect(etapaRitmoSchema.safeParse({ ...base, pausaAlmocoInicio: null, pausaAlmocoFim: null }).success).toBe(true);
    expect(etapaRitmoSchema.safeParse({ ...base, pausaAlmocoFim: null }).success).toBe(false);
  });
});

describe("links na mensagem da campanha", () => {
  const ok = (t: string) => etapaMensagemSchema.safeParse({ mensagem: t }).success;

  it("aceita link de vídeo do YouTube e do Instagram, com ou sem https e www", () => {
    expect(ok("Olha esse vídeo: https://www.youtube.com/watch?v=abc123")).toBe(true);
    expect(ok("Olha: https://youtu.be/abc123")).toBe(true);
    expect(ok("Veja https://www.instagram.com/reel/Cxyz/")).toBe(true);
    expect(ok("Veja www.instagram.com/p/1/")).toBe(true);
    expect(ok("Veja https://m.youtube.com/watch?v=1")).toBe(true);
  });

  it("recusa qualquer outro link, inclusive parecido com os liberados", () => {
    expect(ok("Veja https://x.com")).toBe(false);
    expect(ok("https://youtube.com.golpe.com/watch")).toBe(false);
    expect(ok("https://golpe.com/youtube.com")).toBe(false);
    expect(ok("https://notyoutube.com/x")).toBe(false);
    expect(ok("Vídeo https://youtu.be/abc e site https://loja.com")).toBe(false);
  });
});
