import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ehErroDoMotor, type EventoDoMotor } from "../motor";
import { CENARIOS_DO_FAKE, cenarioSalvo, CHAVE_DO_CENARIO_NO_STORAGE, criarMotorFake, TEMPOS_DO_FAKE, type CenarioDoFake, type MotorFake } from "./fake";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

type Marca = { aos: number; evento: EventoDoMotor };

/** Inicia o motor e anota cada evento com os milissegundos desde o início. */
async function rodar(cenario: CenarioDoFake, duracaoMs: number): Promise<{ motor: MotorFake; marcas: Marca[]; inicio: number }> {
  const motor = criarMotorFake({ cenario });
  const marcas: Marca[] = [];
  const inicio = Date.now();
  motor.aoEvento((evento) => marcas.push({ aos: Date.now() - inicio, evento }));
  await motor.preparar();
  await motor.iniciar({ callId: "k1", credencialDoNavegador: null });
  await vi.advanceTimersByTimeAsync(duracaoMs);
  return { motor, marcas, inicio };
}

describe("motor Fake: os cenários", () => {
  it("atende: toca 2 s, atende e o contato desliga 35 s depois", async () => {
    const { marcas, inicio } = await rodar("atende", 60_000);
    expect(marcas).toEqual([
      { aos: 0, evento: { tipo: "chamando", callId: "k1" } },
      { aos: TEMPOS_DO_FAKE.toqueAteAtender, evento: { tipo: "atendida", callId: "k1", em: inicio + TEMPOS_DO_FAKE.toqueAteAtender } },
      { aos: TEMPOS_DO_FAKE.toqueAteAtender + TEMPOS_DO_FAKE.conversa, evento: { tipo: "encerrada", callId: "k1", motivoLocal: "contato_desligou" } },
    ]);
    expect(TEMPOS_DO_FAKE.conversa).toBeGreaterThanOrEqual(30_000);
  });

  it("nao_atende: toca e termina sem atender", async () => {
    const { marcas } = await rodar("nao_atende", 60_000);
    expect(marcas.map((m) => m.evento.tipo)).toEqual(["chamando", "encerrada"]);
    expect(marcas[1]).toEqual({ aos: TEMPOS_DO_FAKE.toqueSemAtender, evento: { tipo: "encerrada", callId: "k1", motivoLocal: "desconhecido" } });
  });

  it("ocupado: o contato recusa logo", async () => {
    const { marcas } = await rodar("ocupado", 60_000);
    expect(marcas.map((m) => m.evento.tipo)).toEqual(["chamando", "encerrada"]);
    expect(marcas[1]).toEqual({ aos: TEMPOS_DO_FAKE.ateOcupado, evento: { tipo: "encerrada", callId: "k1", motivoLocal: "contato_desligou" } });
  });

  it("cai_no_meio: atende e a conexão cai", async () => {
    const { marcas } = await rodar("cai_no_meio", 60_000);
    expect(marcas.map((m) => m.evento.tipo)).toEqual(["chamando", "atendida", "encerrada"]);
    expect(marcas[2]).toEqual({
      aos: TEMPOS_DO_FAKE.toqueAteAtender + TEMPOS_DO_FAKE.ateCair,
      evento: { tipo: "encerrada", callId: "k1", motivoLocal: "falha_de_rede" },
    });
  });

  it("microfone_negado: preparar e iniciar rejeitam com o código, sem evento nenhum", async () => {
    const motor = criarMotorFake({ cenario: "microfone_negado" });
    const eventos: EventoDoMotor[] = [];
    motor.aoEvento((e) => eventos.push(e));
    const falha = await motor.preparar().catch((e: unknown) => e);
    expect(ehErroDoMotor(falha) && falha.codigo).toBe("microfone_negado");
    const falha2 = await motor.iniciar({ callId: "k1", credencialDoNavegador: null }).catch((e: unknown) => e);
    expect(ehErroDoMotor(falha2) && falha2.codigo).toBe("microfone_negado");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(eventos).toEqual([]);
  });

  it("todo cenário conhecido tem um teste acima", () => {
    expect([...CENARIOS_DO_FAKE].sort()).toEqual(["atende", "cai_no_meio", "microfone_negado", "nao_atende", "ocupado"]);
  });
});

