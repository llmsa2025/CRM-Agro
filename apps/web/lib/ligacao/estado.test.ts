import { describe, expect, it } from "vitest";
import {
  callIdDoEstado,
  ESTADO_LIVRE,
  FASES_DA_LIGACAO,
  ligacaoOcupada,
  ligacaoViva,
  reduzir,
  type AcaoDaLigacao,
  type EstadoDaLigacao,
  type ResultadoDaLigacao,
} from "./estado";
import { CODIGOS_DO_MOTOR, MOTIVOS_LOCAIS_DO_FIM, type CapacidadesDoMotor, type EventoDoMotor } from "./motor";

const contato = { id: "c1", nome: "Maria" };
const outroContato = { id: "c2", nome: "João" };
const CAP: CapacidadesDoMotor = { mudo: true, teclado: false, aoVivo: true };
const SEM_MUDO: CapacidadesDoMotor = { mudo: false, teclado: false, aoVivo: true };

const pedir: AcaoDaLigacao = { tipo: "pedir", contato };
const aceito = (capacidades: CapacidadesDoMotor = CAP): AcaoDaLigacao => ({
  tipo: "pedido_aceito",
  callId: "k1",
  provedor: "fake",
  linhaRotulo: "Linha 1",
  gravando: true,
  capacidades,
});
const evento = (e: EventoDoMotor, agora = 5_000): AcaoDaLigacao => ({ tipo: "evento", evento: e, agora });
const chamando: AcaoDaLigacao = evento({ tipo: "chamando", callId: "k1" });
const atendida = (em = 1_000): AcaoDaLigacao => evento({ tipo: "atendida", callId: "k1", em });

const aplicado: ResultadoDaLigacao = { outcome: "answered", motivo: null, duracaoS: 42, comprovada: true, conversa: true, provisorio: false, gravacao: "salva" };
const provisorio: ResultadoDaLigacao = { ...aplicado, comprovada: false, provisorio: true };

function andar(...acoes: AcaoDaLigacao[]): EstadoDaLigacao {
  return acoes.reduce<EstadoDaLigacao>((e, a) => reduzir(e, a), ESTADO_LIVRE);
}

/** Congela o objeto inteiro: a função pura não pode mexer no que recebeu. */
function congelar<T>(valor: T): T {
  if (typeof valor === "object" && valor !== null && !Object.isFrozen(valor)) {
    Object.freeze(valor);
    for (const filho of Object.values(valor)) congelar(filho);
  }
  return valor;
}

const noPedido = andar(pedir);
const preparando = andar(pedir, aceito());
const noToque = andar(pedir, aceito(), chamando);
const emConversa = andar(pedir, aceito(), chamando, atendida());
const encerrada = andar(pedir, aceito(), chamando, atendida(), evento({ tipo: "encerrada", callId: "k1", motivoLocal: "contato_desligou" }, 9_000));
const comExcecao = andar(pedir, { tipo: "pedido_recusado", codigo: "opt_out" });
const comErro = andar(pedir, aceito(), { tipo: "falhou", codigo: "conexao_caiu" });

