import { describe, it, expect, beforeEach } from "vitest";
import { redisEstado } from "../shared/redis-cache";
import { adiamentoDoPassoSemFicha, adiamentoPorJustica, custoDoPasso, CUSTO_PASSO_LEVE, reservarVezDoTime } from "./justica";

/**
 * Ficha do time por TIPO DE PASSO (incidente de 02/10/2026). Antes todo passo gastava uma ficha dos 120/min: um fluxo
 * que só valida, marca tag e cadastra no funil levava ~47 min para muitos contatos. Redis de TESTE real.
 */
const sufixo = Math.random().toString(36).slice(2, 8);
const time = (n: string) => `justica-${n}-${sufixo}`;

describe("custo do passo", () => {
  it("passo só de banco custa pouco; envio, IA, HTTP e consulta a serviço de fora custam uma ficha", () => {
    for (const tipo of ["add_tag", "update_stage", "create_deal", "wait", "notify_user", "sync_name", "ab_split", "end", "manual_call", "switch_flow"]) {
      expect(custoDoPasso({ tipo })).toBe(CUSTO_PASSO_LEVE);
    }
    for (const tipo of ["send_message", "send_email", "send_social", "ai_agent", "http_request", "typing", "save_history", "enrich_data"]) {
      expect(custoDoPasso({ tipo })).toBe(1);
    }
    expect(CUSTO_PASSO_LEVE).toBeLessThan(1);
  });

  it("condição: só custa uma ficha se algum ramo consulta a Evolution (histórico no WhatsApp)", () => {
    const comRamo = (type: string) => ({ tipo: "condition", branches: { branches: [{ condition: { type } }], default: null } });
    expect(custoDoPasso(comRamo("tag_present"))).toBe(CUSTO_PASSO_LEVE);
    expect(custoDoPasso(comRamo("whatsapp_name"))).toBe(CUSTO_PASSO_LEVE);
    expect(custoDoPasso(comRamo("has_whatsapp"))).toBe(CUSTO_PASSO_LEVE); // só lê o cadastro
    // "Conferir no WhatsApp" pergunta à Evolution: uma ficha inteira (ver conferir-whatsapp.test.ts).
    expect(custoDoPasso({ tipo: "condition", branches: { branches: [{ condition: { type: "has_whatsapp", modo: "verificar" } }], default: null } })).toBe(1);
    expect(custoDoPasso(comRamo("has_email"))).toBe(CUSTO_PASSO_LEVE);
    expect(custoDoPasso(comRamo("channel_history"))).toBe(1);
    expect(custoDoPasso({ tipo: "condition", branches: { branches: [{ condition: { type: "tag_present" } }, { condition: { type: "channel_history" } }] } })).toBe(1);
  });
});

describe("balde do time com custo", () => {
  beforeEach(async () => {
    await redisEstado().del(`flow:balde:${time("a")}`, `flow:balde:${time("b")}`);
  });

  it("passo leve passa muito mais que o de envio no mesmo minuto", async () => {
    const a = time("a");
    const agora = Date.now();
    const leves: number[] = [];
    for (let i = 0; i < 40; i++) leves.push(await reservarVezDoTime(a, { porMinuto: 3, agora, custo: CUSTO_PASSO_LEVE }));
    // 3 fichas a 0,1 = ~30 passos leves de uma vez (10 vezes mais que os 3 envios); depois espera.
    expect(leves.slice(0, 25).every((x) => x === 0)).toBe(true);
    expect(leves.slice(25).some((x) => x > 0)).toBe(true);

    const b = time("b");
    const envios: number[] = [];
    for (let i = 0; i < 4; i++) envios.push(await reservarVezDoTime(b, { porMinuto: 3, agora, custo: 1 }));
    expect(envios.slice(0, 3)).toEqual([0, 0, 0]);
    expect(envios[3]).toBeGreaterThan(0); // o 4º envio espera (comportamento de sempre)
  });

  it("sem custo informado, vale uma ficha (a campanha segue como antes)", async () => {
    const a = time("a");
    const agora = Date.now();
    const r: number[] = [];
    for (let i = 0; i < 4; i++) r.push(await reservarVezDoTime(a, { porMinuto: 3, agora }));
    expect(r.slice(0, 3)).toEqual([0, 0, 0]);
    expect(r[3]).toBeGreaterThan(0);
  });

  it("a espera é proporcional ao que falta (custo maior espera mais)", async () => {
    const a = time("a");
    const agora = Date.now();
    for (let i = 0; i < 3; i++) await reservarVezDoTime(a, { porMinuto: 3, agora, custo: 1 }); // esvazia
    const meia = await reservarVezDoTime(a, { porMinuto: 3, agora, custo: 0.5 });
    const inteira = await reservarVezDoTime(a, { porMinuto: 3, agora, custo: 1 });
    expect(meia).toBeGreaterThan(0);
    expect(inteira).toBeGreaterThan(meia);
  });
});

describe("quando o passo não tem ficha", () => {
  it("volta entre ~5 s e 20 s (espalhado); a campanha segue com a folga curta de antes", () => {
    for (let i = 0; i < 200; i++) {
      const p = adiamentoDoPassoSemFicha(300);
      expect(p).toBeGreaterThanOrEqual(5_000);
      expect(p).toBeLessThanOrEqual(20_000);
      const c = adiamentoPorJustica(300);
      expect(c).toBeGreaterThanOrEqual(5_000);
      expect(c).toBeLessThanOrEqual(7_000);
    }
  });
});
