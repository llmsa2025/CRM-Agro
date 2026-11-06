import { describe, expect, it } from "vitest";
import type { CapacidadesDeLigacao } from "../capacidades";
import { CODIGOS_DE_ERRO_DE_LIGACAO } from "../erros";
import { PERFIS_DO_FAKE_DE_LIGACAO, cenarioDeContratoDoFakeDeLigacao, type PerfilDoFakeDeLigacao } from "../fake";
import {
  comMatrizTrocada,
  cujoIdEventoMudaACadaNormalizacao,
  queAceitaQualquerAviso,
  queBotaTelefoneNoFato,
  queDeclaraPontasENaoAsManda,
  queDeixaEscaparErroDoProvedor,
  queVazaAChaveEmCampoExtra,
  queVazaAChaveNoTextoDoErro,
  queVazaOSegredoNaVerificacaoDoWebhook,
} from "./defeituosos";
import { contratoDeProvedorDeLigacao } from "./suite";
import {
  codigosCobertos,
  conferirAutenticacaoDoAviso,
  conferirErrosNeutros,
  conferirFatos,
  conferirGravacao,
  conferirHonestidadeDaMatriz,
  conferirIdEventoEstavel,
  conferirPontas,
  conferirSigilo,
} from "./verificacoes";

/**
 * A suíte de contrato roda contra o Fake de ligação em TODOS os perfis (so_no_fim, ao_vivo, sem_consulta).
 * Quando um adaptador real entrar (F2: API4COM; F4: Meta), ele ganha um arquivo igual a este, com o cenário dele.
 */
for (const perfil of PERFIS_DO_FAKE_DE_LIGACAO) {
  contratoDeProvedorDeLigacao(`Fake de ligação, perfil ${perfil}`, () => cenarioDeContratoDoFakeDeLigacao(perfil as PerfilDoFakeDeLigacao));
}