describe("motor Fake: controle da ligação", () => {
  it("desligar no meio emite encerrada desligou uma vez e cala os timers", async () => {
    const { motor, marcas } = await rodar("atende", 3_000);
    await motor.desligar();
    await motor.desligar();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(marcas.map((m) => m.evento.tipo)).toEqual(["chamando", "atendida", "encerrada"]);
    expect(marcas[2]?.evento).toEqual({ tipo: "encerrada", callId: "k1", motivoLocal: "desligou" });
  });

  it("liberar cala o motor, é idempotente e impede uma nova ligação", async () => {
    const { motor, marcas } = await rodar("atende", 1_000);
    motor.liberar();
    motor.liberar();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(marcas.map((m) => m.evento.tipo)).toEqual(["chamando"]);
    expect(motor.foiLiberado()).toBe(true);
    const falha = await motor.iniciar({ callId: "k2", credencialDoNavegador: null }).catch((e: unknown) => e);
    expect(ehErroDoMotor(falha) && falha.codigo).toBe("provedor");
  });

  it("não inicia duas vezes", async () => {
    const { motor } = await rodar("atende", 0);
    const falha = await motor.iniciar({ callId: "k2", credencialDoNavegador: null }).catch((e: unknown) => e);
    expect(ehErroDoMotor(falha) && falha.codigo).toBe("provedor");
  });

  it("cancelar a assinatura para de ouvir", async () => {
    const motor = criarMotorFake({ cenario: "atende" });
    const a: EventoDoMotor[] = [];
    const b: EventoDoMotor[] = [];
    const cancelarA = motor.aoEvento((e) => a.push(e));
    motor.aoEvento((e) => b.push(e));
    await motor.iniciar({ callId: "k1", credencialDoNavegador: null });
    await vi.advanceTimersByTimeAsync(0);
    cancelarA();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(a.map((e) => e.tipo)).toEqual(["chamando"]);
    expect(b.map((e) => e.tipo)).toEqual(["chamando", "atendida"]);
  });

  it("guarda o mudo e só aceita teclas de telefone durante a ligação", async () => {
    const motor = criarMotorFake({ cenario: "atende" });
    motor.digito?.("5");
    expect(motor.digitosRecebidos()).toEqual([]);
    await motor.iniciar({ callId: "k1", credencialDoNavegador: null });
    for (const t of ["1", "#", "*", "x", "12", ""]) motor.digito?.(t);
    expect(motor.digitosRecebidos()).toEqual(["1", "#", "*"]);
    motor.silenciar(true);
    expect(motor.mudoAgora()).toBe(true);
    motor.silenciar(false);
    expect(motor.mudoAgora()).toBe(false);
  });

  it("diz as capacidades que a barra usa", () => {
    expect(criarMotorFake().capacidades).toEqual({ mudo: true, teclado: true, aoVivo: true });
    expect(criarMotorFake().chave).toBe("fake");
  });
});

describe("cenarioSalvo", () => {
  const storage = (valor: string | null) => ({ getItem: (k: string) => (k === CHAVE_DO_CENARIO_NO_STORAGE ? valor : null) });

  it("lê o cenário da chave crmagro:ligacao:fake", () => {
    expect(CHAVE_DO_CENARIO_NO_STORAGE).toBe("crmagro:ligacao:fake");
    for (const c of CENARIOS_DO_FAKE) expect(cenarioSalvo(storage(c))).toBe(c);
  });

  it("valor estranho, vazio ou sem storage vira atende", () => {
    expect(cenarioSalvo(storage("explode"))).toBe("atende");
    expect(cenarioSalvo(storage(""))).toBe("atende");
    expect(cenarioSalvo(storage(null))).toBe("atende");
    expect(cenarioSalvo(null)).toBe("atende");
    expect(cenarioSalvo()).toBe("atende");
  });

  it("storage bloqueado (lança) vira atende", () => {
    const bloqueado = {
      getItem: () => {
        throw new DOMException("bloqueado", "SecurityError");
      },
    };
    expect(cenarioSalvo(bloqueado)).toBe("atende");
  });

  it("o motor sem cenário informado usa o salvo", async () => {
    vi.stubGlobal("localStorage", storage("ocupado"));
    const motor = criarMotorFake();
    vi.unstubAllGlobals();
    const eventos: EventoDoMotor[] = [];
    motor.aoEvento((e) => eventos.push(e));
    await motor.iniciar({ callId: "k1", credencialDoNavegador: null });
    await vi.advanceTimersByTimeAsync(TEMPOS_DO_FAKE.ateOcupado);
    expect(eventos.map((e) => e.tipo)).toEqual(["chamando", "encerrada"]);
  });
});
