import { describe, expect, it } from "vitest";
import { fabricarIdDeEvento } from "./comum";
import {
  CAUSAS_DE_LIGACAO,
  FatoDeLigacaoSchema,
  PontaDeLigacaoSchema,
  ResultadoDaConsultaDeLigacaoSchema,
  ResultadoDaNormalizacaoDeLigacaoSchema,
  SinalEfemeroDeLigacaoSchema,
  TIPOS_DE_FATO_DE_LIGACAO,
  type TipoDeFatoDeLigacao,
} from "./fato";

const UUID = "0b8f6b0e-6f0e-4f8e-9a52-3f1c1d2a4b5c";
const AGORA = "2026-10-16T12:00:00-03:00";

const base = { idEvento: "ev_1", ocorridoEm: AGORA, providerCallId: "pc_1" };
const semProviderCallId = { idEvento: "ev_1", ocorridoEm: AGORA };

const fatos: Record<TipoDeFatoDeLigacao, Record<string, unknown>> = {
  chamando: { ...base, tipo: "chamando" },
  atendida: { ...base, tipo: "atendida" },
  recusada: { ...base, tipo: "recusada" },
  encerrada: { ...base, tipo: "encerrada", causa: "atendida", atendidaEm: AGORA, duracaoConectadaS: 42, codigoDoProvedor: "NORMAL_CLEARING" },
  falhou_ao_originar: { ...base, tipo: "falhou_ao_originar", causa: "falha_de_rede" },
  gravacao_pronta: { ...base, tipo: "gravacao_pronta", refGravacao: "arq_123", sha256: "a".repeat(64), mime: "audio/mpeg", expiraEm: AGORA },
};

const ok = (x: unknown) => FatoDeLigacaoSchema.safeParse(x).success;

