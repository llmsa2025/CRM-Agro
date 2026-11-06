import { describe, expect, it } from "vitest";
import {
  CODIGOS_DE_ERRO_DE_LIGACAO,
  CredencialInvalidaDeLigacao,
  DestinoInvalidoDeLigacao,
  ErroDeLigacao,
  LimiteDeRequisicoesDeLigacao,
  LinhaOcupadaDeLigacao,
  MOTIVOS_DE_RECUSA_DE_LIGACAO,
  NaoEncontradoDeLigacao,
  NaoSuportadoDeLigacao,
  ProvedorIndisponivelDeLigacao,
  RecusadoPeloProvedorDeLigacao,
  TEXTO_DA_RECUSA_DE_LIGACAO,
  comoErroDeLigacao,
  ehErroDeLigacao,
  erroDeLigacaoParaLog,
} from "./erros";

const todos = (): ErroDeLigacao[] => [
  new CredencialInvalidaDeLigacao("api4com"),
  new ProvedorIndisponivelDeLigacao("api4com"),
  new LimiteDeRequisicoesDeLigacao("api4com", 1500),
  new DestinoInvalidoDeLigacao("api4com"),
  new RecusadoPeloProvedorDeLigacao("api4com", "sem_saldo"),
  new LinhaOcupadaDeLigacao("api4com"),
  new NaoEncontradoDeLigacao("api4com"),
  new NaoSuportadoDeLigacao("api4com", "originar"),
];

describe("erros neutros de ligação", () => {
  it("são 8, um por código, e cada código tem a sua classe", () => {
    expect(CODIGOS_DE_ERRO_DE_LIGACAO).toHaveLength(8);
    expect(todos().map((e) => e.codigo)).toEqual([...CODIGOS_DE_ERRO_DE_LIGACAO]);
  });

  it("todos são ErroDeLigacao e Error, e têm nome próprio", () => {
    for (const e of todos()) {
      expect(e).toBeInstanceOf(ErroDeLigacao);
      expect(e).toBeInstanceOf(Error);
      expect(ehErroDeLigacao(e)).toBe(true);
      expect(e.name).toMatch(/DeLigacao$/);
    }
    expect(ehErroDeLigacao(new Error("x"))).toBe(false);
    expect(ehErroDeLigacao("credencial_invalida")).toBe(false);
  });

  it("dizem o que fazer (ação) e se vale tentar de novo", () => {
    const tabela = Object.fromEntries(todos().map((e) => [e.codigo, [e.acao, e.retentavel]]));
    expect(tabela).toEqual({
      credencial_invalida: ["parar_e_alertar", false],
      provedor_indisponivel: ["tentar_de_novo", true],
      limite_de_requisicoes: ["tentar_depois_do_intervalo", true],
      destino_invalido: ["corrigir_o_destino", false],
      recusado_pelo_provedor: ["mostrar_o_motivo", false],
      linha_ocupada: ["esperar_a_linha", true],
      nao_encontrado: ["marcar_divergencia", false],
      nao_suportado: ["recusar_a_operacao", false],
    });
  });

  it("o texto é fixo: o construtor não aceita mensagem livre nem guarda causa", () => {
    for (const e of todos()) {
      expect(e.message.length).toBeGreaterThan(10);
      expect("cause" in e).toBe(false);
      expect(e.cause).toBeUndefined();
    }
    // Mesmo um valor livre passado nos parâmetros de texto não chega à mensagem nem ao JSON.
    const livre = "Fulano de Tal ligou para 5511999999999";
    const a = new NaoSuportadoDeLigacao("api4com", livre);
    const b = new RecusadoPeloProvedorDeLigacao("api4com", livre as never);
    for (const e of [a, b]) {
      const s = JSON.stringify(e) + e.message + String(e.stack?.split("\n")[0]);
      expect(s).not.toContain("Fulano");
      expect(s).not.toContain("5511999999999");
    }
    expect(a.operacao).toBeNull();
    expect(b.motivo).toBe("destino_nao_permitido");
  });

  it("o JSON serializado só leva código, ação, provedor e mensagem fixa (mais o campo próprio, quando há)", () => {
    expect(JSON.parse(JSON.stringify(new CredencialInvalidaDeLigacao("api4com")))).toEqual({
      codigo: "credencial_invalida",
      acao: "parar_e_alertar",
      retentavel: false,
      provedor: "api4com",
      mensagem: "O provedor não aceitou a credencial da conta ou da linha.",
    });
    expect(new LimiteDeRequisicoesDeLigacao("api4com", 1500).toJSON()).toMatchObject({ esperarMs: 1500 });
    expect(new NaoSuportadoDeLigacao("api4com", "originar").toJSON()).toMatchObject({ operacao: "originar" });
    expect(new RecusadoPeloProvedorDeLigacao("api4com", "sem_permissao").toJSON()).toMatchObject({ motivo: "sem_permissao" });
  });

  it("provedor pode ser nulo", () => {
    expect(new LinhaOcupadaDeLigacao().provedor).toBeNull();
    expect(erroDeLigacaoParaLog(new LinhaOcupadaDeLigacao())).toBe("linha_ocupada");
  });

  it("limite de requisições: espera inválida vira nulo, válida é arredondada para baixo", () => {
    expect(new LimiteDeRequisicoesDeLigacao("p1", null).esperarMs).toBeNull();
    expect(new LimiteDeRequisicoesDeLigacao("p1", Number.NaN).esperarMs).toBeNull();
    expect(new LimiteDeRequisicoesDeLigacao("p1", -5).esperarMs).toBeNull();
    expect(new LimiteDeRequisicoesDeLigacao("p1", Number.POSITIVE_INFINITY).esperarMs).toBeNull();
    expect(new LimiteDeRequisicoesDeLigacao("p1", 1500.9).esperarMs).toBe(1500);
  });

  it("nao_suportado: só aceita nome de operação em formato de identificador", () => {
    expect(new NaoSuportadoDeLigacao("p1", "responderOriginacao").operacao).toBe("responderOriginacao");
    expect(new NaoSuportadoDeLigacao("p1", "com espaço").operacao).toBeNull();
    expect(new NaoSuportadoDeLigacao("p1", "+5511999999999").operacao).toBeNull();
    expect(new NaoSuportadoDeLigacao("p1").operacao).toBeNull();
  });

  it("recusado: o motivo é de uma lista fechada, com texto fixo por motivo", () => {
    expect(MOTIVOS_DE_RECUSA_DE_LIGACAO).toEqual(["sem_permissao", "destino_bloqueado", "sem_saldo", "destino_nao_permitido"]);
    for (const m of MOTIVOS_DE_RECUSA_DE_LIGACAO) {
      const e = new RecusadoPeloProvedorDeLigacao("p1", m);
      expect(e.motivo).toBe(m);
      expect(e.message).toBe(TEXTO_DA_RECUSA_DE_LIGACAO[m]);
    }
    expect(new RecusadoPeloProvedorDeLigacao("p1").motivo).toBe("destino_nao_permitido");
    expect(TEXTO_DA_RECUSA_DE_LIGACAO.sem_permissao).toBe("O contato ainda não deu permissão para esta ligação.");
  });

  it("os textos seguem a §15: sem travessão, sem ' - ', sem exclamação e sem 'a CRM Agro'", () => {
    const textos = [...todos().map((e) => e.message), ...Object.values(TEXTO_DA_RECUSA_DE_LIGACAO)];
    for (const t of textos) {
      expect(t, t).not.toMatch(/[—–]|\s-\s|!/);
      expect(t, t).not.toMatch(/\ba CRM Agro\b/i);
      expect(t.endsWith("."), t).toBe(true);
    }
  });
});

