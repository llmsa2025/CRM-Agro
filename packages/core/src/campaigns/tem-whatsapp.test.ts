import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { ForbiddenError } from "../auth/authz";
import { OwnedNotFound } from "../tenancy/assert-owned";
import { redisEstado } from "../shared/redis-cache";
import { temWhatsApp, numerosSemWhatsApp, VALIDADE_CHECAGEM_DIAS, VALIDADE_SEM_WHATSAPP_DIAS, LOTE_SUSPEITO_MIN } from "./tem-whatsapp";

/**
 * Campanhas A.4 — "Tem WhatsApp?" sem enviar. A Evolution é um `fetch` mockado:
 * o teste confere que SÓ `/chat/whatsappNumbers` é chamado (nunca envio), que o
 * cache global vem primeiro e que a consulta sai pela conta do próprio time.
 */

const TEAM_A = "00000000-0000-0000-0000-0000000001ab";
const TEAM_B = "00000000-0000-0000-0000-0000000001ac";
const TIMES = [TEAM_A, TEAM_B];
/** Faixa de números só deste teste (o cache é global: limpa só estes). */
const PREFIXO = "+55659887";
const num = (i: number) => `${PREFIXO}${String(i).padStart(5, "0")}`;
/** O mesmo número como vem de planilha. */
const planilha = (i: number) => `(65) 9887-${String(i).padStart(5, "0").slice(0, 1)}${String(i).padStart(5, "0").slice(1)}`;

type Resposta = { exists: boolean; name?: string; semEco?: boolean; jid?: string };
const respostas = new Map<string, Resposta>();
const chamadas: { url: string; numbers: string[] }[] = [];
let falhar = false;

const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (!u.includes("/chat/whatsappNumbers/")) throw new Error(`endpoint proibido no teste: ${u}`);
  const numbers = (JSON.parse(String(init?.body)) as { numbers: string[] }).numbers;
  chamadas.push({ url: u, numbers });
  if (falhar) return new Response("erro", { status: 500 });
  const corpo = numbers.flatMap((n) => {
    const r = respostas.get(n);
    if (!r) return [];
    return [{ exists: r.exists, jid: r.jid ?? `${n}@s.whatsapp.net`, ...(r.semEco ? {} : { number: n }), ...(r.name ? { name: r.name } : {}) }];
  });
  return new Response(JSON.stringify(corpo), { status: 200, headers: { "Content-Type": "application/json" } });
});

const contas: string[] = [];
async function conta(teamId: string, dados: { status?: "connected" | "disconnected"; paused?: boolean } = {}) {
  const c = await basePrisma.channelAccount.create({
    data: {
      teamId,
      canal: "whatsapp",
      label: "WhatsApp comercial",
      provider: "evolution",
      externalId: `inst-${randomUUID().slice(0, 8)}`,
      status: dados.status ?? "connected",
      paused: dados.paused ?? false,
    },
  });
  contas.push(c.id);
  return { id: c.id, instance: c.externalId! };
}

async function limpar() {
  await basePrisma.channelAccount.deleteMany({ where: { teamId: { in: TIMES } } });
  await basePrisma.whatsAppNumberCheck.deleteMany({ where: { numero: { startsWith: PREFIXO } } });
  const hoje = new Date().toISOString().slice(0, 10);
  for (const id of contas.splice(0)) await redisEstado().del(`wa:checagem:${id}:${hoje}`);
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Time A (agente A — tem WhatsApp)"],
    [TEAM_B, "Time B (agente A — tem WhatsApp)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
  vi.stubGlobal("fetch", fetchMock);
});
beforeEach(async () => {
  respostas.clear();
  chamadas.length = 0;
  falhar = false;
  fetchMock.mockClear();
  process.env.WA_CHECAGEM_PAUSA_MS = "0";
  delete process.env.WA_CHECAGEM_DIA;
  await limpar();
});
afterEach(limpar);
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.WA_CHECAGEM_PAUSA_MS;
});