describe("fato de ligação", () => {
  it("aceita cada um dos 6 tipos", () => {
    expect(Object.keys(fatos).sort()).toEqual([...TIPOS_DE_FATO_DE_LIGACAO].sort());
    for (const [tipo, f] of Object.entries(fatos)) expect(ok(f), tipo).toBe(true);
  });

  it("aceita só os campos obrigatórios de cada tipo", () => {
    expect(ok({ ...base, tipo: "encerrada", causa: "desconhecida" })).toBe(true);
    expect(ok({ ...base, tipo: "gravacao_pronta", refGravacao: "arq_1", mime: "audio/ogg" })).toBe(true);
  });

  it("recusa telefone, from, to, sdp, nome, corpo e qualquer campo desconhecido, em todo tipo", () => {
    const proibidos = { telefone: "+5511999999999", from: "1001", to: "+5511999999999", sdp: "v=0", nome: "Fulano", corpo: "{}", called: "1", bina: "2" };
    for (const [tipo, f] of Object.entries(fatos)) {
      for (const [campo, valor] of Object.entries(proibidos)) expect(ok({ ...f, [campo]: valor }), `${tipo}+${campo}`).toBe(false);
    }
  });

  it("recusa tipo desconhecido e fato sem tipo", () => {
    expect(ok({ ...base, tipo: "tocando" })).toBe(false);
    expect(ok(base)).toBe(false);
  });

  it("recusa fato sem providerCallId e sem refDaLigacao", () => {
    expect(ok({ ...semProviderCallId, tipo: "chamando" })).toBe(false);
  });

  it("aceita só com providerCallId, só com refDaLigacao, ou com os dois", () => {
    expect(ok({ ...base, tipo: "chamando" })).toBe(true);
    expect(ok({ ...semProviderCallId, refDaLigacao: UUID, tipo: "chamando" })).toBe(true);
    expect(ok({ ...base, refDaLigacao: UUID, tipo: "chamando" })).toBe(true);
  });

  it("refDaLigacao precisa ser uuid e refDaLinha precisa ter conta e id", () => {
    expect(ok({ ...base, tipo: "chamando", refDaLigacao: "ligacao-1" })).toBe(false);
    expect(ok({ ...base, tipo: "chamando", refDaLinha: { contaExterna: "empresa", idExterno: "1001" } })).toBe(true);
    expect(ok({ ...base, tipo: "chamando", refDaLinha: { contaExterna: "empresa" } })).toBe(false);
    expect(ok({ ...base, tipo: "chamando", refDaLinha: { contaExterna: "empresa", idExterno: "1001", nome: "x" } })).toBe(false);
  });

  it("idEvento: ASCII visível, sem espaço, até 200; o id fabricado serve", () => {
    expect(ok({ ...fatos.chamando, idEvento: fabricarIdDeEvento("api4com", "pc_1", "chamando", "aviso") })).toBe(true);
    expect(ok({ ...fatos.chamando, idEvento: "com espaço" })).toBe(false);
    expect(ok({ ...fatos.chamando, idEvento: "" })).toBe(false);
    expect(ok({ ...fatos.chamando, idEvento: "a".repeat(201) })).toBe(false);
    expect(ok({ ...fatos.chamando, idEvento: "a".repeat(200) })).toBe(true);
  });

  it("o mesmo aviso fabricado duas vezes tem o mesmo idEvento", () => {
    const a = fabricarIdDeEvento("api4com", "pc_1", "encerrada", "aviso");
    const b = fabricarIdDeEvento("api4com", "pc_1", "encerrada", "aviso");
    expect(a).toBe(b);
    expect(fabricarIdDeEvento("api4com", "pc_1", "chamando", "aviso")).not.toBe(a);
  });

  it("ocorridoEm precisa ser instante ISO com fuso", () => {
    expect(ok({ ...fatos.chamando, ocorridoEm: "2026-10-16" })).toBe(false);
    expect(ok({ ...fatos.chamando, ocorridoEm: "ontem" })).toBe(false);
    expect(ok({ ...fatos.chamando, ocorridoEm: "2026-10-16T12:00:00Z" })).toBe(true);
  });

  it("as 11 causas neutras valem e nenhuma outra", () => {
    expect(CAUSAS_DE_LIGACAO).toHaveLength(11);
    for (const causa of CAUSAS_DE_LIGACAO) {
      expect(ok({ ...base, tipo: "encerrada", causa }), causa).toBe(true);
      expect(ok({ ...base, tipo: "falhou_ao_originar", causa }), causa).toBe(true);
    }
    expect(ok({ ...base, tipo: "encerrada", causa: "ocupada" })).toBe(false);
    expect(ok({ ...base, tipo: "encerrada" })).toBe(false);
    expect(ok({ ...base, tipo: "falhou_ao_originar" })).toBe(false);
  });

  it("encerrada: duração inteira e não negativa, código até 40 caracteres e sem número de telefone", () => {
    const enc = (x: Record<string, unknown>) => ok({ ...base, tipo: "encerrada", causa: "atendida", ...x });
    expect(enc({ duracaoConectadaS: 0 })).toBe(true);
    expect(enc({ duracaoConectadaS: -1 })).toBe(false);
    expect(enc({ duracaoConectadaS: 1.5 })).toBe(false);
    expect(enc({ duracaoConectadaS: 90_000 })).toBe(false);
    expect(enc({ codigoDoProvedor: "x".repeat(40) })).toBe(true);
    expect(enc({ codigoDoProvedor: "x".repeat(41) })).toBe(false);
    expect(enc({ codigoDoProvedor: "" })).toBe(false);
    expect(enc({ codigoDoProvedor: "480" })).toBe(true);
    expect(enc({ codigoDoProvedor: "5511999999999" })).toBe(false);
    expect(enc({ atendidaEm: "ontem" })).toBe(false);
  });

  it("gravacao_pronta: refGravacao nunca é URL, sha256 em hex minúsculo e mime em minúsculas", () => {
    const grav = (x: Record<string, unknown>) => ok({ ...base, tipo: "gravacao_pronta", refGravacao: "arq_1", mime: "audio/mpeg", ...x });
    expect(grav({})).toBe(true);
    expect(grav({ refGravacao: "https://listener.exemplo.invalid/a.mp3?token=abc" })).toBe(false);
    expect(grav({ refGravacao: "HTTP://exemplo.invalid/a.mp3" })).toBe(false);
    expect(grav({ refGravacao: "com espaço" })).toBe(false);
    expect(grav({ refGravacao: "" })).toBe(false);
    expect(grav({ sha256: "A".repeat(64) })).toBe(false);
    expect(grav({ sha256: "a".repeat(63) })).toBe(false);
    expect(grav({ mime: "mp3" })).toBe(false);
    expect(grav({ mime: "AUDIO/MPEG" })).toBe(false);
    expect(grav({ refGravacao: undefined })).toBe(false);
    expect(grav({ mime: undefined })).toBe(false);
  });

  it("o erro de validação não repete valores recebidos", () => {
    const r = FatoDeLigacaoSchema.safeParse({ ...fatos.chamando, telefone: "+5511999999999" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? {} : r.error.issues)).not.toContain("5511999999999");
  });
});

