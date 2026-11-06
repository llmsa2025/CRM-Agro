import { describe, it, expect, vi } from "vitest";
import { criarFreioDeInscricao, PAUSA_ENTRE_LOTES_MS, LOTE_INSCRICAO, AGENDAR_EM_PARALELO } from "./pressao";

/** Freio da inscrição em massa (incidente de 02/10/2026): relógio e fila FALSOS, nada espera de verdade. */
describe("freio da inscrição em massa", () => {
  const relogio = () => {
    const esperas: number[] = [];
    return { esperas, dormir: async (ms: number) => void esperas.push(ms) };
  };

  it("lotes pequenos e paralelismo limitado", () => {
    expect(LOTE_INSCRICAO).toBeLessThanOrEqual(100);
    expect(AGENDAR_EM_PARALELO).toBeLessThanOrEqual(25);
  });

  it("fila folgada: só a pausa curta entre os lotes", async () => {
    const { esperas, dormir } = relogio();
    const medir = vi.fn(async () => 10);
    const freio = criarFreioDeInscricao({ medir, dormir, limite: 3000 });
    await freio.entreLotes();
    await freio.entreLotes();
    expect(esperas).toEqual([PAUSA_ENTRE_LOTES_MS, PAUSA_ENTRE_LOTES_MS]);
    expect(medir).toHaveBeenCalledTimes(2);
  });

  it("fila cheia: espera baixar e segue assim que baixa", async () => {
    const { esperas, dormir } = relogio();
    const leituras = [9000, 8000, 5000, 2900];
    const medir = vi.fn(async () => leituras.shift()!);
    const freio = criarFreioDeInscricao({ medir, dormir, limite: 3000, orcamentoMs: 20_000 });
    await freio.entreLotes();
    expect(medir).toHaveBeenCalledTimes(4);
    expect(esperas).toEqual([PAUSA_ENTRE_LOTES_MS, 500, 500, 500]); // 3 esperas até a 4ª leitura baixar
    expect(freio.esperouAteOFim()).toBe(false);
  });

  it("fila que não baixa: o ORÇAMENTO acaba e a inscrição segue (nunca fica pendurada)", async () => {
    const { esperas, dormir } = relogio();
    const freio = criarFreioDeInscricao({ medir: async () => 99_999, dormir, limite: 3000, orcamentoMs: 2_000 });
    await freio.entreLotes();
    expect(freio.esperouAteOFim()).toBe(true);
    expect(esperas.slice(1).reduce((a, b) => a + b, 0)).toBe(2_000);
    // O orçamento é da chamada: no lote seguinte não espera mais, só a pausa curta.
    const antes = esperas.length;
    await freio.entreLotes();
    expect(esperas.slice(antes)).toEqual([PAUSA_ENTRE_LOTES_MS]);
  });

  it("erro ao medir (Redis fora) não segura a inscrição", async () => {
    const { esperas, dormir } = relogio();
    const freio = criarFreioDeInscricao({
      medir: async () => {
        throw new Error("Redis fora");
      },
      dormir,
    });
    await freio.entreLotes();
    expect(esperas).toEqual([PAUSA_ENTRE_LOTES_MS]);
  });
});