describe("comoErroDeLigacao e erroDeLigacaoParaLog", () => {
  it("erro já neutro passa como está", () => {
    const e = new DestinoInvalidoDeLigacao("api4com");
    expect(comoErroDeLigacao(e, "outro")).toBe(e);
  });

  it("qualquer outra coisa vira provedor_indisponivel, sem carregar o erro original", () => {
    const original = new Error("Chamada para +5511999999999 falhou, token=abc123def456");
    const e = comoErroDeLigacao(original, "api4com");
    expect(e).toBeInstanceOf(ProvedorIndisponivelDeLigacao);
    expect(e.provedor).toBe("api4com");
    expect(e.cause).toBeUndefined();
    expect(JSON.stringify(e) + e.message).not.toMatch(/5511999999999|abc123def456/);
    expect(comoErroDeLigacao("texto solto", "api4com")).toBeInstanceOf(ProvedorIndisponivelDeLigacao);
    expect(comoErroDeLigacao(undefined, "api4com")).toBeInstanceOf(ProvedorIndisponivelDeLigacao);
  });

  it("o log leva só o código e o provedor, nunca a mensagem", () => {
    expect(erroDeLigacaoParaLog(new LimiteDeRequisicoesDeLigacao("api4com", 1000))).toBe("limite_de_requisicoes(api4com)");
    expect(erroDeLigacaoParaLog(new Error("segredo-123456 e +5511999999999"))).toBe("ErroNaoMapeado(Error)");
    expect(erroDeLigacaoParaLog(new TypeError("x"))).toBe("ErroNaoMapeado(TypeError)");
    expect(erroDeLigacaoParaLog({ message: "segredo" })).toBe("ErroNaoMapeado");
    expect(erroDeLigacaoParaLog(null)).toBe("ErroNaoMapeado");
  });
});
