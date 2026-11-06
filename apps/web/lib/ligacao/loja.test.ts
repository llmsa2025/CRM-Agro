import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { criarAcoesFalsas, type OpcoesDasAcoesFalsas } from "./acoes-falsas";
import type { ResultadoDaLigacao } from "./estado";
import type { FonteDoProximo } from "./fila";
import { criarLoja, esquecerLojaDaLigacao, lojaDaLigacao, LojaDaLigacaoNaoCriada, type AcoesDaLigacao, type OpcoesDeLigar } from "./loja";
import { ErroDoMotor, TAMANHO_MAXIMO_DO_ANEXO, type CredencialDoNavegador, type EventoDoMotor, type MotorDeSoftphone } from "./motor";
import { criarMotorFake, TEMPOS_DO_FAKE, type CenarioDoFake } from "./motores/fake";

const contato = { id: "c1", nome: "Maria" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  esquecerLojaDaLigacao();
});

/** Um motor que o teste controla: emite o evento que quiser e conta o que a loja chamou. */
function motorControlavel(chave = "fake", extra: Partial<MotorDeSoftphone> = {}) {
  const ouvintes = new Set<(e: EventoDoMotor) => void>();
  const motor = {
    chave,
    capacidades: { mudo: true, teclado: false, aoVivo: true },
    preparar: vi.fn(async (): Promise<{ anexo?: string }> => ({})),
    iniciar: vi.fn(async (_p: { callId: string; credencialDoNavegador: CredencialDoNavegador | null }): Promise<void> => {}),
    desligar: vi.fn(async (): Promise<void> => {}),
    silenciar: vi.fn((_mudo: boolean): void => {}),
    aoEvento: vi.fn((cb: (e: EventoDoMotor) => void) => {
      ouvintes.add(cb);
      return () => {
        ouvintes.delete(cb);
      };
    }),
    liberar: vi.fn((): void => {}),
    ...extra,
  } satisfies MotorDeSoftphone;
  return { motor, emitir: (e: EventoDoMotor) => [...ouvintes].forEach((o) => o(e)), assinantes: () => ouvintes.size };
}
type Controlavel = ReturnType<typeof motorControlavel>;

/** Monta a loja com o motor Fake de verdade (um novo a cada carga) e as ações falsas. */
function montarComFake(opcoes: { acoes?: OpcoesDasAcoesFalsas; cenario?: CenarioDoFake } = {}) {
  const acoes = criarAcoesFalsas(opcoes.acoes);
  const motores: ReturnType<typeof criarMotorFake>[] = [];
  const carregarMotor = vi.fn(async (_provedor: string) => {
    const motor = criarMotorFake({ cenario: opcoes.cenario ?? "atende" });
    vi.spyOn(motor, "liberar");
    motores.push(motor);
    return motor;
  });
  const loja = criarLoja({ acoes, carregarMotor, agora: () => Date.now() });
  const fases: string[] = [];
  loja.assinar(() => fases.push(loja.ler().fase));
  return { acoes, carregarMotor, loja, motores, fases };
}

/** Monta a loja com motores controláveis, na ordem em que a loja os pedir. */
function montarControlado(fila: Controlavel[], opcoes: { acoes?: OpcoesDasAcoesFalsas; acoesProprias?: AcoesDaLigacao } = {}) {
  const acoes = opcoes.acoesProprias ?? criarAcoesFalsas(opcoes.acoes);
  const carregarMotor = vi.fn(async (provedor: string) => {
    const proximo = fila.shift();
    if (!proximo) throw new Error(`motor inesperado para ${provedor}`);
    return proximo.motor;
  });
  const loja = criarLoja({ acoes, carregarMotor, agora: () => Date.now() });
  const fases: string[] = [];
  loja.assinar(() => fases.push(loja.ler().fase));
  return { acoes: acoes as ReturnType<typeof criarAcoesFalsas>, carregarMotor, loja, fases };
}

const aplicado: ResultadoDaLigacao = { outcome: "answered", motivo: null, duracaoS: 36, comprovada: true, conversa: true, provisorio: false, gravacao: "salva" };