describe("reduzir: o caminho da ligação", () => {
  it("percorre pedindo, preparando, chamando, em conversa, encerrada e concluir", () => {
    expect(noPedido).toEqual({ fase: "pedindo", contato, cancelando: false });
    expect(preparando).toMatchObject({ fase: "preparando", callId: "k1", provedor: "fake", linhaRotulo: "Linha 1", gravando: true, contato });
    expect(noToque.fase).toBe("chamando");
    expect(emConversa).toMatchObject({ fase: "em_conversa", atendidaEm: 1_000, mudo: false, callId: "k1" });
    expect(encerrada).toMatchObject({ fase: "encerrada", atendidaEm: 1_000, encerradaEm: 9_000, motivoLocal: "contato_desligou", resultado: null, callId: "k1" });
    expect(reduzir(encerrada, { tipo: "concluir" })).toBe(ESTADO_LIVRE);
  });

  it("aceita o atendimento sem o aviso de chamando antes", () => {
    expect(andar(pedir, aceito(), atendida(2_500))).toMatchObject({ fase: "em_conversa", atendidaEm: 2_500 });
  });

  it("encerra sem ter atendido: atendidaEm fica nulo", () => {
    const fim = andar(pedir, aceito(), chamando, evento({ tipo: "encerrada", callId: "k1", motivoLocal: "desconhecido" }, 7_000));
    expect(fim).toMatchObject({ fase: "encerrada", atendidaEm: null, encerradaEm: 7_000, motivoLocal: "desconhecido" });
  });

  it("o vendedor desligar antes de atender vai para encerrada com motivo desligou", () => {
    for (const antes of [preparando, noToque]) {
      expect(reduzir(antes, { tipo: "desligou", agora: 6_000 })).toMatchObject({ fase: "encerrada", motivoLocal: "desligou", atendidaEm: null, encerradaEm: 6_000, callId: "k1" });
    }
  });

  it("o vendedor desligar em conversa guarda a hora do atendimento", () => {
    expect(reduzir(emConversa, { tipo: "desligou", agora: 8_000 })).toMatchObject({ fase: "encerrada", motivoLocal: "desligou", atendidaEm: 1_000, encerradaEm: 8_000 });
  });

  it("desligar sem ligação viva não faz nada", () => {
    for (const e of [ESTADO_LIVRE, noPedido, encerrada, comExcecao, comErro]) {
      expect(reduzir(e, { tipo: "desligou", agora: 1 })).toBe(e);
    }
  });

  it("o evento de erro leva a erro com o código e o callId", () => {
    for (const antes of [preparando, noToque, emConversa]) {
      expect(reduzir(antes, evento({ tipo: "erro", callId: "k1", codigo: "sem_audio" }))).toMatchObject({ fase: "erro", codigo: "sem_audio", callId: "k1", contato });
    }
  });

  it("evento repetido não muda nada", () => {
    expect(reduzir(emConversa, atendida(9_999))).toBe(emConversa);
    expect(reduzir(emConversa, chamando)).toBe(emConversa);
    expect(reduzir(noToque, chamando)).toBe(noToque);
  });

  it("o evento do motor só vale com ligação viva", () => {
    for (const e of [ESTADO_LIVRE, noPedido, encerrada, comExcecao, comErro]) {
      expect(reduzir(e, chamando)).toBe(e);
      expect(reduzir(e, atendida())).toBe(e);
      expect(reduzir(e, evento({ tipo: "encerrada", callId: "k1", motivoLocal: "desligou" }))).toBe(e);
      expect(reduzir(e, evento({ tipo: "erro", callId: "k1", codigo: "provedor" }))).toBe(e);
    }
  });
});

describe("reduzir: invariantes", () => {
  it("uma ligação por vez: só se pede de livre", () => {
    for (const e of [noPedido, preparando, noToque, emConversa, encerrada, comExcecao, comErro]) {
      expect(reduzir(e, { tipo: "pedir", contato: outroContato })).toBe(e);
    }
  });

  it("evento de outro callId é ignorado, em toda fase viva e para todo tipo de evento", () => {
    const outros: EventoDoMotor[] = [
      { tipo: "chamando", callId: "outra" },
      { tipo: "atendida", callId: "outra", em: 1 },
      { tipo: "encerrada", callId: "outra", motivoLocal: "desligou" },
      { tipo: "erro", callId: "outra", codigo: "provedor" },
    ];
    for (const e of [preparando, noToque, emConversa]) {
      for (const ev of outros) expect(reduzir(e, evento(ev))).toBe(e);
    }
  });

  it("mudo só em conversa", () => {
    for (const e of [ESTADO_LIVRE, noPedido, preparando, noToque, encerrada, comExcecao, comErro]) {
      expect(reduzir(e, { tipo: "silenciar", mudo: true })).toBe(e);
    }
    const mudo = reduzir(emConversa, { tipo: "silenciar", mudo: true });
    expect(mudo).toMatchObject({ fase: "em_conversa", mudo: true });
    expect(reduzir(mudo, { tipo: "silenciar", mudo: true })).toBe(mudo);
    expect(reduzir(mudo, { tipo: "silenciar", mudo: false })).toMatchObject({ mudo: false });
  });

  it("motor sem a capacidade de silenciar: o mudo não liga", () => {
    const semMudo = andar(pedir, aceito(SEM_MUDO), chamando, atendida());
    expect(reduzir(semMudo, { tipo: "silenciar", mudo: true })).toBe(semMudo);
  });

  it("o mudo some quando a ligação acaba", () => {
    const mudo = reduzir(emConversa, { tipo: "silenciar", mudo: true });
    const fim = reduzir(mudo, evento({ tipo: "encerrada", callId: "k1", motivoLocal: "desligou" }));
    expect(fim).not.toHaveProperty("mudo");
  });

  it("de encerrada, excecao e erro só se sai por concluir", () => {
    const outrasAcoes: AcaoDaLigacao[] = [
      pedir,
      { tipo: "cancelar_pedido" },
      { tipo: "desistir" },
      aceito(),
      { tipo: "pedido_recusado", codigo: "x" },
      { tipo: "falhou", codigo: "provedor" },
      chamando,
      atendida(),
      { tipo: "silenciar", mudo: true },
      { tipo: "desligou", agora: 1 },
    ];
    for (const e of [encerrada, comExcecao, comErro]) {
      for (const a of outrasAcoes) expect(reduzir(e, a)).toBe(e);
      expect(reduzir(e, { tipo: "concluir" })).toBe(ESTADO_LIVRE);
    }
  });

  it("não se conclui uma ligação viva", () => {
    for (const e of [ESTADO_LIVRE, noPedido, preparando, noToque, emConversa]) {
      expect(reduzir(e, { tipo: "concluir" })).toBe(e);
    }
  });
});