describe("a suíte exige fábrica síncrona", () => {
  it("avisa quando a fábrica devolve uma promessa", () => {
    expect(() => contratoDeProvedorDeLigacao("assíncrono", (async () => cenarioDeContratoDoFakeDeLigacao("so_no_fim")) as never)).toThrow(/síncrona/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Critério de pronto: escrever um provedor de brinquedo (um segundo Fake, com chave e matriz próprias, que
// entrega a gravação pela CONSULTA, não pelo webhook) exige SÓ adaptador, descritor, matriz e passar a suíte.
// ---------------------------------------------------------------------------------------------------

const MATRIZ_DE_BRINQUEDO: CapacidadesDeLigacao = {
  originar: ["navegador", "ponte"],
  originacaoSincrona: false,
  provisionarLinha: "manual",
  consulta: { porId: true, porMinuto: 30, trazAtendimento: true },
  causaDoFimGarantida: true,
  duracaoDesdeAtendimento: false,
  eventosAoVivo: false,
  pontasNoAviso: { destino: false, origem: true },
  gravacao: { entrega: "consulta", prazoHoras: 24, aviso: "provedor", apagavel: true },
  ligaAFrio: false,
  webhook: "assinatura_do_provedor",
  sandbox: true,
};

contratoDeProvedorDeLigacao("provedor de brinquedo (segundo Fake, matriz própria)", () => cenarioDeContratoDoFakeDeLigacao("so_no_fim", { chave: "brinquedo", capacidades: MATRIZ_DE_BRINQUEDO }));

// ---------------------------------------------------------------------------------------------------
// A suíte também precisa REPROVAR o que está errado. Estes testes alimentam adaptadores defeituosos e
// conferem que as verificações devolvem violações (se devolvessem lista vazia, a suíte seria inútil).
// ---------------------------------------------------------------------------------------------------

const base = (p: PerfilDoFakeDeLigacao) => cenarioDeContratoDoFakeDeLigacao(p);
const junta = (v: string[]): string => v.join("\n");

describe("controle: o Fake honesto não tem violação em nenhuma conferência", () => {
  for (const perfil of PERFIS_DO_FAKE_DE_LIGACAO) {
    it(`perfil ${perfil}`, async () => {
      expect(await conferirHonestidadeDaMatriz(base(perfil))).toEqual([]);
      expect(await conferirFatos(base(perfil))).toEqual([]);
      expect(await conferirIdEventoEstavel(base(perfil))).toEqual([]);
      expect(await conferirPontas(base(perfil))).toEqual([]);
      expect(await conferirAutenticacaoDoAviso(base(perfil))).toEqual([]);
      expect(await conferirGravacao(base(perfil))).toEqual([]);
      expect(await conferirErrosNeutros(base(perfil))).toEqual([]);
      expect(await conferirSigilo(base(perfil))).toEqual([]);
    });
  }
});

describe("a suíte reprova os três defeituosos do F1B-04", () => {
  for (const perfil of PERFIS_DO_FAKE_DE_LIGACAO) {
    it(`telefone no fato reprova (${perfil})`, async () => {
      const v = await conferirFatos(queBotaTelefoneNoFato(base(perfil)));
      expect(v.length).toBeGreaterThan(0);
      expect(junta(v)).toMatch(/fora do schema do fato/);
      expect(junta(v)).toMatch(/o fato carrega o telefone do contato/);
    });

    it(`idEvento que muda a cada normalização reprova (${perfil})`, async () => {
      const v = await conferirIdEventoEstavel(cujoIdEventoMudaACadaNormalizacao(base(perfil)));
      expect(junta(v)).toMatch(/o mesmo aviso \(\d+\) deu ids diferentes em duas leituras/);
    });

    it(`pontas declaradas e não mandadas reprova (${perfil})`, async () => {
      const v = await conferirPontas(queDeclaraPontasENaoAsManda(base(perfil)));
      expect(junta(v)).toMatch(/declarada com destino, mas o fato de fim chegou sem a ponta do destino/);
    });
  }
});

describe("a suíte reprova o aviso mal autenticado", () => {
  it("o que aceita qualquer aviso reprova, na assinatura do provedor e na URL assinada", async () => {
    const assinatura = junta(await conferirAutenticacaoDoAviso(queAceitaQualquerAviso(base("ao_vivo"))));
    expect(assinatura).toMatch(/webhook \(adulterado\): o aviso adulterado foi aceito/);
    expect(assinatura).toMatch(/webhook \(sem assinatura\): o aviso sem assinatura foi aceito/);
    expect(assinatura).toMatch(/webhook \(segredo errado\)/);
    expect(assinatura).toMatch(/webhook \(sem segredo\)/);
    const url = junta(await conferirAutenticacaoDoAviso(queAceitaQualquerAviso(base("so_no_fim"))));
    expect(url).toMatch(/na URL assinada quem prova a origem é o endereço/);
  });
});

describe("a suíte reprova matriz que mente (honestidade)", () => {
  type Caso = { nome: string; perfil: PerfilDoFakeDeLigacao; troca: Partial<CapacidadesDeLigacao>; esperado: RegExp };
  const casos: Caso[] = [
    { nome: "diz que avisa ao vivo e só avisa o fim", perfil: "so_no_fim", troca: { eventosAoVivo: true }, esperado: /eventosAoVivo: declarada como sim/ },
    { nome: "diz que NÃO avisa ao vivo e avisa", perfil: "ao_vivo", troca: { eventosAoVivo: false }, esperado: /eventosAoVivo: declarada como não/ },
    { nome: "diz que a duração conta do atendimento e não traz", perfil: "so_no_fim", troca: { duracaoDesdeAtendimento: true }, esperado: /duracaoDesdeAtendimento: declarada como sim/ },
    { nome: "diz que a duração NÃO conta do atendimento e traz", perfil: "ao_vivo", troca: { duracaoDesdeAtendimento: false }, esperado: /duracaoDesdeAtendimento: declarada como não/ },
    { nome: "diz que liga a frio e o provedor recusa", perfil: "sem_consulta", troca: { ligaAFrio: true }, esperado: /ligaAFrio: declarada como sim/ },
    { nome: "diz que NÃO liga a frio e liga", perfil: "so_no_fim", troca: { ligaAFrio: false }, esperado: /ligaAFrio: declarada como não, mas ligar para quem não deu permissão funcionou/ },
    { nome: "diz que faz o modo ponte e não faz", perfil: "so_no_fim", troca: { originar: ["navegador", "ponte"] }, esperado: /originar\(ponte\): declarado como sim/ },
    { nome: "diz que NÃO faz o modo ponte e faz", perfil: "ao_vivo", troca: { originar: ["navegador"] }, esperado: /originar\(ponte\): declarado como não, mas a operação funcionou/ },
    { nome: "diz que a consulta traz o atendimento e não traz", perfil: "so_no_fim", troca: { consulta: { porId: true, porMinuto: 15, trazAtendimento: true } }, esperado: /consulta\.trazAtendimento: declarada como sim/ },
    { nome: "diz que a consulta NÃO traz o atendimento e traz", perfil: "ao_vivo", troca: { consulta: { porId: true, porMinuto: null, trazAtendimento: false } }, esperado: /consulta\.trazAtendimento: declarada como não/ },
    { nome: "diz que a causa do fim é garantida sem prova", perfil: "so_no_fim", troca: { causaDoFimGarantida: true }, esperado: /causaDoFimGarantida: declarada como sim, mas a prova do roteiro não confirmou/ },
    { nome: "diz que NÃO garante a causa e a prova mostra que garante", perfil: "ao_vivo", troca: { causaDoFimGarantida: false }, esperado: /causaDoFimGarantida: declarada como não, mas a prova do roteiro mostrou/ },
    { nome: "diz que há sandbox e o descritor não tem ambiente de teste", perfil: "so_no_fim", troca: { sandbox: true }, esperado: /sandbox: a matriz e o descritor discordam/ },
    { nome: "diz outro modo de aviso que o descritor", perfil: "so_no_fim", troca: { webhook: "assinatura_do_provedor" }, esperado: /webhook: a matriz e o descritor discordam/ },
    { nome: "diz que consulta por id e o método não existe", perfil: "sem_consulta", troca: { consulta: { porId: true, porMinuto: null, trazAtendimento: false } }, esperado: /consultar: o método e a capacidade consulta\.porId discordam/ },
    { nome: "diz que NÃO consulta por id e o método existe", perfil: "so_no_fim", troca: { consulta: { porId: false, porMinuto: null, trazAtendimento: false } }, esperado: /consultar: o método e a capacidade consulta\.porId discordam/ },
    { nome: "diz que provisiona linha e o método não existe", perfil: "sem_consulta", troca: { provisionarLinha: "linha" }, esperado: /provisionarLinha: o método e a capacidade discordam/ },
    { nome: "diz que a originação é síncrona e o método não existe", perfil: "so_no_fim", troca: { originacaoSincrona: true }, esperado: /responderOriginacao: o método e a capacidade originacaoSincrona discordam/ },
    { nome: "diz que a gravação é apagável e o método não existe", perfil: "so_no_fim", troca: { gravacao: { entrega: "webhook", prazoHoras: null, aviso: "crmagro", apagavel: true } }, esperado: /apagarGravacao: o método e a capacidade gravacao\.apagavel discordam/ },
    { nome: "diz que NÃO há gravação e o método existe", perfil: "sem_consulta", troca: { gravacao: { entrega: "nenhuma", prazoHoras: null, aviso: "nenhum", apagavel: false } }, esperado: /obterGravacao: o método e a capacidade gravacao\.entrega discordam/ },
  ];
  for (const caso of casos) {
    it(`${caso.nome} (${caso.perfil})`, async () => {
      const v = await conferirHonestidadeDaMatriz(comMatrizTrocada(base(caso.perfil), caso.troca));
      expect(junta(v)).toMatch(caso.esperado);
    });
  }

  it("capacidade comprovada pelo roteiro (causa do fim) declarada sim sem prova", async () => {
    const c = base("so_no_fim");
    const semProva = { ...c, roteiro: { ...c.roteiro, comprovar: {} } };
    const v = await conferirHonestidadeDaMatriz(comMatrizTrocada(semProva, { causaDoFimGarantida: true }));
    expect(junta(v)).toMatch(/causaDoFimGarantida: declarada como sim, mas o roteiro não tem prova/);
  });

  it("gravação: entrega por onde a matriz não diz, prazo diferente do declarado e prazo que falta", async () => {
    expect(junta(await conferirGravacao(comMatrizTrocada(base("so_no_fim"), { gravacao: { entrega: "consulta", prazoHoras: null, aviso: "crmagro", apagavel: false } })))).toMatch(
      /declarada como entregue por consulta, mas o fato de gravação pronta não chegou por aí/,
    );
    expect(junta(await conferirGravacao(comMatrizTrocada(base("so_no_fim"), { gravacao: { entrega: "webhook", prazoHoras: 24, aviso: "crmagro", apagavel: false } })))).toMatch(
      /há prazo declarado, mas o fato não traz expiraEm/,
    );
    expect(junta(await conferirGravacao(comMatrizTrocada(base("sem_consulta"), { gravacao: { entrega: "webhook", prazoHoras: 100, aviso: "provedor", apagavel: false } })))).toMatch(
      /o prazo declarado é de 100 h, mas o fato indica 168\.00 h/,
    );
    expect(junta(await conferirGravacao(comMatrizTrocada(base("sem_consulta"), { gravacao: { entrega: "webhook", prazoHoras: null, aviso: "provedor", apagavel: false } })))).toMatch(
      /não há prazo declarado, mas o fato traz expiraEm/,
    );
    expect(junta(await conferirGravacao(comMatrizTrocada(base("so_no_fim"), { gravacao: { entrega: "nenhuma", prazoHoras: null, aviso: "nenhum", apagavel: false } })))).toMatch(
      /declarada como nenhuma, mas o provedor avisou uma gravação pronta/,
    );
  });

  it("pontas: declarada sem destino e o aviso traz; declarada com origem e o aviso não traz", async () => {
    expect(junta(await conferirPontas(comMatrizTrocada(base("sem_consulta"), { pontasNoAviso: { destino: false, origem: false } })))).toMatch(/declarada sem destino, mas o aviso trouxe a ponta do destino/);
    expect(junta(await conferirPontas(comMatrizTrocada(base("sem_consulta"), { pontasNoAviso: { destino: true, origem: true } })))).toMatch(/declarada com origem, mas o fato de fim chegou sem a ponta da origem/);
  });
});

describe("a suíte reprova vazamento e erro que escapa", () => {
  it("sigilo: erro cru com a chave no texto reprova", async () => {
    const v = await conferirSigilo(queVazaAChaveNoTextoDoErro(base("ao_vivo")));
    expect(junta(v)).toMatch(/erro de credencial: contém um segredo/);
  });

  it("sigilo: erro neutro com a chave em campo extra reprova", async () => {
    const v = await conferirSigilo(queVazaAChaveEmCampoExtra(base("so_no_fim")));
    expect(junta(v)).toMatch(/erro de credencial: contém um segredo/);
  });

  it("sigilo: a verificação do aviso que devolve o segredo reprova", async () => {
    for (const perfil of PERFIS_DO_FAKE_DE_LIGACAO) {
      const v = await conferirSigilo(queVazaOSegredoNaVerificacaoDoWebhook(base(perfil)));
      expect(junta(v), perfil).toMatch(/verificarWebhook/);
    }
  });

  it("erros neutros: erro do provedor que escapa como texto reprova", async () => {
    const v = await conferirErrosNeutros(queDeixaEscaparErroDoProvedor(base("ao_vivo")));
    expect(junta(v)).toMatch(/erro "ligação desconhecida": escapou como Error, não como erro neutro/);
  });

  it("erros neutros: o Fake cobre os 8 códigos em todos os perfis", () => {
    for (const perfil of PERFIS_DO_FAKE_DE_LIGACAO) expect([...codigosCobertos(base(perfil))].sort()).toEqual([...CODIGOS_DE_ERRO_DE_LIGACAO].sort());
  });
});