describe("loja: o caminho feliz com o motor Fake", () => {
  it("percorre pedindo, preparando, chamando, em conversa, encerrada e concluir", async () => {
    const { loja, fases, acoes, motores } = montarComFake();
    expect(loja.ler().fase).toBe("livre");

    await loja.ligar(contato);
    expect(loja.ler()).toMatchObject({ fase: "preparando", callId: "fake-call-1", provedor: "fake", contato });

    await vi.advanceTimersByTimeAsync(0);
    expect(loja.ler().fase).toBe("chamando");

    await vi.advanceTimersByTimeAsync(TEMPOS_DO_FAKE.toqueAteAtender);
    expect(loja.ler()).toMatchObject({ fase: "em_conversa", atendidaEm: 1_000_000 + TEMPOS_DO_FAKE.toqueAteAtender, mudo: false });

    await vi.advanceTimersByTimeAsync(TEMPOS_DO_FAKE.conversa);
    expect(loja.ler()).toMatchObject({ fase: "encerrada", motivoLocal: "contato_desligou", resultado: null });

    loja.concluir();
    expect(loja.ler().fase).toBe("livre");
    expect(fases).toEqual(["pedindo", "preparando", "chamando", "em_conversa", "encerrada", "livre"]);
    expect(acoes.pedidos).toEqual([{ contactId: "c1" }]);
    expect(motores).toHaveLength(1);
  });

  it("não consulta o servidor em intervalo nenhum durante nem depois da ligação", async () => {
    const { loja, acoes } = montarComFake();
    await loja.ligar(contato);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(acoes.leituras).toEqual([]);
    expect(acoes.encerradas).toEqual([]);
  });

  it("os cenários terminam como o Fake promete", async () => {
    const casos: [CenarioDoFake, number, string][] = [
      ["nao_atende", TEMPOS_DO_FAKE.toqueSemAtender, "desconhecido"],
      ["ocupado", TEMPOS_DO_FAKE.ateOcupado, "contato_desligou"],
      ["cai_no_meio", TEMPOS_DO_FAKE.toqueAteAtender + TEMPOS_DO_FAKE.ateCair, "falha_de_rede"],
    ];
    for (const [cenario, ms, motivo] of casos) {
      const { loja } = montarComFake({ cenario });
      await loja.ligar(contato);
      await vi.advanceTimersByTimeAsync(ms);
      expect(loja.ler(), cenario).toMatchObject({ fase: "encerrada", motivoLocal: motivo });
      loja.concluir();
    }
  });
});

describe("loja: uma ligação por vez", () => {
  it("dois ligar seguidos geram um pedido só", async () => {
    const { loja, acoes, carregarMotor } = montarComFake();
    const [a, b] = await Promise.all([loja.ligar(contato), loja.ligar({ id: "c2", nome: "João" })]);
    expect([a, b]).toEqual([true, false]);
    expect(acoes.pedidos).toHaveLength(1);
    expect(acoes.pedidos[0]).toEqual({ contactId: "c1" });
    expect(carregarMotor).toHaveBeenCalledTimes(1);
  });

  it("enquanto há ligação, ou um fim ainda aberto, ligar é ignorado", async () => {
    const { loja, acoes } = montarComFake();
    await loja.ligar(contato);
    expect(await loja.ligar(contato)).toBe(false);
    await vi.advanceTimersByTimeAsync(TEMPOS_DO_FAKE.toqueAteAtender + TEMPOS_DO_FAKE.conversa);
    expect(loja.ler().fase).toBe("encerrada");
    expect(await loja.ligar(contato)).toBe(false);
    loja.concluir();
    expect(await loja.ligar(contato)).toBe(true);
    expect(acoes.pedidos).toHaveLength(2);
  });
});

describe("loja: assinantes", () => {
  it("o assinante que sai e volta lê o mesmo estado, e o snapshot é estável", async () => {
    const { loja } = montarComFake();
    const visto: string[] = [];
    const sair = loja.assinar(() => visto.push(loja.ler().fase));
    await loja.ligar(contato);
    sair();
    await vi.advanceTimersByTimeAsync(TEMPOS_DO_FAKE.toqueAteAtender);
    expect(visto).toEqual(["pedindo", "preparando"]);

    const voltou: string[] = [];
    const estadoAoVoltar = loja.ler();
    loja.assinar(() => voltou.push(loja.ler().fase));
    expect(loja.ler()).toBe(estadoAoVoltar);
    expect(estadoAoVoltar).toMatchObject({ fase: "em_conversa", callId: "fake-call-1" });
    expect(loja.ler()).toBe(loja.ler());
    await vi.advanceTimersByTimeAsync(TEMPOS_DO_FAKE.conversa);
    expect(voltou).toEqual(["encerrada"]);
  });

  it("um assinante que lança não derruba a ligação nem os outros", async () => {
    const { loja } = montarComFake();
    loja.assinar(() => {
      throw new Error("defeito do assinante");
    });
    const visto: string[] = [];
    loja.assinar(() => visto.push(loja.ler().fase));
    await loja.ligar(contato);
    expect(visto).toEqual(["pedindo", "preparando"]);
  });

  it("ação que não muda o estado não avisa ninguém", async () => {
    const { loja, fases } = montarComFake();
    loja.concluir();
    loja.silenciar(true);
    await loja.desligar();
    expect(fases).toEqual([]);
  });
});

