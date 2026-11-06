import { describe, expect, it } from "vitest";
import { CAUSAS_DE_LIGACAO, type CausaDeLigacao } from "../provedor/fato";
import { capacidadesDoPerfilDeLigacao, PERFIS_DO_FAKE_DE_LIGACAO } from "../provedor/fake/perfis";
import {
  INICIO_DE_TESTE,
  consulta,
  entradaDeTeste,
  fimDaConsulta,
  fimDoCrmAgro,
  fimDoWebhook,
  matriz,
  matrizGarantida,
  permutacoes,
  subconjuntos,
  webhook,
} from "./apoio-de-teste";
import { LIMIAR_CONVERSA_S, TABELA_DE_CAUSA_DE_LIGACAO, calcularDesfechoDeLigacao, type DesfechoDeLigacao } from "./desfecho";
import type { EntradaDaLinhaDoTempoDeLigacao } from "./linha-do-tempo";

const calcular = (entradas: EntradaDaLinhaDoTempoDeLigacao[], m = matrizGarantida()): DesfechoDeLigacao => {
  const d = calcularDesfechoDeLigacao(entradas, m);
  expect(d).not.toBeNull();
  return d!;
};

const instante = (s: number) => new Date(INICIO_DE_TESTE + s * 1000);

describe("tabela de causa", () => {
  it("tem uma linha por causa neutra e uma para a falha ao originar", () => {
    expect(Object.keys(TABELA_DE_CAUSA_DE_LIGACAO).sort()).toEqual([...CAUSAS_DE_LIGACAO, "falhou_ao_originar"].sort());
  });

  it("os textos de tela seguem a §15: sem travessão, sem meia-risca e sem hífen como separador", () => {
    for (const regra of Object.values(TABELA_DE_CAUSA_DE_LIGACAO)) {
      for (const texto of [regra.motivo, "motivoSemResultado" in regra ? regra.motivoSemResultado : null]) {
        if (!texto) continue;
        expect(texto).not.toMatch(/[—–]| - /);
        expect(texto.endsWith(".")).toBe(true);
      }
    }
  });

  // Cada linha da tabela das Notas comuns, com a rede tendo tocado (houve `chamando`) e a causa do fim garantida.
  const comToque: Record<CausaDeLigacao, { status: string; outcome: string | null; tentativaComprovada: boolean; motivo: string | null }> = {
    atendida: { status: "completed", outcome: "answered", tentativaComprovada: true, motivo: null },
    nao_atendeu: { status: "no_answer", outcome: "no_answer", tentativaComprovada: true, motivo: "Chamou e ninguém atendeu." },
    ocupado: { status: "busy", outcome: "busy", tentativaComprovada: true, motivo: "Linha ocupada." },
    recusou: { status: "no_answer", outcome: "rejected", tentativaComprovada: true, motivo: "O contato recusou a ligação." },
    caixa_postal: { status: "no_answer", outcome: "voicemail", tentativaComprovada: true, motivo: "Caiu na caixa postal." },
    numero_inexistente: { status: "failed", outcome: "wrong_number", tentativaComprovada: false, motivo: "O número não existe." },
    cancelada_por_quem_ligou: { status: "no_answer", outcome: null, tentativaComprovada: true, motivo: "A ligação foi encerrada antes de atender." },
    falha_de_rede: { status: "failed", outcome: null, tentativaComprovada: false, motivo: "A ligação não completou por falha de rede." },
    sem_permissao: { status: "failed", outcome: null, tentativaComprovada: false, motivo: "O contato ainda não deu permissão para esta ligação." },
    destino_nao_recebe: { status: "failed", outcome: null, tentativaComprovada: false, motivo: "O número não recebe ligação por este canal." },
    desconhecida: { status: "completed", outcome: null, tentativaComprovada: true, motivo: "O provedor não confirmou o fim da ligação." },
  };

  it.each(CAUSAS_DE_LIGACAO)("causa %s, com toque e causa garantida", (causa) => {
    const d = calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, causa)], matrizGarantida());
    expect(d).toMatchObject(comToque[causa]);
    expect(d.terminal).toEqual({ idEvento: "webhook:f1", origem: "webhook", tipo: "encerrada", causa });
    expect(d.encerradaEm).toEqual(instante(30));
  });

  it("sem causa garantida, nao_atendeu e numero_inexistente ficam sem resultado, mas o status é o mesmo", () => {
    const naoAtendeu = calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, "nao_atendeu")], matriz());
    expect(naoAtendeu).toMatchObject({ status: "no_answer", outcome: null, tentativaComprovada: true, motivo: "O provedor não confirmou o motivo." });

    const inexistente = calcular([fimDoWebhook("f1", 30, "numero_inexistente")], matriz());
    expect(inexistente).toMatchObject({ status: "failed", outcome: null, tentativaComprovada: false, motivo: "O número não existe." });
  });

  it("sem causa garantida, ocupado, recusou e caixa postal continuam valendo (R6 é só de no_answer e wrong_number)", () => {
    expect(calcular([fimDoWebhook("f1", 30, "ocupado")], matriz()).outcome).toBe("busy");
    expect(calcular([fimDoWebhook("f1", 30, "recusou")], matriz()).outcome).toBe("rejected");
    expect(calcular([fimDoWebhook("f1", 30, "caixa_postal")], matriz()).outcome).toBe("voicemail");
  });

  it("nao_atendeu sem toque: só vira tentativa se a causa é garantida", () => {
    expect(calcular([fimDoWebhook("f1", 30, "nao_atendeu")], matriz())).toMatchObject({ tentativaComprovada: false, evidencia: null });
    expect(calcular([fimDoWebhook("f1", 30, "nao_atendeu")], matrizGarantida())).toMatchObject({ tentativaComprovada: true, outcome: "no_answer" });
  });

  it("cancelada por quem ligou: no_answer se tocou, failed se não, sempre sem resultado", () => {
    expect(calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 10, "cancelada_por_quem_ligou")])).toMatchObject({
      status: "no_answer",
      outcome: null,
      tentativaComprovada: true,
    });
    expect(calcular([fimDoWebhook("f1", 10, "cancelada_por_quem_ligou")])).toMatchObject({ status: "failed", outcome: null, tentativaComprovada: false });
  });

  it("desconhecida: só vira atendida com fato real de atendida, e só tem tentativa com fato real", () => {
    expect(calcular([fimDoWebhook("f1", 60, "desconhecida")])).toMatchObject({ status: "completed", outcome: null, tentativaComprovada: false, evidencia: null });
    expect(calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 60, "desconhecida")])).toMatchObject({ outcome: null, tentativaComprovada: true });
    expect(calcular([webhook("a1", 10, "atendida"), fimDoWebhook("f1", 60, "desconhecida")])).toMatchObject({
      status: "completed",
      outcome: "answered",
      tentativaComprovada: true,
      atendidaEm: instante(10),
    });
  });

  it("falhou ao originar: failed, sem resultado, sem tentativa, com o texto da causa", () => {
    const sem = calcular([entradaDeTeste("webhook", "x1", 2, "falhou_ao_originar", "sem_permissao")]);
    expect(sem).toMatchObject({
      status: "failed",
      outcome: null,
      tentativaComprovada: false,
      evidencia: null,
      motivo: "O contato ainda não deu permissão para esta ligação.",
      terminal: { tipo: "falhou_ao_originar", causa: "sem_permissao" },
    });
    // Mesmo com número inexistente garantido, quem nem saiu não vira wrong_number (a linha da tabela diz nulo).
    expect(calcular([entradaDeTeste("webhook", "x1", 2, "falhou_ao_originar", "numero_inexistente")])).toMatchObject({ outcome: null, motivo: "O número não existe." });
    // Causa que não explica a falha: texto neutro.
    expect(calcular([entradaDeTeste("webhook", "x1", 2, "falhou_ao_originar", "atendida")]).motivo).toBe("A ligação não saiu.");
  });
});