describe("reduzir: o pedido que não vira ligação", () => {
  it("recusa do servidor leva a excecao com o código neutro", () => {
    expect(comExcecao).toEqual({ fase: "excecao", contato, codigo: "opt_out" });
  });

  it("falha antes da ligação existir leva a erro sem callId", () => {
    expect(andar(pedir, { tipo: "falhou", codigo: "microfone_negado" })).toEqual({ fase: "erro", contato, codigo: "microfone_negado", callId: null });
  });

  it("falha com o callId de uma ligação que o servidor criou (motor que não carregou) leva a erro com esse callId", () => {
    expect(andar(pedir, { tipo: "falhou", codigo: "navegador_sem_suporte", callId: "k9" })).toEqual({ fase: "erro", contato, codigo: "navegador_sem_suporte", callId: "k9" });
    expect(reduzir(andar(pedir, { tipo: "cancelar_pedido" }), { tipo: "falhou", codigo: "provedor", callId: "k9" })).toBe(ESTADO_LIVRE);
  });

  it("falha depois de a ligação existir leva a erro com o callId", () => {
    expect(comErro).toEqual({ fase: "erro", contato, codigo: "conexao_caiu", callId: "k1" });
  });

  it("falhar fora de uma ligação não faz nada", () => {
    for (const e of [ESTADO_LIVRE, encerrada, comExcecao, comErro]) expect(reduzir(e, { tipo: "falhou", codigo: "provedor" })).toBe(e);
  });

  it("desligar enquanto o pedido sai marca cancelando, uma vez só", () => {
    const cancelando = reduzir(noPedido, { tipo: "cancelar_pedido" });
    expect(cancelando).toEqual({ fase: "pedindo", contato, cancelando: true });
    expect(reduzir(cancelando, { tipo: "cancelar_pedido" })).toBe(cancelando);
    expect(reduzir(ESTADO_LIVRE, { tipo: "cancelar_pedido" })).toBe(ESTADO_LIVRE);
    expect(reduzir(preparando, { tipo: "cancelar_pedido" })).toBe(preparando);
  });

  it("quem cancelou não vê a recusa nem a falha: volta a livre", () => {
    const cancelando = reduzir(noPedido, { tipo: "cancelar_pedido" });
    expect(reduzir(cancelando, { tipo: "pedido_recusado", codigo: "opt_out" })).toBe(ESTADO_LIVRE);
    expect(reduzir(cancelando, { tipo: "falhou", codigo: "sem_resposta" })).toBe(ESTADO_LIVRE);
    expect(reduzir(cancelando, { tipo: "desistir" })).toBe(ESTADO_LIVRE);
  });

  it("desistir só vale para quem cancelou", () => {
    expect(reduzir(noPedido, { tipo: "desistir" })).toBe(noPedido);
    expect(reduzir(preparando, { tipo: "desistir" })).toBe(preparando);
  });

  it("o pedido aceito depois do cancelamento segue para preparando (a loja encerra em seguida)", () => {
    expect(reduzir(reduzir(noPedido, { tipo: "cancelar_pedido" }), aceito())).toMatchObject({ fase: "preparando", callId: "k1" });
  });

  it("pedido aceito ou recusado fora de pedindo não faz nada", () => {
    for (const e of [ESTADO_LIVRE, preparando, noToque, emConversa, encerrada, comExcecao, comErro]) {
      expect(reduzir(e, aceito())).toBe(e);
      expect(reduzir(e, { tipo: "pedido_recusado", codigo: "x" })).toBe(e);
    }
  });
});