describe("loja: desligar", () => {
  it("antes de atender vai para encerrada, avisa motor e servidor uma vez, e só libera no concluir", async () => {
    const { loja, acoes, motores } = montarComFake();
    await loja.ligar(contato);
    await vi.advanceTimersByTimeAsync(0);
    expect(loja.ler().fase).toBe("chamando");

    await loja.desligar();
    expect(loja.ler()).toMatchObject({ fase: "encerrada", motivoLocal: "desligou", atendidaEm: null, resultado: null });
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    expect(motores[0]?.liberar).not.toHaveBeenCalled();

    await loja.desligar();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    expect(loja.ler()).toMatchObject({ fase: "encerrada", motivoLocal: "desligou" });

    loja.concluir();
    expect(motores[0]?.liberar).toHaveBeenCalledTimes(1);
  });

  it("o evento de fim que o próprio motor emite ao desligar não vira um segundo fim", async () => {
    const { loja, fases } = montarComFake();
    await loja.ligar(contato);
    await vi.advanceTimersByTimeAsync(TEMPOS_DO_FAKE.toqueAteAtender);
    await loja.desligar();
    expect(fases.filter((f) => f === "encerrada")).toHaveLength(1);
    expect(loja.ler()).toMatchObject({ motivoLocal: "desligou", atendidaEm: 1_000_000 + TEMPOS_DO_FAKE.toqueAteAtender });
  });

  it("mesmo com o motor e o servidor falhando, a tela mostra o fim", async () => {
    const c = motorControlavel("fake", { desligar: vi.fn(async () => Promise.reject(new Error("SDK quebrou"))) });
    const acoesQueFalham: AcoesDaLigacao = {
      iniciar: async () => ({ ok: true, callId: "k1", provedor: "fake", linhaRotulo: null, gravando: false, credencialDoNavegador: null }),
      encerrar: async () => Promise.reject(new Error("rede")),
      ler: async () => null,
    };
    const { loja } = montarControlado([c], { acoesProprias: acoesQueFalham });
    await loja.ligar(contato);
    await expect(loja.desligar()).resolves.toBeUndefined();
    expect(loja.ler()).toMatchObject({ fase: "encerrada", motivoLocal: "desligou" });
  });

  it("sem ligação não faz nada", async () => {
    const { loja, acoes } = montarComFake();
    await loja.desligar();
    expect(loja.ler().fase).toBe("livre");
    expect(acoes.encerradas).toEqual([]);
  });

  it("desligar enquanto o pedido sai (provedor desconhecido): encerra a ligação criada sem abrir o microfone", async () => {
    const { loja, acoes, carregarMotor, motores } = montarComFake({ acoes: { atrasoMs: 1_000 } });
    const andando = loja.ligar(contato);
    await vi.advanceTimersByTimeAsync(10);
    expect(loja.ler()).toMatchObject({ fase: "pedindo", cancelando: false });

    await loja.desligar();
    expect(loja.ler()).toMatchObject({ fase: "pedindo", cancelando: true });

    await vi.advanceTimersByTimeAsync(1_000);
    await andando;
    expect(loja.ler()).toMatchObject({ fase: "encerrada", motivoLocal: "desligou", callId: "fake-call-1", resultado: null });
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    // Quem desligou não leva um pedido de permissão do microfone: o motor nem é carregado.
    expect(carregarMotor).not.toHaveBeenCalled();
    expect(motores).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loja.ler().fase).toBe("encerrada");
    loja.concluir();
    expect(loja.ler().fase).toBe("livre");
  });

  it("desligar enquanto o pedido sai (provedor conhecido): o motor já preparado é liberado", async () => {
    const { loja, acoes, motores } = montarComFake({ acoes: { atrasoMs: 1_000 } });
    const andando = loja.ligar(contato, { provedor: "fake" });
    await vi.advanceTimersByTimeAsync(10);
    expect(loja.ler()).toMatchObject({ fase: "pedindo", cancelando: false });

    await loja.desligar();
    await vi.advanceTimersByTimeAsync(1_000);
    await andando;
    expect(loja.ler()).toMatchObject({ fase: "encerrada", motivoLocal: "desligou", callId: "fake-call-1", resultado: null });
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    expect(motores).toHaveLength(1);
    expect(motores[0]?.liberar).toHaveBeenCalledTimes(1);
  });

  it("o servidor escolheu outro provedor e o vendedor já desligou: o motor errado é solto e nenhum outro é aberto", async () => {
    const { loja, acoes, carregarMotor, motores } = montarComFake({ acoes: { atrasoMs: 1_000, provedor: "api4com" } });
    const andando = loja.ligar(contato, { provedor: "fake" });
    await vi.advanceTimersByTimeAsync(10);
    await loja.desligar();
    await vi.advanceTimersByTimeAsync(1_000);
    await andando;
    expect(loja.ler()).toMatchObject({ fase: "encerrada", motivoLocal: "desligou", callId: "fake-call-1", provedor: "api4com" });
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    expect(carregarMotor).toHaveBeenCalledTimes(1);
    expect(motores[0]?.liberar).toHaveBeenCalledTimes(1);
  });

  it("desligar enquanto o pedido sai e o servidor recusa: volta a livre sem mostrar a recusa", async () => {
    const { loja, acoes } = montarComFake({ acoes: { atrasoMs: 1_000, recusarCom: "opt_out" } });
    const andando = loja.ligar(contato);
    await vi.advanceTimersByTimeAsync(10);
    await loja.desligar();
    await vi.advanceTimersByTimeAsync(1_000);
    await andando;
    expect(loja.ler().fase).toBe("livre");
    expect(acoes.encerradas).toEqual([]);
  });

  it("desligar enquanto o motor prepara (provedor conhecido): nem chama o servidor", async () => {
    let terminarPreparo: () => void = () => {};
    const c = motorControlavel("fake", {
      preparar: vi.fn(
        () =>
          new Promise<{ anexo?: string }>((resolve) => {
            terminarPreparo = () => resolve({});
          }),
      ),
    });
    const { loja, acoes } = montarControlado([c]);
    const andando = loja.ligar(contato, { provedor: "fake" });
    await vi.advanceTimersByTimeAsync(0);
    await loja.desligar();
    terminarPreparo();
    await andando;
    expect(loja.ler().fase).toBe("livre");
    expect(acoes.pedidos).toEqual([]);
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
    expect(c.motor.iniciar).not.toHaveBeenCalled();
  });
});