describe("em andamento", () => {
  it("sem fato terminal não há desfecho", () => {
    expect(calcularDesfechoDeLigacao([], matriz())).toBeNull();
    expect(calcularDesfechoDeLigacao([webhook("c1", 0, "chamando")], matriz())).toBeNull();
    expect(calcularDesfechoDeLigacao([webhook("c1", 0, "chamando"), webhook("a1", 8, "atendida")], matriz())).toBeNull();
    expect(calcularDesfechoDeLigacao([webhook("c1", 0, "chamando"), webhook("r1", 4, "recusada")], matriz())).toBeNull();
  });
});

describe("terminal vencedor", () => {
  it("a consulta vence o aviso, mesmo com o aviso mais novo", () => {
    const d = calcular([fimDaConsulta("q1", 30, "ocupado"), fimDoWebhook("f1", 90, "caixa_postal")]);
    expect(d.terminal).toMatchObject({ idEvento: "consulta:q1", origem: "consulta", causa: "ocupado" });
    expect(d.outcome).toBe("busy");
    expect(d.encerradaEm).toEqual(instante(30));
  });

  it("o aviso vence o fechamento sintético, mesmo com o sintético mais novo", () => {
    const d = calcular([fimDoCrmAgro("s1", 500, "cancelada_por_quem_ligou"), fimDoWebhook("f1", 10, "ocupado")]);
    expect(d.terminal).toMatchObject({ origem: "webhook", causa: "ocupado" });
    expect(d.outcome).toBe("busy");
  });

  it("na mesma origem vale o instante mais recente", () => {
    const d = calcular([fimDoWebhook("f1", 30, "nao_atendeu"), fimDoWebhook("f2", 40, "caixa_postal")]);
    expect(d.terminal.idEvento).toBe("webhook:f2");
    expect(d.outcome).toBe("voicemail");
  });

  it("no empate de instante vale o maior idEvento", () => {
    const d = calcular([fimDoWebhook("f2", 30, "caixa_postal"), fimDoWebhook("f1", 30, "ocupado")]);
    expect(d.terminal.idEvento).toBe("webhook:f2");
    expect(d.outcome).toBe("voicemail");
  });

  it("a consulta e o aviso do mesmo fim são dois eventos que dão o mesmo desfecho", () => {
    const soAviso = calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, "ocupado")]);
    const soConsulta = calcular([webhook("c1", 0, "chamando"), fimDaConsulta("f1", 30, "ocupado")]);
    const ambos = calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, "ocupado"), fimDaConsulta("f1", 30, "ocupado")]);
    for (const d of [soAviso, soConsulta, ambos]) expect(d).toMatchObject({ status: "busy", outcome: "busy", tentativaComprovada: true });
    expect(ambos.terminal.idEvento).toBe("consulta:f1");
  });
});