describe("sinal efêmero e ponta", () => {
  const sinal = { tipo: "sdp_resposta", valor: "v=0\r\n", providerCallId: "pc_1" };

  it("aceita a resposta SDP, com refDaLigacao opcional", () => {
    expect(SinalEfemeroDeLigacaoSchema.safeParse(sinal).success).toBe(true);
    expect(SinalEfemeroDeLigacaoSchema.safeParse({ ...sinal, refDaLigacao: UUID }).success).toBe(true);
  });

  it("valor até 16 KB, não vazio, sem campo desconhecido nem tipo desconhecido", () => {
    expect(SinalEfemeroDeLigacaoSchema.safeParse({ ...sinal, valor: "a".repeat(16 * 1024) }).success).toBe(true);
    expect(SinalEfemeroDeLigacaoSchema.safeParse({ ...sinal, valor: "a".repeat(16 * 1024 + 1) }).success).toBe(false);
    expect(SinalEfemeroDeLigacaoSchema.safeParse({ ...sinal, valor: "" }).success).toBe(false);
    expect(SinalEfemeroDeLigacaoSchema.safeParse({ ...sinal, telefone: "+5511999999999" }).success).toBe(false);
    expect(SinalEfemeroDeLigacaoSchema.safeParse({ ...sinal, tipo: "sdp_oferta" }).success).toBe(false);
    expect(SinalEfemeroDeLigacaoSchema.safeParse({ tipo: "sdp_resposta", valor: "v=0" }).success).toBe(false);
  });

  it("ponta: destino em E.164, origem opcional, sem campo desconhecido", () => {
    const p = (x: Record<string, unknown>) => PontaDeLigacaoSchema.safeParse({ idEvento: "ev_1", ...x }).success;
    expect(p({})).toBe(true);
    expect(p({ destinoE164: "+5511999999999", origemExterna: "1001" })).toBe(true);
    expect(p({ destinoE164: "11999999999" })).toBe(false);
    expect(p({ destinoE164: "+0123456789" })).toBe(false);
    expect(p({ nome: "Fulano" })).toBe(false);
    expect(PontaDeLigacaoSchema.safeParse({ destinoE164: "+5511999999999" }).success).toBe(false);
  });
});

describe("resultado da normalização e da consulta", () => {
  const ponta = { idEvento: "ev_1", destinoE164: "+5511999999999", origemExterna: "1001" };

  it("aceita fatos com suas pontas e sinais", () => {
    const r = ResultadoDaNormalizacaoDeLigacaoSchema.safeParse({
      fatos: [fatos.encerrada],
      sinais: [{ tipo: "sdp_resposta", valor: "v=0", providerCallId: "pc_1" }],
      pontas: [ponta],
    });
    expect(r.success).toBe(true);
    expect(ResultadoDaConsultaDeLigacaoSchema.safeParse({ fatos: [fatos.encerrada], pontas: [ponta] }).success).toBe(true);
  });

  it("aceita resultado vazio (evento que o CRM Agro não entende)", () => {
    expect(ResultadoDaNormalizacaoDeLigacaoSchema.safeParse({ fatos: [], sinais: [], pontas: [] }).success).toBe(true);
  });

  it("recusa ponta sem o fato dela", () => {
    expect(ResultadoDaNormalizacaoDeLigacaoSchema.safeParse({ fatos: [], sinais: [], pontas: [ponta] }).success).toBe(false);
    expect(ResultadoDaConsultaDeLigacaoSchema.safeParse({ fatos: [fatos.chamando], pontas: [{ ...ponta, idEvento: "outro" }] }).success).toBe(false);
  });

  it("um fato inválido reprova o resultado inteiro", () => {
    const r = ResultadoDaNormalizacaoDeLigacaoSchema.safeParse({ fatos: [fatos.encerrada, { ...fatos.chamando, telefone: "x" }], sinais: [], pontas: [] });
    expect(r.success).toBe(false);
  });

  it("recusa campo desconhecido no resultado e passa de 200 fatos", () => {
    expect(ResultadoDaNormalizacaoDeLigacaoSchema.safeParse({ fatos: [], sinais: [], pontas: [], corpo: "{}" }).success).toBe(false);
    const muitos = Array.from({ length: 201 }, (_, i) => ({ ...fatos.chamando, idEvento: `ev_${i}` }));
    expect(ResultadoDaConsultaDeLigacaoSchema.safeParse({ fatos: muitos, pontas: [] }).success).toBe(false);
  });
});