describe("loja: eventos do motor", () => {
  it("evento de outro callId não muda nada nem avisa ninguém", async () => {
    const c = motorControlavel();
    const { loja, fases } = montarControlado([c]);
    await loja.ligar(contato);
    const antes = loja.ler();
    const avisos = fases.length;
    for (const ev of [
      { tipo: "chamando", callId: "outra" },
      { tipo: "atendida", callId: "outra", em: 5 },
      { tipo: "encerrada", callId: "outra", motivoLocal: "desligou" },
      { tipo: "erro", callId: "outra", codigo: "provedor" },
    ] as const) {
      c.emitir(ev);
    }
    expect(loja.ler()).toBe(antes);
    expect(fases).toHaveLength(avisos);
  });

  it("erro do motor no meio da conversa: erro na tela, servidor avisado, motor liberado uma vez", async () => {
    const c = motorControlavel();
    const { loja, acoes } = montarControlado([c]);
    await loja.ligar(contato);
    c.emitir({ tipo: "atendida", callId: "fake-call-1", em: 1_000_100 });
    expect(loja.ler().fase).toBe("em_conversa");

    c.emitir({ tipo: "erro", callId: "fake-call-1", codigo: "conexao_caiu" });
    expect(loja.ler()).toEqual({ fase: "erro", contato, codigo: "conexao_caiu", callId: "fake-call-1" });
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
    expect(c.assinantes()).toBe(0);

    loja.concluir();
    expect(loja.ler().fase).toBe("livre");
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
  });

  it("depois do concluir, o motor antigo que ainda emite não mexe na ligação nova", async () => {
    const velho = motorControlavel();
    const novo = motorControlavel();
    const { loja } = montarControlado([velho, novo]);
    await loja.ligar(contato);
    velho.emitir({ tipo: "encerrada", callId: "fake-call-1", motivoLocal: "contato_desligou" });
    loja.concluir();
    await loja.ligar(contato);
    expect(loja.ler()).toMatchObject({ fase: "preparando", callId: "fake-call-2" });
    velho.emitir({ tipo: "atendida", callId: "fake-call-1", em: 5 });
    velho.emitir({ tipo: "erro", callId: "fake-call-1", codigo: "provedor" });
    expect(loja.ler()).toMatchObject({ fase: "preparando", callId: "fake-call-2" });
  });

  it("fluxo velho: o iniciar que só falha depois do concluir não derruba a ligação nova", async () => {
    let falharIniciar: (e: unknown) => void = () => {};
    const velho = motorControlavel("fake", {
      iniciar: vi.fn(
        () =>
          new Promise<void>((_resolve, rejeitar) => {
            falharIniciar = rejeitar;
          }),
      ),
    });
    const novo = motorControlavel();
    const { loja, acoes } = montarControlado([velho, novo]);
    const primeiro = loja.ligar(contato);
    await vi.advanceTimersByTimeAsync(0);
    velho.emitir({ tipo: "erro", callId: "fake-call-1", codigo: "conexao_caiu" });
    expect(loja.ler().fase).toBe("erro");
    loja.concluir();
    await loja.ligar(contato);
    expect(loja.ler()).toMatchObject({ fase: "preparando", callId: "fake-call-2" });

    falharIniciar(new ErroDoMotor("sem_audio"));
    await primeiro;
    expect(loja.ler()).toMatchObject({ fase: "preparando", callId: "fake-call-2" });
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    expect(novo.motor.liberar).not.toHaveBeenCalled();
  });
});