describe("aceite da F1B-08", () => {
  it("toque longo sem atender nunca vira atendida, nem ganha duração", () => {
    const naoAtendeu = calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 120, "nao_atendeu", { duracaoConectadaS: 120 })]);
    expect(naoAtendeu).toMatchObject({ status: "no_answer", outcome: "no_answer", atendidaEm: null, duracaoConectadaS: null, conversa: false });

    // Fim genérico com uma duração enorme, mas ninguém atendeu: não é atendida.
    const generico = calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 300, "desconhecida", { duracaoConectadaS: 300 })]);
    expect(generico).toMatchObject({ outcome: null, atendidaEm: null, duracaoConectadaS: null, conversa: false });
  });

  it("fim antes do atendimento: o atendimento que vem depois do fim é ignorado", () => {
    const aviso = [webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, "nao_atendeu"), webhook("a1", 40, "atendida")];
    expect(calcular(aviso)).toMatchObject({ outcome: "no_answer", atendidaEm: null, duracaoConectadaS: null, conversa: false });

    const generico = [webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, "desconhecida"), webhook("a1", 40, "atendida")];
    expect(calcular(generico)).toMatchObject({ outcome: null, atendidaEm: null });

    // A hora do atendimento que o próprio fim traz, depois do fim, também não vale.
    const horaImpossivel = [webhook("a1", 10, "atendida"), fimDoWebhook("f1", 60, "atendida", { atendidaEm: 70, duracaoConectadaS: 50 })];
    expect(calcular(horaImpossivel)).toMatchObject({ outcome: "answered", atendidaEm: instante(10), duracaoConectadaS: 50 });
  });

  it("recusou e encerrou: rejected, mesmo se o fim vier genérico", () => {
    const completo = calcular([webhook("c1", 0, "chamando"), webhook("r1", 5, "recusada"), fimDoWebhook("f1", 5, "recusou")]);
    expect(completo).toMatchObject({ status: "no_answer", outcome: "rejected", conversa: false, tentativaComprovada: true, motivo: "O contato recusou a ligação." });

    for (const generica of ["desconhecida", "nao_atendeu"] as const) {
      const d = calcular([webhook("c1", 0, "chamando"), webhook("r1", 5, "recusada"), fimDoWebhook("f1", 6, generica)], matriz());
      expect(d, generica).toMatchObject({ status: "no_answer", outcome: "rejected", tentativaComprovada: true });
      expect(d.terminal.causa).toBe("recusou");
    }
  });

  it("a recusa sozinha não encerra a ligação, e não desfaz um atendimento comprovado", () => {
    expect(calcularDesfechoDeLigacao([webhook("r1", 5, "recusada")], matriz())).toBeNull();
    const atendeuAntes = calcular([webhook("a1", 3, "atendida"), webhook("r1", 5, "recusada"), fimDoWebhook("f1", 20, "desconhecida")]);
    expect(atendeuAntes).toMatchObject({ outcome: "answered", atendidaEm: instante(3) });
  });

  describe("consulta chegando antes do webhook mantém a duração e a conversa", () => {
    const daConsulta = fimDaConsulta("q1", 100, "atendida", { atendidaEm: 20, duracaoConectadaS: 80 });
    const doWebhook = fimDoWebhook("f1", 101, "atendida");

    it.each([
      ["consulta, depois webhook", [daConsulta, doWebhook]],
      ["webhook, depois consulta", [doWebhook, daConsulta]],
    ])("%s", (_nome, entradas) => {
      expect(calcular(entradas)).toMatchObject({
        status: "completed",
        outcome: "answered",
        atendidaEm: instante(20),
        duracaoConectadaS: 80,
        conversa: true,
      });
    });

    it("a duração do aviso completa a da consulta quando a consulta não a traz", () => {
      const semDuracao = fimDaConsulta("q1", 100, "atendida", { atendidaEm: 20 });
      const comDuracao = fimDoWebhook("f1", 101, "atendida", { duracaoConectadaS: 80 });
      expect(calcular([semDuracao, comDuracao])).toMatchObject({ duracaoConectadaS: 80, conversa: true, atendidaEm: instante(20) });
    });
  });

  describe("webhook forjado (atendida, 5 min) contra consulta real (não atendeu)", () => {
    const forjados = [webhook("a1", 10, "atendida"), fimDoWebhook("f1", 330, "atendida", { atendidaEm: 10, duracaoConectadaS: 300 })];
    const real = fimDaConsulta("q1", 30, "nao_atendeu");

    it("dá no_answer, sem duração e sem conversa, em qualquer ordem", () => {
      for (const ordem of permutacoes([...forjados, real])) {
        expect(calcular(ordem)).toMatchObject({
          status: "no_answer",
          outcome: "no_answer",
          atendidaEm: null,
          duracaoConectadaS: null,
          conversa: false,
          motivo: "Chamou e ninguém atendeu.",
        });
      }
    });

    it("o aviso forjado também não cria tentativa onde a consulta não achou nenhuma", () => {
      const consultaSemToque = fimDaConsulta("q1", 30, "falha_de_rede");
      expect(calcular([...forjados, consultaSemToque])).toMatchObject({ status: "failed", outcome: null, tentativaComprovada: false, evidencia: null });
    });
  });

  describe("só fatos de origem crmagro", () => {
    it("o fechamento sintético nunca comprova nem diz o que a rede fez", () => {
      for (const causa of CAUSAS_DE_LIGACAO) {
        const d = calcular([fimDoCrmAgro("s1", 60, causa, { atendidaEm: 5, duracaoConectadaS: 55 })]);
        expect(d.tentativaComprovada, causa).toBe(false);
        expect(d.evidencia, causa).toBeNull();
        expect(d.duracaoConectadaS, causa).toBeNull();
        expect(d.atendidaEm, causa).toBeNull();
        expect(d.conversa, causa).toBe(false);
        expect(d.outcome, causa).toBeNull();
      }
    });

    it("o CRM Agro só afirma o que é dele: causa da rede vira desconhecida, causa dele fica", () => {
      expect(calcular([fimDoCrmAgro("s1", 60, "atendida")]).terminal.causa).toBe("desconhecida");
      expect(calcular([fimDoCrmAgro("s1", 60, "nao_atendeu")]).terminal.causa).toBe("desconhecida");
      expect(calcular([fimDoCrmAgro("s1", 60, "cancelada_por_quem_ligou")])).toMatchObject({ status: "failed", terminal: { causa: "cancelada_por_quem_ligou" } });
      expect(calcular([fimDoCrmAgro("s1", 60, "falha_de_rede")])).toMatchObject({ status: "failed", motivo: "A ligação não completou por falha de rede." });
      expect(calcular([fimDoCrmAgro("s1", 60, "sem_permissao")]).terminal.causa).toBe("sem_permissao");
    });

    it("fechamento sintético depois de um toque real é tentativa comprovada", () => {
      expect(calcular([webhook("c1", 0, "chamando"), fimDoCrmAgro("s1", 60, "cancelada_por_quem_ligou")])).toMatchObject({
        status: "no_answer",
        outcome: null,
        tentativaComprovada: true,
        evidencia: "provedor",
      });
    });
  });

  describe("29 s e 30 s", () => {
    it("29 s conectados não é conversa, 30 s é", () => {
      expect(LIMIAR_CONVERSA_S).toBe(30);
      const com = (s: number) => calcular([fimDoWebhook("f1", 100, "atendida", { atendidaEm: 70, duracaoConectadaS: s })]);
      expect(com(29)).toMatchObject({ outcome: "answered", duracaoConectadaS: 29, conversa: false });
      expect(com(30)).toMatchObject({ outcome: "answered", duracaoConectadaS: 30, conversa: true });
      expect(com(31).conversa).toBe(true);
    });

    it("atendida sem duração conectada comprovada não é conversa", () => {
      expect(calcular([fimDoWebhook("f1", 100, "atendida")])).toMatchObject({ outcome: "answered", duracaoConectadaS: null, conversa: false });
    });
  });

  it("provedor sem causa garantida: nao_atendeu e numero_inexistente não viram resultado", () => {
    for (const causa of ["nao_atendeu", "numero_inexistente"] as const) {
      expect(calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, causa)], matriz()).outcome, causa).toBeNull();
      expect(calcular([webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, causa)], matrizGarantida()).outcome, causa).not.toBeNull();
    }
  });

  describe("evidência", () => {
    const soAviso = [webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, "ocupado")];

    it("url_assinada com consulta possível e sem fato da consulta dá aguardando_consulta", () => {
      expect(calcular(soAviso, matriz())).toMatchObject({ tentativaComprovada: true, evidencia: "aguardando_consulta", outcome: "busy" });
    });

    it("com um fato de origem consulta, a tentativa fica provada pelo provedor", () => {
      expect(calcular([...soAviso, fimDaConsulta("q1", 30, "ocupado")], matriz())).toMatchObject({ tentativaComprovada: true, evidencia: "provedor" });
    });

    it("assinatura do provedor, ou provedor sem consulta, não espera consulta", () => {
      expect(calcular(soAviso, matrizGarantida())).toMatchObject({ evidencia: "provedor" });
      const semConsulta = matriz({ consulta: { porId: false, porMinuto: null, trazAtendimento: false } });
      expect(calcular(soAviso, semConsulta)).toMatchObject({ evidencia: "provedor" });
    });

    it("sem tentativa comprovada, nenhuma evidência", () => {
      expect(calcular([fimDoWebhook("f1", 30, "sem_permissao")], matriz())).toMatchObject({ tentativaComprovada: false, evidencia: null });
    });

    it("o desfecho não olha a lista de provedores comprovados: isso é do aplicador", () => {
      expect(Object.keys(calcular(soAviso, matrizGarantida()))).toContain("evidencia");
    });
  });

  it("sintético depois de atendida real dá answered, sem duração e sem conversa", () => {
    const d = calcular([webhook("c1", 0, "chamando"), webhook("a1", 12, "atendida"), fimDoCrmAgro("s1", 900, "desconhecida", { duracaoConectadaS: 800 })]);
    expect(d).toMatchObject({
      status: "completed",
      outcome: "answered",
      atendidaEm: instante(12),
      duracaoConectadaS: null,
      conversa: false,
      tentativaComprovada: true,
      terminal: { origem: "crmagro", causa: "desconhecida" },
    });
  });
});