describe("reduzir: o resultado do servidor", () => {
  it("entra na ligação encerrada do mesmo callId", () => {
    expect(reduzir(encerrada, { tipo: "resultado", callId: "k1", resultado: provisorio })).toMatchObject({ fase: "encerrada", resultado: provisorio });
  });

  it("do provisório para o aplicado, e do aplicado ao aplicado", () => {
    const prov = reduzir(encerrada, { tipo: "resultado", callId: "k1", resultado: provisorio });
    const ok = reduzir(prov, { tipo: "resultado", callId: "k1", resultado: aplicado });
    expect(ok).toMatchObject({ resultado: aplicado });
    const outro = { ...aplicado, duracaoS: 50 };
    expect(reduzir(ok, { tipo: "resultado", callId: "k1", resultado: outro })).toMatchObject({ resultado: outro });
  });

  it("o aplicado não volta a provisório", () => {
    const ok = reduzir(encerrada, { tipo: "resultado", callId: "k1", resultado: aplicado });
    expect(reduzir(ok, { tipo: "resultado", callId: "k1", resultado: provisorio })).toBe(ok);
  });

  it("resultado de outro callId, ou de ligação que não acabou, é ignorado", () => {
    expect(reduzir(encerrada, { tipo: "resultado", callId: "outra", resultado: aplicado })).toBe(encerrada);
    for (const e of [ESTADO_LIVRE, noPedido, preparando, noToque, emConversa, comExcecao, comErro]) {
      expect(reduzir(e, { tipo: "resultado", callId: "k1", resultado: aplicado })).toBe(e);
    }
  });
});

describe("ajudantes do estado", () => {
  it("ligacaoViva e ligacaoOcupada", () => {
    expect([ESTADO_LIVRE, noPedido, preparando, noToque, emConversa, encerrada, comExcecao, comErro].map(ligacaoViva)).toEqual([false, true, true, true, true, false, false, false]);
    expect([ESTADO_LIVRE, noPedido, preparando, noToque, emConversa, encerrada, comExcecao, comErro].map(ligacaoOcupada)).toEqual([false, true, true, true, true, true, true, true]);
  });

  it("callIdDoEstado", () => {
    expect([ESTADO_LIVRE, noPedido, preparando, noToque, emConversa, encerrada, comExcecao, comErro].map(callIdDoEstado)).toEqual([null, null, "k1", "k1", "k1", "k1", null, "k1"]);
    expect(callIdDoEstado(andar(pedir, { tipo: "falhou", codigo: "provedor" }))).toBeNull();
  });
});

describe("reduzir: matriz de todas as fases com todas as ações", () => {
  const estados: EstadoDaLigacao[] = [ESTADO_LIVRE, noPedido, reduzir(noPedido, { tipo: "cancelar_pedido" }), preparando, noToque, emConversa, encerrada, comExcecao, comErro];
  const acoes: AcaoDaLigacao[] = [
    pedir,
    { tipo: "cancelar_pedido" },
    { tipo: "desistir" },
    aceito(),
    { tipo: "pedido_recusado", codigo: "sem_linha" },
    ...CODIGOS_DO_MOTOR.map((codigo): AcaoDaLigacao => ({ tipo: "falhou", codigo })),
    { tipo: "falhou", codigo: "sem_resposta" },
    chamando,
    atendida(),
    ...MOTIVOS_LOCAIS_DO_FIM.map((motivoLocal): AcaoDaLigacao => evento({ tipo: "encerrada", callId: "k1", motivoLocal })),
    ...CODIGOS_DO_MOTOR.map((codigo): AcaoDaLigacao => evento({ tipo: "erro", callId: "k1", codigo })),
    { tipo: "silenciar", mudo: true },
    { tipo: "desligou", agora: 3 },
    { tipo: "resultado", callId: "k1", resultado: aplicado },
    { tipo: "concluir" },
  ];

  it("nunca lança, nunca mexe no que recebeu e sempre devolve uma fase conhecida", () => {
    const fases = new Set<string>(FASES_DA_LIGACAO);
    for (const e of estados) {
      congelar(e);
      for (const a of acoes) {
        const proximo = reduzir(e, a);
        expect(fases.has(proximo.fase)).toBe(true);
      }
    }
  });

  it("o estado nunca guarda telefone, credencial nem texto livre", () => {
    const todos = JSON.stringify(estados);
    expect(todos).not.toMatch(/senha|telefone|phone|credencial|token/i);
  });
});