describe("loja: o pedido ao servidor", () => {
  it("leva só o contato, a linha, o identificador e o anexo, e nada de telefone, duração ou resultado", async () => {
    const c = motorControlavel("api4com", { preparar: vi.fn(async () => ({ anexo: "v=0 oferta" })) });
    const { loja, acoes } = montarControlado([c], { acoes: { provedor: "api4com" } });
    const opcoes: OpcoesDeLigar = { provedor: "api4com", linhaId: "l1", identificadorId: "i1" };
    await loja.ligar(contato, opcoes);
    expect(acoes.pedidos).toEqual([{ contactId: "c1", linhaId: "l1", identificadorId: "i1", anexo: "v=0 oferta" }]);
    const proibidas = ["phoneNumber", "telefone", "numero", "durationSeconds", "duracao", "outcome", "resultado", "status", "confirmarOptOut", "nome"];
    for (const pedido of acoes.pedidos) for (const campo of proibidas) expect(Object.keys(pedido)).not.toContain(campo);
  });

  it("campos opcionais ausentes nem entram no pedido", async () => {
    const { loja, acoes } = montarComFake();
    await loja.ligar(contato, { linhaId: "", identificadorId: undefined });
    expect(Object.keys(acoes.pedidos[0] ?? {})).toEqual(["contactId"]);
  });

  it("provedor conhecido: o motor é carregado e preparado ANTES do pedido, e o iniciar vem depois", async () => {
    const ordem: string[] = [];
    const c = motorControlavel("fake", {
      preparar: vi.fn(async () => {
        ordem.push("preparar");
        return { anexo: "oferta" };
      }),
      iniciar: vi.fn(async () => {
        ordem.push("motor.iniciar");
      }),
    });
    const acoes = criarAcoesFalsas();
    const original = acoes.iniciar.bind(acoes);
    const acoesComLog: AcoesDaLigacao = {
      ...acoes,
      iniciar: async (p) => {
        ordem.push("servidor.iniciar");
        return original(p);
      },
    };
    const { loja, carregarMotor } = montarControlado([c], { acoesProprias: acoesComLog });
    carregarMotor.mockImplementationOnce(async () => {
      ordem.push("carregar");
      return c.motor;
    });
    await loja.ligar(contato, { provedor: "fake" });
    expect(ordem).toEqual(["carregar", "preparar", "servidor.iniciar", "motor.iniciar"]);
    expect(carregarMotor).toHaveBeenCalledTimes(1);
  });

  it("provedor desconhecido: o servidor escolhe a linha e o motor vem depois da resposta, sem anexo", async () => {
    const c = motorControlavel("api4com", { preparar: vi.fn(async () => ({ anexo: "nao-usado" })) });
    const { loja, acoes, carregarMotor } = montarControlado([c], { acoes: { provedor: "api4com" } });
    await loja.ligar(contato);
    expect(carregarMotor).toHaveBeenCalledWith("api4com");
    expect(acoes.pedidos).toEqual([{ contactId: "c1" }]);
    expect(c.motor.preparar).toHaveBeenCalledTimes(1);
    expect(c.motor.iniciar).toHaveBeenCalledWith({ callId: "fake-call-1", credencialDoNavegador: null });
  });

  it("o servidor escolheu outro provedor: o motor pré-carregado é liberado e o certo assume", async () => {
    const errado = motorControlavel("whatsapp_cloud");
    const certo = motorControlavel("api4com");
    const { loja, carregarMotor } = montarControlado([errado, certo], { acoes: { provedor: "api4com" } });
    await loja.ligar(contato, { provedor: "whatsapp_cloud" });
    expect(carregarMotor.mock.calls.map((c) => c[0])).toEqual(["whatsapp_cloud", "api4com"]);
    expect(errado.motor.liberar).toHaveBeenCalledTimes(1);
    expect(errado.motor.iniciar).not.toHaveBeenCalled();
    expect(certo.motor.iniciar).toHaveBeenCalledTimes(1);
    expect(loja.ler()).toMatchObject({ fase: "preparando", provedor: "api4com" });
  });

  it("anexo do tamanho máximo passa; um byte a mais é recusado sem chamar o servidor", async () => {
    const cabe = motorControlavel("fake", { preparar: vi.fn(async () => ({ anexo: "a".repeat(TAMANHO_MAXIMO_DO_ANEXO) })) });
    const a = montarControlado([cabe]);
    await a.loja.ligar(contato, { provedor: "fake" });
    expect(a.acoes.pedidos).toHaveLength(1);

    const grande = motorControlavel("fake", { preparar: vi.fn(async () => ({ anexo: "a".repeat(TAMANHO_MAXIMO_DO_ANEXO + 1) })) });
    const b = montarControlado([grande]);
    await b.loja.ligar(contato, { provedor: "fake" });
    expect(b.loja.ler()).toMatchObject({ fase: "erro", codigo: "provedor", callId: null });
    expect(b.acoes.pedidos).toEqual([]);
    expect(grande.motor.liberar).toHaveBeenCalledTimes(1);
  });

  it("o limite do anexo conta bytes, não letras", async () => {
    const acentos = motorControlavel("fake", { preparar: vi.fn(async () => ({ anexo: "é".repeat(TAMANHO_MAXIMO_DO_ANEXO / 2 + 1) })) });
    const { loja, acoes } = montarControlado([acentos]);
    await loja.ligar(contato, { provedor: "fake" });
    expect(loja.ler()).toMatchObject({ fase: "erro", codigo: "provedor" });
    expect(acoes.pedidos).toEqual([]);
  });
});