describe("mescla por campo", () => {
  it("o fim do aviso precisa bater com o da consulta em até 5 s para a duração valer", () => {
    const daConsulta = fimDaConsulta("q1", 100, "atendida", { atendidaEm: 20 });
    expect(calcular([daConsulta, fimDoWebhook("f1", 105, "atendida", { duracaoConectadaS: 70 })]).duracaoConectadaS).toBe(70);
    expect(calcular([daConsulta, fimDoWebhook("f1", 95, "atendida", { duracaoConectadaS: 70 })]).duracaoConectadaS).toBe(70);
    expect(calcular([daConsulta, fimDoWebhook("f1", 106, "atendida", { duracaoConectadaS: 70 })]).duracaoConectadaS).toBeNull();
  });

  it("a duração do aviso não passa do tempo entre o atendimento e o fim da consulta", () => {
    const daConsulta = fimDaConsulta("q1", 100, "atendida", { atendidaEm: 20 });
    expect(calcular([daConsulta, fimDoWebhook("f1", 100, "atendida", { duracaoConectadaS: 80 })]).duracaoConectadaS).toBe(80);
    expect(calcular([daConsulta, fimDoWebhook("f1", 100, "atendida", { duracaoConectadaS: 81 })])).toMatchObject({ duracaoConectadaS: null, conversa: false, outcome: "answered" });
  });

  it("a duração da consulta vale mais que a do aviso", () => {
    const d = calcular([fimDaConsulta("q1", 100, "atendida", { atendidaEm: 20, duracaoConectadaS: 40 }), fimDoWebhook("f1", 100, "atendida", { duracaoConectadaS: 80 })]);
    expect(d.duracaoConectadaS).toBe(40);
  });

  it("a hora do atendimento vem do fato que a tiver", () => {
    const consultaSemHora = fimDaConsulta("q1", 100, "atendida");
    expect(calcular([consultaSemHora, webhook("a1", 25, "atendida")]).atendidaEm).toEqual(instante(25));
    expect(calcular([consultaSemHora, fimDoWebhook("f1", 100, "atendida", { atendidaEm: 30 })]).atendidaEm).toEqual(instante(30));
    // A da consulta vale mais que a do aviso.
    expect(calcular([fimDaConsulta("q1", 100, "atendida", { atendidaEm: 22 }), webhook("a1", 25, "atendida")]).atendidaEm).toEqual(instante(22));
  });

  it("com dois atendimentos do mesmo aviso, vale o mais tardio", () => {
    const d = calcular([webhook("a1", 10, "atendida"), webhook("a2", 18, "atendida"), fimDoWebhook("f1", 90, "desconhecida")]);
    expect(d.atendidaEm).toEqual(instante(18));
  });

  it("aviso que contradiz a consulta é ignorado por inteiro", () => {
    // A consulta diz que atendeu; o aviso diz que ninguém atendeu. Vale a consulta.
    const d = calcular([fimDaConsulta("q1", 100, "atendida", { atendidaEm: 20, duracaoConectadaS: 80 }), fimDoWebhook("f1", 101, "nao_atendeu")]);
    expect(d).toMatchObject({ outcome: "answered", duracaoConectadaS: 80, conversa: true });
  });

  it("fato de origem crmagro não dá hora nem duração, nem quando o real não tem", () => {
    const d = calcular([webhook("a1", 10, "atendida"), fimDoCrmAgro("s1", 100, "desconhecida", { atendidaEm: 5, duracaoConectadaS: 90 })]);
    expect(d).toMatchObject({ atendidaEm: instante(10), duracaoConectadaS: null, conversa: false });
  });
});