const digitos = (s: string) => s.replace(/\D/g, "");

describe("temWhatsApp", () => {
  it("cache primeiro: só o número sem checagem válida vai à Evolution, pela instância do time; nada de envio", async () => {
    const a = await conta(TEAM_A);
    const velho = new Date(Date.now() - (VALIDADE_CHECAGEM_DIAS + 1) * 86_400_000);
    await basePrisma.whatsAppNumberCheck.createMany({
      data: [
        { numero: num(1), existe: true, jid: `${digitos(num(1))}@s.whatsapp.net` },
        { numero: num(2), existe: false },
        { numero: num(3), existe: true, checkedAt: velho }, // vencida: consulta de novo
      ],
    });
    respostas.set(digitos(num(3)), { exists: false });
    respostas.set(digitos(num(4)), { exists: true, name: "Ana Almeida" });
    // num(5) a Evolution não responde → "não sei".

    const r = await runWithTeam(TEAM_A, async () =>
      temWhatsApp([num(1), planilha(2), num(3), num(4), num(5), "123", num(4)], { instance: a.instance }),
    );
    expect(Object.fromEntries(r)).toEqual({
      [num(1)]: { existe: true, nome: null },
      [num(2)]: { existe: false, nome: null },
      [num(3)]: { existe: false, nome: null },
      [num(4)]: { existe: true, nome: "Ana Almeida" },
      [num(5)]: { existe: null, nome: null },
    });
    // Uma chamada, só com os 3 sem checagem válida, na instância do time A.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toMatch(new RegExp(`/chat/whatsappNumbers/${a.instance}$`));
    expect(chamadas[0]!.numbers.sort()).toEqual([num(3), num(4), num(5)].map(digitos).sort());

    // Cache atualizado (sem nome); o "não sei" não é gravado.
    const cache = await basePrisma.whatsAppNumberCheck.findMany({ where: { numero: { startsWith: PREFIXO } }, orderBy: { numero: "asc" } });
    expect(cache.map((c) => [c.numero, c.existe])).toEqual([
      [num(1), true],
      [num(2), false],
      [num(3), false],
      [num(4), true],
    ]);
    expect(cache.find((c) => c.numero === num(3))!.checkedAt.getTime()).toBeGreaterThan(velho.getTime());
    expect(cache.find((c) => c.numero === num(4))!.jid).toBe(`${digitos(num(4))}@s.whatsapp.net`);

    // De novo: tudo do cache (só o "não sei" volta à Evolution).
    chamadas.length = 0;
    await runWithTeam(TEAM_A, async () => temWhatsApp([num(1), num(3), num(4), num(5)], { channelAccountId: a.id }));
    expect(chamadas.map((c) => c.numbers)).toEqual([[digitos(num(5))]]);
  });

  it("lotes de 50 com pausa entre eles", async () => {
    const a = await conta(TEAM_A);
    const numeros = Array.from({ length: 120 }, (_, i) => num(100 + i));
    for (const n of numeros) respostas.set(digitos(n), { exists: true });
    process.env.WA_CHECAGEM_PAUSA_MS = "40";
    const t0 = Date.now();
    const r = await runWithTeam(TEAM_A, async () => temWhatsApp(numeros, { channelAccountId: a.id }));
    expect(chamadas.map((c) => c.numbers.length)).toEqual([50, 50, 20]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80); // 2 pausas de ≥ 40 ms
    expect([...r.values()].every((v) => v.existe === true)).toBe(true);
  });

  it("dois times: o cache é global, mas a consulta nova sai pela conta do PRÓPRIO time; conta alheia é recusada", async () => {
    const a = await conta(TEAM_A);
    const b = await conta(TEAM_B);
    respostas.set(digitos(num(10)), { exists: true, name: "Nome da agenda do A" });
    respostas.set(digitos(num(11)), { exists: false });

    await runWithTeam(TEAM_A, async () => temWhatsApp([num(10)], { instance: a.instance }));
    await runWithTeam(TEAM_B, async () => {
      await expect(temWhatsApp([num(11)], { instance: a.instance })).rejects.toBeInstanceOf(OwnedNotFound);
      await expect(temWhatsApp([num(11)], { channelAccountId: a.id })).rejects.toBeInstanceOf(OwnedNotFound);
      chamadas.length = 0;
      const r = await temWhatsApp([num(10), num(11)], { instance: b.instance });
      // num(10) vem do cache (sem o nome da agenda do A); num(11) consulta pela instância do B.
      expect(r.get(num(10))).toEqual({ existe: true, nome: null });
      expect(r.get(num(11))).toEqual({ existe: false, nome: null });
      expect(chamadas).toHaveLength(1);
      expect(chamadas[0]!.url).toMatch(new RegExp(`/chat/whatsappNumbers/${b.instance}$`));
      expect(chamadas[0]!.numbers).toEqual([digitos(num(11))]);
    });
  });

  it("conta desconectada, pausada ou ausente: só o cache, sem consultar", async () => {
    const off = await conta(TEAM_A, { status: "disconnected" });
    const pausada = await conta(TEAM_A, { paused: true });
    await basePrisma.whatsAppNumberCheck.create({ data: { numero: num(20), existe: true } });
    respostas.set(digitos(num(21)), { exists: true });
    await runWithTeam(TEAM_A, async () => {
      for (const opts of [{ channelAccountId: off.id }, { instance: pausada.instance }, {}, { instance: null }]) {
        const r = await temWhatsApp([num(20), num(21)], opts);
        expect(Object.fromEntries(r)).toEqual({ [num(20)]: { existe: true, nome: null }, [num(21)]: { existe: null, nome: null } });
      }
    });
    expect(chamadas).toHaveLength(0);
  });

  it("Evolution fora: o lote fica \"não sei\" e para de insistir", async () => {
    const a = await conta(TEAM_A);
    falhar = true;
    const numeros = Array.from({ length: 80 }, (_, i) => num(300 + i));
    const r = await runWithTeam(TEAM_A, async () => temWhatsApp(numeros, { channelAccountId: a.id }));
    expect(chamadas).toHaveLength(1);
    expect([...r.values()].every((v) => v.existe === null)).toBe(true);
    expect(await basePrisma.whatsAppNumberCheck.count({ where: { numero: { startsWith: PREFIXO } } })).toBe(0);
  });

  it("teto diário por conta: o que passa do teto fica \"não sei\"", async () => {
    const a = await conta(TEAM_A);
    process.env.WA_CHECAGEM_DIA = "60";
    const numeros = Array.from({ length: 120 }, (_, i) => num(500 + i));
    for (const n of numeros) respostas.set(digitos(n), { exists: true });
    const r = await runWithTeam(TEAM_A, async () => temWhatsApp(numeros, { channelAccountId: a.id }));
    expect(chamadas.map((c) => c.numbers.length)).toEqual([50, 10]);
    expect([...r.values()].filter((v) => v.existe === true)).toHaveLength(60);
    expect([...r.values()].filter((v) => v.existe === null)).toHaveLength(60);
    // No mesmo dia, a conta não consulta mais nada.
    chamadas.length = 0;
    await runWithTeam(TEAM_A, async () => temWhatsApp([num(700)], { channelAccountId: a.id }));
    expect(chamadas).toHaveLength(0);
  });

  it("cache global protegido: \"não tem\" vale 7 dias (o \"tem\", 30) e lote inteiro \"não tem\" vira \"não sei\"", async () => {
    const a = await conta(TEAM_A);
    const dias = (d: number) => new Date(Date.now() - d * 86_400_000);
    await basePrisma.whatsAppNumberCheck.createMany({
      data: [
        { numero: num(40), existe: true, checkedAt: dias(10) }, // "tem" de 10 dias: vale
        { numero: num(41), existe: false, checkedAt: dias(VALIDADE_SEM_WHATSAPP_DIAS - 1) }, // "não tem" recente: vale
        { numero: num(42), existe: false, checkedAt: dias(VALIDADE_SEM_WHATSAPP_DIAS + 1) }, // "não tem" velho: pergunta de novo
      ],
    });
    respostas.set(digitos(num(42)), { exists: true });
    const r = await runWithTeam(TEAM_A, async () => temWhatsApp([num(40), num(41), num(42)], { channelAccountId: a.id }));
    expect(chamadas.map((c) => c.numbers)).toEqual([[digitos(num(42))]]);
    expect([r.get(num(40))?.existe, r.get(num(41))?.existe, r.get(num(42))?.existe]).toEqual([true, false, true]);

    // Sessão "conectada" que responde tudo false: suspeito — "não sei" para o time e fora do cache global.
    const suspeitos = Array.from({ length: LOTE_SUSPEITO_MIN + 5 }, (_, i) => num(1000 + i));
    for (const n of suspeitos) respostas.set(digitos(n), { exists: false });
    const s0 = await runWithTeam(TEAM_A, async () => temWhatsApp(suspeitos, { channelAccountId: a.id }));
    expect([...s0.values()].every((v) => v.existe === null)).toBe(true);
    const s1 = await runWithTeam(TEAM_A, async () => numerosSemWhatsApp(suspeitos, { channelAccountId: a.id }));
    expect(s1.size).toBe(0); // a campanha não pula ninguém por uma resposta suspeita
    expect(await basePrisma.whatsAppNumberCheck.count({ where: { numero: { in: suspeitos } } })).toBe(0);

    // Lote misto (com algum "tem"): grava normalmente.
    const mistos = Array.from({ length: LOTE_SUSPEITO_MIN + 5 }, (_, i) => num(1100 + i));
    mistos.forEach((n, i) => respostas.set(digitos(n), { exists: i === 0 }));
    await runWithTeam(TEAM_A, async () => temWhatsApp(mistos, { channelAccountId: a.id }));
    expect(await basePrisma.whatsAppNumberCheck.count({ where: { numero: { in: mistos } } })).toBe(mistos.length);

    // O contador do dia tem prazo (nunca fica sem TTL).
    const pttl = await redisEstado().pttl(`wa:checagem:${a.id}:${new Date().toISOString().slice(0, 10)}`);
    expect(pttl).toBeGreaterThan(0);
  });

  it("casa a resposta pelo jid quando a Evolution não ecoa o número (conta antiga, sem o 9º dígito)", async () => {
    const a = await conta(TEAM_A);
    const n = num(800); // +5565988700800
    const semNono = digitos(n).slice(0, 4) + digitos(n).slice(5); // 556588700800
    respostas.set(digitos(n), { exists: true, semEco: true, jid: `${semNono}@s.whatsapp.net` });
    const r = await runWithTeam(TEAM_A, async () => temWhatsApp([n], { channelAccountId: a.id }));
    expect(r.get(n)).toEqual({ existe: true, nome: null });
    expect((await basePrisma.whatsAppNumberCheck.findUnique({ where: { numero: n } }))?.jid).toBe(`${semNono}@s.whatsapp.net`);
  });

  it("numerosSemWhatsApp: só a resposta certa de que NÃO tem; viewer não consulta", async () => {
    const a = await conta(TEAM_A);
    respostas.set(digitos(num(900)), { exists: true });
    respostas.set(digitos(num(901)), { exists: false });
    const sem = await runWithTeam(TEAM_A, async () => numerosSemWhatsApp([num(900), num(901), num(902)], { channelAccountId: a.id }));
    expect([...sem]).toEqual([num(901)]);
    await expect(
      runWithTeam(TEAM_A, async () => temWhatsApp([num(900)], { channelAccountId: a.id }), { userId: randomUUID(), role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