describe("loja: recusas e falhas antes da ligação existir", () => {
  it("o servidor recusa: excecao com o código, motor pré-carregado liberado na hora, sem iniciar", async () => {
    const c = motorControlavel();
    const { loja } = montarControlado([c], { acoes: { recusarCom: "opt_out" } });
    await loja.ligar(contato, { provedor: "fake" });
    expect(loja.ler()).toEqual({ fase: "excecao", contato, codigo: "opt_out" });
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
    expect(c.motor.iniciar).not.toHaveBeenCalled();
    loja.concluir();
    expect(loja.ler().fase).toBe("livre");
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
  });

  it("recusa sem provedor conhecido nem chega a carregar o motor", async () => {
    const { loja, carregarMotor } = montarComFake({ acoes: { recusarCom: "sem_linha" } });
    await loja.ligar(contato);
    expect(loja.ler()).toMatchObject({ fase: "excecao", codigo: "sem_linha" });
    expect(carregarMotor).not.toHaveBeenCalled();
  });

  it("microfone negado com o provedor conhecido: erro na tela e o servidor nem é chamado", async () => {
    const { loja, acoes, motores } = montarComFake({ cenario: "microfone_negado" });
    await loja.ligar(contato, { provedor: "fake" });
    expect(loja.ler()).toEqual({ fase: "erro", contato, codigo: "microfone_negado", callId: null });
    expect(acoes.pedidos).toEqual([]);
    expect(motores[0]?.liberar).toHaveBeenCalledTimes(1);
  });

  it("microfone negado só descoberto depois da resposta: erro na tela com a ligação criada, que é encerrada", async () => {
    const { loja, acoes, motores } = montarComFake({ cenario: "microfone_negado" });
    await loja.ligar(contato);
    expect(loja.ler()).toEqual({ fase: "erro", contato, codigo: "microfone_negado", callId: "fake-call-1" });
    expect(acoes.pedidos).toHaveLength(1);
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    expect(motores[0]?.liberar).toHaveBeenCalledTimes(1);
  });

  it("o servidor cai (a ação lança): erro sem_resposta, motor liberado, livre depois do concluir", async () => {
    const { loja, motores } = montarComFake({ acoes: { semResposta: true } });
    await loja.ligar(contato, { provedor: "fake" });
    expect(loja.ler()).toEqual({ fase: "erro", contato, codigo: "sem_resposta", callId: null });
    expect(motores[0]?.liberar).toHaveBeenCalledTimes(1);
    loja.concluir();
    expect(loja.ler().fase).toBe("livre");
    expect(await loja.ligar(contato)).toBe(true);
  });

  it("o servidor responde lixo (undefined): erro sem_resposta, motor liberado e a tela não fica presa em pedindo", async () => {
    const lixo: AcoesDaLigacao = { ...criarAcoesFalsas(), iniciar: async () => undefined as never };
    const c = motorControlavel("fake");
    const { loja } = montarControlado([c], { acoesProprias: lixo });
    await loja.ligar(contato, { provedor: "fake" });
    expect(loja.ler()).toEqual({ fase: "erro", contato, codigo: "sem_resposta", callId: null });
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
    expect(c.assinantes()).toBe(0);
    loja.concluir();
    expect(loja.ler().fase).toBe("livre");
  });

  it("o servidor responde lixo sem provedor conhecido: o mesmo erro, e dá para ligar de novo", async () => {
    const lixo: AcoesDaLigacao = { ...criarAcoesFalsas(), iniciar: async () => null as never };
    const { loja, carregarMotor } = montarControlado([], { acoesProprias: lixo });
    await loja.ligar(contato);
    expect(loja.ler()).toEqual({ fase: "erro", contato, codigo: "sem_resposta", callId: null });
    expect(carregarMotor).not.toHaveBeenCalled();
    loja.concluir();
    expect(loja.ler().fase).toBe("livre");
    expect(await loja.ligar(contato)).toBe(true);
  });

  it("o servidor escolhe um provedor sem motor no navegador: erro com a ligação criada, que é encerrada", async () => {
    const acoes = criarAcoesFalsas();
    const semMotor = criarLoja({ acoes, carregarMotor: async () => Promise.reject(new ErroDoMotor("navegador_sem_suporte")), agora: () => Date.now() });
    await semMotor.ligar(contato);
    expect(semMotor.ler()).toMatchObject({ fase: "erro", codigo: "navegador_sem_suporte", callId: "fake-call-1" });
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
  });

  it("o motor não carrega: o código do ErroDoMotor se mantém; qualquer outra falha vira conexao_caiu", async () => {
    const semSuporte = criarLoja({ acoes: criarAcoesFalsas(), carregarMotor: async () => Promise.reject(new ErroDoMotor("navegador_sem_suporte")), agora: () => Date.now() });
    await semSuporte.ligar(contato, { provedor: "x" });
    expect(semSuporte.ler()).toMatchObject({ fase: "erro", codigo: "navegador_sem_suporte" });

    const semRede = criarLoja({ acoes: criarAcoesFalsas(), carregarMotor: async () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")), agora: () => Date.now() });
    await semRede.ligar(contato, { provedor: "x" });
    expect(semRede.ler()).toMatchObject({ fase: "erro", codigo: "conexao_caiu" });
  });

  it("o motor que lança coisa estranha no preparar vira provedor, sem repassar o texto", async () => {
    const c = motorControlavel("fake", { preparar: vi.fn(async () => Promise.reject(new Error("falha com +5511999990000"))) });
    const { loja } = montarControlado([c]);
    await loja.ligar(contato, { provedor: "fake" });
    expect(loja.ler()).toMatchObject({ fase: "erro", codigo: "provedor" });
    expect(JSON.stringify(loja.ler())).not.toContain("5511999990000");
  });

  it("o iniciar do motor rejeita: erro na tela, servidor avisado e motor liberado", async () => {
    const c = motorControlavel("fake", { iniciar: vi.fn(async () => Promise.reject(new ErroDoMotor("sem_audio"))) });
    const { loja, acoes } = montarControlado([c]);
    await loja.ligar(contato);
    expect(loja.ler()).toEqual({ fase: "erro", contato, codigo: "sem_audio", callId: "fake-call-1" });
    expect(acoes.encerradas).toEqual(["fake-call-1"]);
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
  });
});

describe("loja: a credencial", () => {
  const credencial: CredencialDoNavegador = { tipo: "sip_wss", servidor: "wss://voz.exemplo.com:6443", realm: "voz.exemplo.com", usuario: "1001", senha: "segredo-da-senha-sip" };

  it("vai do servidor direto ao motor e não aparece no estado em momento nenhum", async () => {
    const c = motorControlavel("api4com");
    const { loja } = montarControlado([c], { acoes: { provedor: "api4com", credencialDoNavegador: credencial } });
    const vistos: string[] = [];
    loja.assinar(() => vistos.push(JSON.stringify(loja.ler())));

    await loja.ligar(contato);
    expect(c.motor.iniciar).toHaveBeenCalledWith({ callId: "fake-call-1", credencialDoNavegador: credencial });
    c.emitir({ tipo: "atendida", callId: "fake-call-1", em: 1_000_050 });
    await loja.desligar();
    loja.informarResultado("fake-call-1", aplicado);
    loja.concluir();

    expect(vistos.length).toBeGreaterThan(3);
    for (const visto of vistos) {
      expect(visto).not.toContain("segredo-da-senha-sip");
      expect(visto).not.toContain("1001");
      expect(visto).not.toContain("wss://");
    }
  });

  it("também não fica no estado de erro", async () => {
    const c = motorControlavel("api4com", { iniciar: vi.fn(async () => Promise.reject(new ErroDoMotor("conexao_caiu"))) });
    const { loja } = montarControlado([c], { acoes: { provedor: "api4com", credencialDoNavegador: credencial } });
    await loja.ligar(contato);
    expect(JSON.stringify(loja.ler())).not.toContain("segredo-da-senha-sip");
  });
});

describe("loja: silenciar", () => {
  it("só em conversa: avisa o motor e marca o mudo", async () => {
    const c = motorControlavel();
    const { loja } = montarControlado([c]);
    await loja.ligar(contato);
    loja.silenciar(true);
    expect(c.motor.silenciar).not.toHaveBeenCalled();

    c.emitir({ tipo: "atendida", callId: "fake-call-1", em: 1_000_010 });
    loja.silenciar(true);
    expect(c.motor.silenciar).toHaveBeenCalledWith(true);
    expect(loja.ler()).toMatchObject({ fase: "em_conversa", mudo: true });

    loja.silenciar(true);
    expect(c.motor.silenciar).toHaveBeenCalledTimes(1);
    loja.silenciar(false);
    expect(loja.ler()).toMatchObject({ mudo: false });
  });

  it("motor sem a capacidade, ou que falha ao silenciar, não deixa a tela fingir", async () => {
    const semMudo = motorControlavel("fake", { capacidades: { mudo: false, teclado: false, aoVivo: true } });
    const a = montarControlado([semMudo]);
    await a.loja.ligar(contato);
    semMudo.emitir({ tipo: "atendida", callId: "fake-call-1", em: 1 });
    a.loja.silenciar(true);
    expect(semMudo.motor.silenciar).not.toHaveBeenCalled();
    expect(a.loja.ler()).toMatchObject({ mudo: false });

    const quebrado = motorControlavel("fake", {
      silenciar: vi.fn(() => {
        throw new Error("SDK");
      }),
    });
    const b = montarControlado([quebrado]);
    await b.loja.ligar(contato);
    quebrado.emitir({ tipo: "atendida", callId: "fake-call-1", em: 1 });
    b.loja.silenciar(true);
    expect(b.loja.ler()).toMatchObject({ mudo: false });
  });
});

describe("loja: o fim e o que vem depois", () => {
  it("liberar() só é chamado no concluir", async () => {
    const c = motorControlavel();
    const { loja } = montarControlado([c]);
    await loja.ligar(contato);
    c.emitir({ tipo: "encerrada", callId: "fake-call-1", motivoLocal: "contato_desligou" });
    expect(loja.ler().fase).toBe("encerrada");
    expect(c.motor.liberar).not.toHaveBeenCalled();
    loja.concluir();
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
    expect(c.assinantes()).toBe(0);
    loja.concluir();
    expect(c.motor.liberar).toHaveBeenCalledTimes(1);
  });

  it("não se conclui uma ligação viva", async () => {
    const c = motorControlavel();
    const { loja } = montarControlado([c]);
    await loja.ligar(contato);
    loja.concluir();
    expect(loja.ler().fase).toBe("preparando");
    expect(c.motor.liberar).not.toHaveBeenCalled();
  });

  it("informarResultado entra na ligação encerrada, do provisório ao aplicado", async () => {
    const c = motorControlavel();
    const { loja } = montarControlado([c]);
    await loja.ligar(contato);
    c.emitir({ tipo: "encerrada", callId: "fake-call-1", motivoLocal: "contato_desligou" });
    const provisorio: ResultadoDaLigacao = { ...aplicado, comprovada: false, provisorio: true };
    loja.informarResultado("fake-call-1", provisorio);
    expect(loja.ler()).toMatchObject({ resultado: provisorio });
    loja.informarResultado("outra", aplicado);
    expect(loja.ler()).toMatchObject({ resultado: provisorio });
    loja.informarResultado("fake-call-1", aplicado);
    expect(loja.ler()).toMatchObject({ resultado: aplicado });
  });

  it("a fonte do próximo é guardada, avisa os assinantes e pode ser tirada", () => {
    const { loja } = montarComFake();
    let avisos = 0;
    loja.assinar(() => (avisos += 1));
    const fonte: FonteDoProximo = { rotulo: "Ligar hoje", proximo: () => ({ id: "c2", nome: "João" }) };
    expect(loja.lerFonte()).toBeNull();
    loja.definirFonteDoProximo(fonte);
    expect(loja.lerFonte()).toBe(fonte);
    expect(loja.lerFonte()?.proximo("c1")).toEqual({ id: "c2", nome: "João" });
    loja.definirFonteDoProximo(null);
    expect(loja.lerFonte()).toBeNull();
    expect(avisos).toBe(2);
  });
});

describe("lojaDaLigacao: o singleton da aba", () => {
  const deps = () => ({ acoes: criarAcoesFalsas(), carregarMotor: async () => criarMotorFake(), agora: () => Date.now() });

  it("no servidor (sem window) nunca compartilha estado entre chamadas", () => {
    expect(typeof window).toBe("undefined");
    const a = lojaDaLigacao(deps());
    const b = lojaDaLigacao(deps());
    expect(a).not.toBe(b);
    expect(() => lojaDaLigacao()).toThrow(LojaDaLigacaoNaoCriada);
  });

  it("no navegador (com window) é uma loja só por aba", async () => {
    vi.stubGlobal("window", {});
    expect(() => lojaDaLigacao()).toThrow(LojaDaLigacaoNaoCriada);
    const primeira = lojaDaLigacao(deps());
    expect(lojaDaLigacao()).toBe(primeira);
    expect(lojaDaLigacao(deps())).toBe(primeira);
    await primeira.ligar(contato);
    expect(lojaDaLigacao().ler().fase).toBe("preparando");
    esquecerLojaDaLigacao();
    expect(() => lojaDaLigacao()).toThrow(LojaDaLigacaoNaoCriada);
  });
});