describe("repetição", () => {
  it("a mesma entrada repetida dá o mesmo desfecho", () => {
    const fim = fimDoWebhook("f1", 100, "atendida", { atendidaEm: 20, duracaoConectadaS: 80 });
    expect(calcular([fim, fim, fim])).toEqual(calcular([fim]));
  });

  it("o mesmo idEvento com conteúdos diferentes (aviso forjado reusando o id) dá o mesmo desfecho em qualquer ordem", () => {
    const verdadeiro = fimDoWebhook("f1", 100, "atendida", { atendidaEm: 20, duracaoConectadaS: 80 });
    const forjado = fimDoWebhook("f1", 100, "atendida", { atendidaEm: 20, duracaoConectadaS: 800 });
    expect(calcular([verdadeiro, forjado])).toEqual(calcular([forjado, verdadeiro]));
  });

  it("a mesma causa em origens diferentes são dois eventos, não um", () => {
    const d = calcular([fimDoWebhook("x", 30, "ocupado"), fimDaConsulta("x", 30, "caixa_postal")]);
    expect(d.terminal.idEvento).toBe("consulta:x");
    expect(d.outcome).toBe("voicemail");
  });
});

describe("com as matrizes dos perfis do Fake", () => {
  it.each(PERFIS_DO_FAKE_DE_LIGACAO)("perfil %s", (perfil) => {
    const m = capacidadesDoPerfilDeLigacao(perfil);
    const d = calcular([webhook("c1", 0, "chamando"), webhook("a1", 8, "atendida"), fimDoWebhook("f1", 90, "atendida", { atendidaEm: 8, duracaoConectadaS: 82 })], m);
    expect(d).toMatchObject({ outcome: "answered", duracaoConectadaS: 82, conversa: true, tentativaComprovada: true });
    // Só o perfil de URL assinada com consulta (API4COM) espera a consulta.
    expect(d.evidencia).toBe(perfil === "so_no_fim" ? "aguardando_consulta" : "provedor");
  });

  it("so_no_fim: a causa do fim não é garantida, então não atendeu sem toque não vira resultado", () => {
    const d = calcular([fimDoWebhook("f1", 30, "nao_atendeu")], capacidadesDoPerfilDeLigacao("so_no_fim"));
    expect(d).toMatchObject({ status: "no_answer", outcome: null, tentativaComprovada: false, evidencia: null });
  });

  it("ao_vivo: a causa do fim é garantida", () => {
    const d = calcular([fimDoWebhook("f1", 30, "nao_atendeu")], capacidadesDoPerfilDeLigacao("ao_vivo"));
    expect(d).toMatchObject({ outcome: "no_answer", tentativaComprovada: true, evidencia: "provedor" });
  });
});

