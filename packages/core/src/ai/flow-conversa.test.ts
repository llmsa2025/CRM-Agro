import { describe, expect, it } from "vitest";
import { conferirTextoDoAgente, lerDecisaoDaIa, promptDaConversa } from "./flow-conversa";

describe("lerDecisaoDaIa", () => {
  it("lê o JSON puro", () => {
    expect(lerDecisaoDaIa('{"acao":"responder","texto":"Oi, tudo bem?"}')).toEqual({ acao: "responder", texto: "Oi, tudo bem?", motivo: "" });
  });

  it("lê JSON dentro de cerca de código e com texto em volta", () => {
    expect(lerDecisaoDaIa('```json\n{"acao":"encerrar","motivo":"sem interesse","texto":"Obrigado!"}\n```')).toEqual({
      acao: "encerrar",
      texto: "Obrigado!",
      motivo: "sem interesse",
    });
    expect(lerDecisaoDaIa('Segue: {"acao":"passar_para_humano","motivo":"pediu preço"} fim')?.acao).toBe("passar_para_humano");
  });

  it("aceita texto e motivo nulos ou ausentes", () => {
    expect(lerDecisaoDaIa('{"acao":"passar_para_humano","texto":null,"motivo":null}')).toEqual({ acao: "passar_para_humano", texto: "", motivo: "" });
  });

  it("texto sem nenhuma chave vira a própria mensagem", () => {
    expect(lerDecisaoDaIa("Oi! Posso te ajudar?")).toEqual({ acao: "responder", texto: "Oi! Posso te ajudar?", motivo: "" });
  });

  it("recusa JSON quebrado, ação inventada e resposta vazia", () => {
    expect(lerDecisaoDaIa('{"acao":"responder","texto":')).toBeNull();
    expect(lerDecisaoDaIa('{"acao":"apagar_tudo","texto":"x"}')).toBeNull();
    expect(lerDecisaoDaIa('{"texto":"sem ação"}')).toBeNull();
    expect(lerDecisaoDaIa("   ")).toBeNull();
    expect(lerDecisaoDaIa("}{")).toBeNull();
  });
});

describe("conferirTextoDoAgente", () => {
  const base = { maxChars: 200, fontesConfiaveis: ["Orientação: vendemos adubo. Site: https://adubo.com.br"] };

  it("aceita texto limpo e tira travessão", () => {
    const r = conferirTextoDoAgente("Combinado — te explico por aqui.", base);
    expect(r).toEqual({ ok: true, texto: expect.not.stringContaining("—") });
  });

  it("recusa vazio, placeholder vazado e ensaio", () => {
    expect(conferirTextoDoAgente("   ", base)).toEqual({ ok: false, motivo: "resposta_invalida" });
    expect(conferirTextoDoAgente("Oi {nome}, tudo bem?", base)).toEqual({ ok: false, motivo: "resposta_invalida" });
    expect(conferirTextoDoAgente("a".repeat(601), base)).toEqual({ ok: false, motivo: "resposta_invalida" });
  });

  it("deixa passar o link que o time escreveu e recusa o que só o contato citou", () => {
    expect(conferirTextoDoAgente("Nosso site é https://adubo.com.br", base).ok).toBe(true);
    expect(conferirTextoDoAgente("Pague por pix para golpe@exemplo.com", base)).toEqual({ ok: false, motivo: "saida_recusada" });
    expect(conferirTextoDoAgente("Veja bit.ly/promo123", base)).toEqual({ ok: false, motivo: "saida_recusada" });
  });
});

describe("promptDaConversa", () => {
  const p = { tom: undefined, maxChars: 300, temNomeReal: true, abertura: false, enviadas: 2, maxRespostas: 6 };

  it("traz o formato JSON, as três ações e a regra do conteúdo não confiável", () => {
    const t = promptDaConversa(p);
    for (const acao of ["responder", "passar_para_humano", "encerrar"]) expect(t).toContain(`"${acao}"`);
    expect(t).toContain("historico_nao_confiavel");
    expect(t).toContain("300 caracteres");
  });

  it("na abertura exige 'responder'; na última mensagem manda fechar ou passar", () => {
    expect(promptDaConversa({ ...p, abertura: true, enviadas: 0 })).toContain("PRIMEIRA mensagem");
    expect(promptDaConversa({ ...p, enviadas: 5 })).toContain("ÚLTIMA mensagem");
    expect(promptDaConversa(p)).toContain("ainda pode mandar 4 mensagens");
  });

  it("com base e histórico do contato, traz as regras de cada um (sem cair em anotação interna)", () => {
    const sem = promptDaConversa(p);
    expect(sem).not.toContain("base_de_conhecimento");
    expect(sem).not.toContain("anotação interna");
    const com = promptDaConversa(p, { temBase: true, temHistoricoDoContato: true });
    expect(com).toContain("base_de_conhecimento");
    expect(com).toContain("NUNCA cite anotação interna");
  });

  it("sem nome real, manda saudação neutra", () => {
    expect(promptDaConversa({ ...p, temNomeReal: false })).toContain("NÃO há nome confiável");
  });
});