describe("propriedade: o desfecho não depende da ordem nem da repetição", () => {
  // Cenários de até 6 fatos, com duplicatas (a mesma entrada duas vezes). Todas as permutações de cada um.
  const cenarios: Record<string, EntradaDaLinhaDoTempoDeLigacao[]> = {
    "atendida normal, aviso repetido": [
      webhook("c1", 0, "chamando"),
      webhook("a1", 8, "atendida"),
      fimDoWebhook("f1", 90, "atendida", { atendidaEm: 8, duracaoConectadaS: 82 }),
      fimDoWebhook("f1", 90, "atendida", { atendidaEm: 8, duracaoConectadaS: 82 }),
    ],
    "consulta e aviso do mesmo fim": [
      fimDaConsulta("q1", 100, "atendida", { atendidaEm: 20, duracaoConectadaS: 80 }),
      fimDoWebhook("f1", 101, "atendida"),
      fimDoWebhook("f1", 101, "atendida"),
      webhook("a1", 21, "atendida"),
      webhook("c1", 0, "chamando"),
    ],
    "aviso forjado contra consulta real": [
      webhook("a1", 10, "atendida"),
      webhook("a1", 10, "atendida"),
      fimDoWebhook("f1", 330, "atendida", { atendidaEm: 10, duracaoConectadaS: 300 }),
      fimDaConsulta("q1", 30, "nao_atendeu"),
      fimDaConsulta("q1", 30, "nao_atendeu"),
      webhook("c1", 0, "chamando"),
    ],
    "recusou e encerrou": [webhook("c1", 0, "chamando"), webhook("r1", 5, "recusada"), fimDoWebhook("f1", 6, "desconhecida"), fimDoWebhook("f1", 6, "desconhecida"), fimDoCrmAgro("s1", 700, "desconhecida")],
    "fim antes do atendimento": [webhook("c1", 0, "chamando"), fimDoWebhook("f1", 30, "desconhecida"), webhook("a1", 40, "atendida"), webhook("a1", 40, "atendida"), webhook("a2", 35, "atendida")],
    "sintético depois de atendida real": [webhook("c1", 0, "chamando"), webhook("a1", 12, "atendida"), fimDoCrmAgro("s1", 900, "desconhecida", { duracaoConectadaS: 800 }), fimDoCrmAgro("s1", 900, "desconhecida", { duracaoConectadaS: 800 })],
    "só fatos de origem crmagro": [fimDoCrmAgro("s1", 60, "atendida"), fimDoCrmAgro("s2", 60, "falha_de_rede"), fimDoCrmAgro("s2", 60, "falha_de_rede")],
    "dois fins do mesmo aviso, tempos diferentes": [fimDoWebhook("f1", 30, "nao_atendeu"), fimDoWebhook("f2", 40, "caixa_postal"), fimDoWebhook("f3", 40, "ocupado"), webhook("c1", 0, "chamando"), fimDoCrmAgro("s1", 50, "desconhecida"), fimDoCrmAgro("s1", 50, "desconhecida")],
    "mesmo idEvento, conteúdos diferentes": [fimDoWebhook("f1", 100, "atendida", { duracaoConectadaS: 80 }), fimDoWebhook("f1", 100, "atendida", { duracaoConectadaS: 800 }), fimDaConsulta("q1", 100, "atendida", { atendidaEm: 20 }), webhook("a1", 21, "atendida")],
    "falha ao originar contra consulta": [entradaDeTeste("webhook", "x1", 2, "falhou_ao_originar", "sem_permissao"), fimDaConsulta("q1", 30, "ocupado"), webhook("c1", 0, "chamando"), webhook("c1", 0, "chamando")],
  };

  const matrizes = {
    "url assinada, causa não garantida": matriz(),
    "assinatura do provedor, causa garantida": matrizGarantida(),
    "sem consulta": matriz({ consulta: { porId: false, porMinuto: null, trazAtendimento: false }, webhook: "assinatura_do_provedor" }),
  };

  for (const [nomeDaMatriz, m] of Object.entries(matrizes)) {
    it.each(Object.entries(cenarios))(`${nomeDaMatriz}: %s`, (_nome, entradas) => {
      expect(entradas.length).toBeLessThanOrEqual(6);
      const todas = permutacoes(entradas);
      expect(todas.length).toBeGreaterThanOrEqual(2);
      const esperado = calcularDesfechoDeLigacao(entradas, m);
      for (const ordem of todas) expect(calcularDesfechoDeLigacao(ordem, m)).toEqual(esperado);
      // Repetir tudo mais uma vez não muda nada.
      expect(calcularDesfechoDeLigacao([...entradas, ...entradas], m)).toEqual(esperado);
    });
  }

  it("todas as permutações de todo subconjunto de até 4 fatos de um conjunto variado, mais uma duplicata", () => {
    const universo: EntradaDaLinhaDoTempoDeLigacao[] = [
      webhook("c1", 0, "chamando"),
      webhook("a1", 10, "atendida"),
      webhook("r1", 5, "recusada"),
      consulta("c2", 1, "chamando"),
      fimDoWebhook("f1", 90, "atendida", { atendidaEm: 10, duracaoConectadaS: 80 }),
      fimDoWebhook("f2", 91, "desconhecida"),
      fimDaConsulta("q1", 92, "atendida", { atendidaEm: 12, duracaoConectadaS: 70 }),
      fimDaConsulta("q2", 40, "nao_atendeu"),
      fimDoCrmAgro("s1", 300, "desconhecida"),
      entradaDeTeste("webhook", "x1", 3, "falhou_ao_originar", "falha_de_rede"),
    ];
    let comparacoes = 0;
    for (const m of Object.values(matrizes)) {
      for (const sub of subconjuntos(universo, 1, 4)) {
        const comDuplicata = [...sub, sub[0]!];
        const esperado = calcularDesfechoDeLigacao(comDuplicata, m);
        for (const ordem of permutacoes(comDuplicata)) {
          expect(calcularDesfechoDeLigacao(ordem, m)).toEqual(esperado);
          comparacoes++;
        }
      }
    }
    expect(comparacoes).toBeGreaterThan(10_000);
  });
});
