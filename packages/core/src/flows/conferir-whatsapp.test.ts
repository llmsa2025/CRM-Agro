import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { ForbiddenError } from "../auth/authz";
import { redisEstado } from "../shared/redis-cache";
import { runWithTeam } from "../test-support/identidade";
import { conditionDefSchema, flowSnapshotSchema } from "./schema";
import { executeNode } from "./executor";
import { custoDoPasso, CUSTO_PASSO_LEVE } from "./justica";
import { hashDoSnapshot } from "./versao";
import { ConsultaWhatsAppIndisponivel } from "./errors";
import {
  conferirTemWhatsApp,
  MOTIVO_CONTA_CAIDA,
  MOTIVO_CONTA_PAUSADA,
  MOTIVO_FORA_DO_HORARIO,
  MOTIVO_RITMO,
  MOTIVO_SEM_CONTA,
  MOTIVO_TETO_DO_DIA,
} from "./conferir-whatsapp";

/**
 * Condição "Tem WhatsApp" no modo "Conferir no WhatsApp". A Evolution é um `fetch` mockado: o teste confere que SÓ
 * `/chat/whatsappNumbers` é chamado (nunca envio), a ordem cadastro, cache, consulta, e que "não" NÃO marca o cadastro
 * nem vai para o cache global. Contatos e contas descartáveis.
 */
const TEAM_A = "00000000-0000-0000-0000-0000000008c1";
const TEAM_B = "00000000-0000-0000-0000-0000000008c2";
const TIMES = [TEAM_A, TEAM_B];
/** Faixa de números só deste teste (o cache é global: limpa só estes). */
const PREFIXO = "+55659999";
const num = (i: number) => `${PREFIXO}${String(i).padStart(5, "0")}`;
const digitos = (s: string) => s.replace(/\D/g, "");

type Resposta = { exists: boolean; name?: string; jid?: string };
const respostas = new Map<string, Resposta>();
const chamadas: { url: string; numbers: string[] }[] = [];
let modoDaEvolution: "ok" | "erro" | "vazio" = "ok";

const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (!u.includes("/chat/whatsappNumbers/")) throw new Error(`endpoint proibido no teste: ${u}`);
  const numbers = (JSON.parse(String(init?.body)) as { numbers: string[] }).numbers;
  chamadas.push({ url: u, numbers });
  if (modoDaEvolution === "erro") return new Response("fora do ar", { status: 503 });
  if (modoDaEvolution === "vazio") return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  const corpo = numbers.flatMap((n) => {
    const r = respostas.get(n);
    return r ? [{ exists: r.exists, jid: r.jid ?? `${n}@s.whatsapp.net`, number: n, ...(r.name ? { name: r.name } : {}) }] : [];
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

let contatoId = "";
async function contatoDe(teamId: string, numero?: string, extra: { invalido?: boolean } = {}) {
  const c = await basePrisma.contact.create({ data: { teamId, nome: "Lead" } });
  if (numero) await basePrisma.channelIdentifier.create({ data: { teamId, contactId: c.id, canal: "whatsapp", valor: numero, ...extra } });
  return c.id;
}

async function limpar() {
  for (const teamId of TIMES) {
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  }
  await basePrisma.whatsAppNumberCheck.deleteMany({ where: { numero: { startsWith: PREFIXO } } });
  const r = redisEstado();
  const hoje = new Date().toISOString().slice(0, 10);
  for (const id of contas.splice(0)) await r.del(`wa:checagem:${id}:${hoje}`, `wa:conferir:prox:${id}`, ...(await r.keys(`wa:conferir:vez:${id}:*`)));
  const lembrados = await r.keys("wa:conferir:nao:*");
  if (lembrados.length > 0) await r.del(...lembrados);
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Time A (condição conferir WhatsApp)"],
    [TEAM_B, "Time B (condição conferir WhatsApp)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
  vi.stubGlobal("fetch", fetchMock);
});
beforeEach(async () => {
  respostas.clear();
  chamadas.length = 0;
  modoDaEvolution = "ok";
  fetchMock.mockClear();
  delete process.env.WA_CHECAGEM_DIA;
  delete process.env.FLOW_CONFERIR_WHATSAPP;
  // Ritmo fixo de 2 s para os números do teste serem exatos.
  process.env.WA_CONFERIR_RITMO_MIN_S = "2";
  process.env.WA_CONFERIR_RITMO_MAX_S = "2";
  await limpar();
  contatoId = "";
});
afterEach(limpar);
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.WA_CONFERIR_RITMO_MIN_S;
  delete process.env.WA_CONFERIR_RITMO_MAX_S;
});

const VERIFICAR = { type: "has_whatsapp", modo: "verificar" } as const;
const SIM = "SIM";
const NAO = "NAO";

const no = (condition: object) => ({
  id: "cond",
  tipo: "condition",
  branches: { branches: [{ id: "b", label: "Tem WhatsApp", condition, nextNodeId: SIM }], default: NAO },
});
const ctx = (teamId: string, contactId: string, extra: object = {}) =>
  ({ id: "enr-conferir", teamId, contactId, lastOutboundAt: null, round: 1, contact: { id: contactId, nome: "Lead", tags: [], ownerId: null, relacionamentoStatus: "novo" }, ...extra }) as never;
const rodar = (teamId: string, contactId: string, condition: object, extra: object = {}) =>
  runWithTeam(teamId, () => executeNode(ctx(teamId, contactId, extra), no(condition) as never));
const decidir = async (teamId: string, contactId: string, condition: object = VERIFICAR) => (await rodar(teamId, contactId, condition)).nextNodeId;
const conferir = (teamId: string, contactId: string, extra: { enrollmentId?: string; agora?: Date } = {}) =>
  runWithTeam(teamId, () => conferirTemWhatsApp({ contactId, enrollmentId: extra.enrollmentId ?? "enr-conferir", nodeId: "cond", ...(extra.agora ? { agora: extra.agora } : {}) }));
const noCache = (numero: string) => basePrisma.whatsAppNumberCheck.findUnique({ where: { numero } });

describe("modo 'No cadastro' (o de antes) não muda nada", () => {
  it("sem `modo` ou com `modo: cadastro`: só olha o cadastro, nunca chama a Evolution", async () => {
    await conta(TEAM_A);
    const com = await contatoDe(TEAM_A, num(1));
    const sem = await contatoDe(TEAM_A);
    expect(await decidir(TEAM_A, com, { type: "has_whatsapp" })).toBe(SIM);
    expect(await decidir(TEAM_A, com, { type: "has_whatsapp", modo: "cadastro" })).toBe(SIM);
    expect(await decidir(TEAM_A, sem, { type: "has_whatsapp" })).toBe(NAO);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("o grafo de antes passa pelo schema igual: sem `modo` no resultado e com o MESMO hash da FlowVersion", () => {
    const antigo = { id: "c", tipo: "condition", branches: { branches: [{ id: "b", label: "Tem WhatsApp", condition: { type: "has_whatsapp" }, nextNodeId: "z" }], default: null } };
    expect(conditionDefSchema.parse({ type: "has_whatsapp" })).toStrictEqual({ type: "has_whatsapp" });
    const lido = flowSnapshotSchema.parse([antigo]);
    expect("modo" in (lido[0] as { branches: { branches: Array<{ condition: object }> } }).branches.branches[0]!.condition).toBe(false);
    expect(hashDoSnapshot(lido)).toBe(hashDoSnapshot([antigo] as never));
    // O modo novo aceita só os dois valores, sobrevive à leitura (o zod não o descarta) e muda o grafo (e o hash) de propósito.
    expect(conditionDefSchema.parse({ type: "has_whatsapp", modo: "verificar" })).toStrictEqual({ type: "has_whatsapp", modo: "verificar" });
    expect(conditionDefSchema.parse({ type: "has_whatsapp", modo: "cadastro" })).toStrictEqual({ type: "has_whatsapp", modo: "cadastro" });
    expect(conditionDefSchema.safeParse({ type: "has_whatsapp", modo: "talvez" }).success).toBe(false);
  });

  it("FLOW_CONFERIR_WHATSAPP=off: o modo 'conferir' vira 'no cadastro' e a Evolution não é chamada", async () => {
    process.env.FLOW_CONFERIR_WHATSAPP = "off";
    await conta(TEAM_A);
    contatoId = await contatoDe(TEAM_A, num(2));
    expect(await decidir(TEAM_A, contatoId)).toBe(SIM);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("conferir: cadastro e cache vêm antes da consulta", () => {
  it("sem número no cadastro = 'não', sem consultar (nem exige conta)", async () => {
    contatoId = await contatoDe(TEAM_A);
    expect(await decidir(TEAM_A, contatoId)).toBe(NAO);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("só número marcado como errado = 'não', sem consultar; outro número bom volta a consultar", async () => {
    await conta(TEAM_A);
    contatoId = await contatoDe(TEAM_A, num(3), { invalido: true });
    expect(await decidir(TEAM_A, contatoId)).toBe(NAO);
    expect(fetchMock).not.toHaveBeenCalled();
    respostas.set(digitos(num(4)), { exists: true });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM_A, contactId: contatoId, canal: "whatsapp", valor: num(4) } });
    expect(await decidir(TEAM_A, contatoId)).toBe(SIM);
    // Consultou o número BOM, nunca o marcado como errado.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.numbers).toEqual([digitos(num(4))]);
  });

  it("valor que não é telefone no cadastro = 'não', sem consultar", async () => {
    await conta(TEAM_A);
    contatoId = await contatoDe(TEAM_A, "123");
    expect(await decidir(TEAM_A, contatoId)).toBe(NAO);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cache dentro da validade responde sem consultar (o 'sim' e o 'não'); vencido consulta de novo", async () => {
    await conta(TEAM_A);
    const velho = new Date(Date.now() - 31 * 86_400_000);
    await basePrisma.whatsAppNumberCheck.createMany({
      data: [
        { numero: num(5), existe: true, jid: `${digitos(num(5))}@s.whatsapp.net` },
        { numero: num(6), existe: false },
        { numero: num(7), existe: true, checkedAt: velho },
      ],
    });
    const sim = await contatoDe(TEAM_A, num(5));
    const nao = await contatoDe(TEAM_A, num(6));
    const vencido = await contatoDe(TEAM_A, num(7));
    expect(await decidir(TEAM_A, sim)).toBe(SIM);
    expect(await decidir(TEAM_A, nao)).toBe(NAO);
    expect(fetchMock).not.toHaveBeenCalled();
    respostas.set(digitos(num(7)), { exists: false });
    expect(await decidir(TEAM_A, vencido)).toBe(NAO);
    expect(chamadas).toHaveLength(1);
  });

  it("o cache é global: o time B aproveita o 'sim' do time A, sem conta e sem consulta", async () => {
    await conta(TEAM_A);
    respostas.set(digitos(num(8)), { exists: true, name: "Ana do Time A" });
    const a = await contatoDe(TEAM_A, num(8));
    expect(await decidir(TEAM_A, a)).toBe(SIM);
    expect(chamadas).toHaveLength(1);

    const b = await contatoDe(TEAM_B, num(8)); // o time B nem tem conta de WhatsApp
    expect(await decidir(TEAM_B, b)).toBe(SIM);
    expect(chamadas).toHaveLength(1);
  });
});

describe("conferir: consulta nova", () => {
  it("'sim': consulta UM número só pela conta do próprio time, sem enviar nada, e guarda o 'sim' (sem o nome) no cache", async () => {
    const a = await conta(TEAM_A);
    const b = await conta(TEAM_B);
    respostas.set(digitos(num(10)), { exists: true, name: "Nome que só o time A conhece", jid: "5565999910010@s.whatsapp.net" });
    contatoId = await contatoDe(TEAM_A, num(10));

    const r = await rodar(TEAM_A, contatoId, VERIFICAR);
    expect(r).toMatchObject({ nextNodeId: SIM });
    expect(r.escolha).toMatchObject({ saida: "Tem WhatsApp", senao: false });
    expect(r.deferred).toBeUndefined();

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toContain(`/chat/whatsappNumbers/${a.instance}`);
    expect(chamadas[0]!.url).not.toContain(b.instance);
    expect(chamadas[0]!.numbers).toEqual([digitos(num(10))]);

    const guardado = await noCache(num(10));
    expect(guardado).toMatchObject({ existe: true, jid: "5565999910010@s.whatsapp.net" });
    // Nada do time vaza para a linha global nem para o resultado do passo.
    expect(JSON.stringify(guardado)).not.toContain("Nome que só o time A conhece");
    expect(JSON.stringify(r)).not.toContain("Nome que só o time A conhece");
  });

  it("'não': desvia o ramo, NÃO marca o número como errado no cadastro e NÃO grava 'não' no cache global", async () => {
    await conta(TEAM_A);
    respostas.set(digitos(num(11)), { exists: false });
    contatoId = await contatoDe(TEAM_A, num(11));

    const r = await rodar(TEAM_A, contatoId, VERIFICAR);
    expect(r).toMatchObject({ nextNodeId: NAO });
    expect(r.escolha).toMatchObject({ senao: true });
    expect(chamadas).toHaveLength(1);

    const id = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { contactId: contatoId } });
    expect(id.invalido).toBe(false);
    expect(id.invalidoMotivo).toBeNull();
    expect(await noCache(num(11))).toBeNull();
  });

  it("um 'sim' repetido não consulta de novo (o cache atende)", async () => {
    await conta(TEAM_A);
    respostas.set(digitos(num(12)), { exists: true });
    contatoId = await contatoDe(TEAM_A, num(12));
    expect(await decidir(TEAM_A, contatoId)).toBe(SIM);
    expect(await decidir(TEAM_A, contatoId)).toBe(SIM);
    expect(chamadas).toHaveLength(1);
  });

  it("o 'não' fica lembrado só naquela inscrição e naquele passo (24 h, Redis): reavaliar o nó não consulta de novo; outra inscrição consulta", async () => {
    process.env.WA_CONFERIR_RITMO_MIN_S = "0"; // sem fila entre as consultas, para ver só a memória
    process.env.WA_CONFERIR_RITMO_MAX_S = "0";
    await conta(TEAM_A);
    respostas.set(digitos(num(14)), { exists: false });
    contatoId = await contatoDe(TEAM_A, num(14));
    const igual = { id: "enr-A" };
    expect(await decidir(TEAM_A, contatoId)).toBe(NAO); // consulta
    expect(chamadas).toHaveLength(1);
    expect((await runWithTeam(TEAM_A, () => executeNode(ctx(TEAM_A, contatoId, igual), no(VERIFICAR) as never))).nextNodeId).toBe(NAO); // outra inscrição: consulta
    expect(chamadas).toHaveLength(2);
    expect((await runWithTeam(TEAM_A, () => executeNode(ctx(TEAM_A, contatoId, igual), no(VERIFICAR) as never))).nextNodeId).toBe(NAO); // a mesma de novo: lembra
    expect(chamadas).toHaveLength(2);
    expect(await noCache(num(14))).toBeNull(); // continua fora do cache global
  });

  it("dois ramos 'conferir' no mesmo nó fazem UMA consulta (o segundo usa o 'não' que o primeiro acabou de ouvir)", async () => {
    await conta(TEAM_A);
    respostas.set(digitos(num(15)), { exists: false });
    contatoId = await contatoDe(TEAM_A, num(15));
    const doisRamos = {
      id: "cond",
      tipo: "condition",
      branches: {
        branches: [
          { id: "b1", label: "Tem WhatsApp (conferido no WhatsApp)", condition: VERIFICAR, nextNodeId: SIM },
          { id: "b2", label: "Tem WhatsApp (conferido no WhatsApp)", condition: VERIFICAR, nextNodeId: "OUTRO" },
        ],
        default: NAO,
      },
    };
    const r = await runWithTeam(TEAM_A, () => executeNode(ctx(TEAM_A, contatoId), doisRamos as never));
    expect(r.nextNodeId).toBe(NAO);
    expect(chamadas).toHaveLength(1);
  });

  it("o motor roda como sistema (sem pessoa) e a consulta passa; leitor (viewer) é negado", async () => {
    await conta(TEAM_A);
    respostas.set(digitos(num(13)), { exists: true });
    contatoId = await contatoDe(TEAM_A, num(13));
    const r = await runAsSystem(TEAM_A, () => executeNode(ctx(TEAM_A, contatoId), no(VERIFICAR) as never));
    expect(r.nextNodeId).toBe(SIM);
    await expect(
      runWithTeam(TEAM_A, () => conferirTemWhatsApp({ contactId: contatoId, enrollmentId: "e", nodeId: "n" }), { userId: "leitor", role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("conferir: quando não dá para saber, ADIA (não escolhe ramo no escuro)", () => {
  const adiado = (r: Awaited<ReturnType<typeof rodar>>) => ({ proximo: r.nextNodeId, deferred: r.deferred, escolha: r.escolha });

  it("time sem NENHUMA conta de WhatsApp: SEGURA o contato no passo (esperar não resolve), nada é consultado", async () => {
    contatoId = await contatoDe(TEAM_A, num(20));
    const r = await rodar(TEAM_A, contatoId, VERIFICAR);
    expect(r).toMatchObject({ nextNodeId: "cond", hold: true, skipped: true, motivo: MOTIVO_SEM_CONTA });
    expect(r.deferred).toBeUndefined();
    expect(r.delayMs).toBeUndefined();
    expect(adiado(r).escolha).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("só com conta de outro canal ou de outro time, também segura (a conta do time B não vale para o time A)", async () => {
    await conta(TEAM_B);
    contatoId = await contatoDe(TEAM_A, num(28));
    expect(await rodar(TEAM_A, contatoId, VERIFICAR)).toMatchObject({ hold: true, motivo: MOTIVO_SEM_CONTA });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("conta desconectada (caiu agora): tenta de novo em ~10 a 15 min, sem consultar", async () => {
    await conta(TEAM_A, { status: "disconnected", paused: true });
    contatoId = await contatoDe(TEAM_A, num(21));
    const r = await rodar(TEAM_A, contatoId, VERIFICAR);
    expect(r).toMatchObject({ nextNodeId: "cond", deferred: true, motivo: MOTIVO_CONTA_CAIDA });
    expect(r.delayMs!).toBeGreaterThanOrEqual(10 * 60_000);
    expect(r.delayMs!).toBeLessThanOrEqual(15 * 60_000 + 1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("conta pausada à mão: adia para o próximo dia, sem consultar", async () => {
    await conta(TEAM_A, { paused: true });
    contatoId = await contatoDe(TEAM_A, num(22));
    const r = await rodar(TEAM_A, contatoId, VERIFICAR);
    expect(r).toMatchObject({ nextNodeId: "cond", deferred: true, motivo: MOTIVO_CONTA_PAUSADA });
    expect(r.delayMs!).toBeGreaterThanOrEqual(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("conta desconectada mas ainda não pausada pelo webhook, ou outra conta conectada: usa a conectada", async () => {
    await conta(TEAM_A, { status: "disconnected", paused: true });
    const boa = await conta(TEAM_A);
    respostas.set(digitos(num(23)), { exists: true });
    contatoId = await contatoDe(TEAM_A, num(23));
    expect(await decidir(TEAM_A, contatoId)).toBe(SIM);
    expect(chamadas[0]!.url).toContain(boa.instance);
  });

  it("teto diário atingido (o mesmo contador das campanhas): adia para o próximo dia, sem consultar", async () => {
    process.env.WA_CHECAGEM_DIA = "1";
    await conta(TEAM_A);
    respostas.set(digitos(num(24)), { exists: true });
    const primeiro = await contatoDe(TEAM_A, num(24));
    const segundo = await contatoDe(TEAM_A, num(25));
    expect(await decidir(TEAM_A, primeiro)).toBe(SIM);
    const r = await rodar(TEAM_A, segundo, VERIFICAR);
    expect(r).toMatchObject({ nextNodeId: "cond", deferred: true, motivo: MOTIVO_TETO_DO_DIA });
    expect(r.delayMs!).toBeGreaterThanOrEqual(60_000);
    expect(chamadas).toHaveLength(1);
  });

  it("o teto é compartilhado: consultas já feitas pelas campanhas (mesma chave do Redis) contam", async () => {
    process.env.WA_CHECAGEM_DIA = "5";
    const a = await conta(TEAM_A);
    await redisEstado().set(`wa:checagem:${a.id}:${new Date().toISOString().slice(0, 10)}`, "5", "PX", 60_000);
    contatoId = await contatoDe(TEAM_A, num(26));
    const r = await rodar(TEAM_A, contatoId, VERIFICAR);
    expect(r).toMatchObject({ deferred: true, motivo: MOTIVO_TETO_DO_DIA });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fora do horário de envio do fluxo: adia até a abertura (e cadastro/cache seguem respondendo na hora)", async () => {
    await conta(TEAM_A);
    const SABADO_2H = new Date("2026-09-26T02:00:00-03:00");
    const propria = { modo: "propria", abertura: "09:00", fechamento: "17:00", dias: ["mon", "tue", "wed", "thu", "fri"], feriados: true };
    process.env.FLOW_JANELA_ENVIO = "on";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SABADO_2H);
    try {
      contatoId = await contatoDe(TEAM_A, num(27));
      const r = await rodar(TEAM_A, contatoId, VERIFICAR, { janelaEnvio: propria });
      expect(r).toMatchObject({ nextNodeId: "cond", deferred: true, motivo: MOTIVO_FORA_DO_HORARIO });
      expect(r.delayMs!).toBeGreaterThan(50 * 3600_000);
      expect(fetchMock).not.toHaveBeenCalled();
      // Sem número: a resposta é "não" na hora, não precisa de horário.
      const sem = await contatoDe(TEAM_A);
      expect((await rodar(TEAM_A, sem, VERIFICAR, { janelaEnvio: propria })).nextNodeId).toBe(NAO);
    } finally {
      vi.useRealTimers();
      process.env.FLOW_JANELA_ENVIO = "off";
    }
  });
});

describe("conferir: ritmo entre consultas da conta (fila com vaga marcada)", () => {
  const t0 = new Date("2026-10-22T15:00:00Z");
  const em = (ms: number) => new Date(t0.getTime() + ms);

  it("a 1ª consulta vai na hora; as seguintes recebem vagas a cada 2 s e esperam UMA vez, sem entrar no fim da fila de novo", async () => {
    const a = await conta(TEAM_A);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      respostas.set(digitos(num(30 + i)), { exists: true });
      ids.push(await contatoDe(TEAM_A, num(30 + i)));
    }
    const r1 = await conferir(TEAM_A, ids[0]!, { enrollmentId: "e1", agora: t0 });
    const r2 = await conferir(TEAM_A, ids[1]!, { enrollmentId: "e2", agora: t0 });
    const r3 = await conferir(TEAM_A, ids[2]!, { enrollmentId: "e3", agora: t0 });
    expect(r1).toEqual({ resposta: true, origem: "consulta" });
    expect(r2).toEqual({ adiar: { delayMs: 2000, motivo: MOTIVO_RITMO } });
    expect(r3).toEqual({ adiar: { delayMs: 4000, motivo: MOTIVO_RITMO } });
    expect(chamadas).toHaveLength(1);

    // Voltar antes da hora marcada não troca de lugar: falta só o que falta.
    expect(await conferir(TEAM_A, ids[2]!, { enrollmentId: "e3", agora: em(1500) })).toEqual({ adiar: { delayMs: 2500, motivo: MOTIVO_RITMO } });

    // Na hora da vaga, consulta (resgata a vaga) e cada consulta gastou UMA unidade do teto, não uma por volta.
    expect(await conferir(TEAM_A, ids[1]!, { enrollmentId: "e2", agora: em(2000) })).toEqual({ resposta: true, origem: "consulta" });
    expect(await conferir(TEAM_A, ids[2]!, { enrollmentId: "e3", agora: em(4000) })).toEqual({ resposta: true, origem: "consulta" });
    expect(chamadas).toHaveLength(3);
    const hoje = t0.toISOString().slice(0, 10);
    expect(Number(await redisEstado().get(`wa:checagem:${a.id}:${hoje}`))).toBe(3);
  });

  it("vaga resgatada muito depois da hora (worker parado, conta caída) é descartada: o passo volta ao fim da fila, sem pagar o teto de novo", async () => {
    const a = await conta(TEAM_A);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      respostas.set(digitos(num(70 + i)), { exists: true });
      ids.push(await contatoDe(TEAM_A, num(70 + i)));
    }
    expect(await conferir(TEAM_A, ids[0]!, { enrollmentId: "v1", agora: t0 })).toMatchObject({ origem: "consulta" });
    expect(await conferir(TEAM_A, ids[1]!, { enrollmentId: "v2", agora: t0 })).toEqual({ adiar: { delayMs: 2000, motivo: MOTIVO_RITMO } });
    expect(await conferir(TEAM_A, ids[2]!, { enrollmentId: "v3", agora: t0 })).toEqual({ adiar: { delayMs: 4000, motivo: MOTIVO_RITMO } });

    // 10 min depois todos voltam juntos (o worker ficou parado). Não consultam todos ao mesmo tempo: refazem a fila.
    const depois = em(10 * 60_000);
    expect(await conferir(TEAM_A, ids[2]!, { enrollmentId: "v3", agora: depois })).toMatchObject({ origem: "consulta" });
    expect(await conferir(TEAM_A, ids[1]!, { enrollmentId: "v2", agora: depois })).toEqual({ adiar: { delayMs: 2000, motivo: MOTIVO_RITMO } });
    // A unidade do teto já tinha sido paga quando a vaga foi marcada: 3 contatos, 3 unidades (não 4 nem 5).
    const hoje = t0.toISOString().slice(0, 10);
    expect(Number(await redisEstado().get(`wa:checagem:${a.id}:${hoje}`))).toBe(3);
  });

  it("contas diferentes têm filas separadas (o ritmo é por conta)", async () => {
    await conta(TEAM_A);
    await conta(TEAM_B);
    respostas.set(digitos(num(40)), { exists: true });
    respostas.set(digitos(num(41)), { exists: true });
    const a = await contatoDe(TEAM_A, num(40));
    const b = await contatoDe(TEAM_B, num(41));
    expect((await conferir(TEAM_A, a, { agora: t0 })) as object).toMatchObject({ origem: "consulta" });
    expect((await conferir(TEAM_B, b, { agora: t0 })) as object).toMatchObject({ origem: "consulta" });
  });

  it("o intervalo é sorteado entre o mínimo e o máximo do env (padrão 3 a 6 s)", async () => {
    delete process.env.WA_CONFERIR_RITMO_MIN_S;
    delete process.env.WA_CONFERIR_RITMO_MAX_S;
    await conta(TEAM_A);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      respostas.set(digitos(num(50 + i)), { exists: true });
      ids.push(await contatoDe(TEAM_A, num(50 + i)));
    }
    await conferir(TEAM_A, ids[0]!, { enrollmentId: "s1", agora: t0 });
    const r = (await conferir(TEAM_A, ids[1]!, { enrollmentId: "s2", agora: t0 })) as { adiar: { delayMs: number } };
    expect(r.adiar.delayMs).toBeGreaterThanOrEqual(3000);
    expect(r.adiar.delayMs).toBeLessThanOrEqual(6000);
  });
});

describe("conferir: Evolution fora, lenta ou resposta ilegível", () => {
  it("Evolution fora (5xx): lança ConsultaWhatsAppIndisponivel e devolve a unidade do teto; nada vai para o cache", async () => {
    modoDaEvolution = "erro";
    const a = await conta(TEAM_A);
    contatoId = await contatoDe(TEAM_A, num(60));
    await expect(conferir(TEAM_A, contatoId)).rejects.toBeInstanceOf(ConsultaWhatsAppIndisponivel);
    expect(await noCache(num(60))).toBeNull();
    const hoje = new Date().toISOString().slice(0, 10);
    expect(Number((await redisEstado().get(`wa:checagem:${a.id}:${hoje}`)) ?? 0)).toBe(0);
  });

  it("resposta sem o número (lista vazia): também não é 'não', é 'não deu para saber'", async () => {
    modoDaEvolution = "vazio";
    await conta(TEAM_A);
    contatoId = await contatoDe(TEAM_A, num(61));
    await expect(conferir(TEAM_A, contatoId)).rejects.toThrow(/não dá para ler/);
    expect(await noCache(num(61))).toBeNull();
  });

  it("devolver ao teto não cria chave negativa quando a unidade foi paga em outro dia", async () => {
    const { devolverAoTeto } = await import("../campaigns/tem-whatsapp");
    const a = await conta(TEAM_A);
    const hoje = new Date().toISOString().slice(0, 10);
    await devolverAoTeto(a.id, 1, new Date());
    expect(await redisEstado().get(`wa:checagem:${a.id}:${hoje}`)).toBeNull();
  });

  it("pelo executor o erro sobe para o motor decidir (repetir ou segurar); o ramo não é escolhido", async () => {
    modoDaEvolution = "erro";
    await conta(TEAM_A);
    contatoId = await contatoDe(TEAM_A, num(62));
    await expect(rodar(TEAM_A, contatoId, VERIFICAR)).rejects.toBeInstanceOf(ConsultaWhatsAppIndisponivel);
  });
});

describe("custo do passo na ficha do time", () => {
  const comRamo = (condition: object) => ({ tipo: "condition", branches: { branches: [{ condition }], default: null } });

  it("'Tem WhatsApp' conferido no WhatsApp custa 1 ficha; no cadastro (com ou sem `modo`) segue leve", () => {
    expect(custoDoPasso(comRamo({ type: "has_whatsapp", modo: "verificar" }))).toBe(1);
    expect(custoDoPasso(comRamo({ type: "has_whatsapp", modo: "cadastro" }))).toBe(CUSTO_PASSO_LEVE);
    expect(custoDoPasso(comRamo({ type: "has_whatsapp" }))).toBe(CUSTO_PASSO_LEVE);
    expect(custoDoPasso({ tipo: "condition", branches: { branches: [{ condition: { type: "has_email" } }, { condition: { type: "has_whatsapp", modo: "verificar" } }] } })).toBe(1);
    // Com a consulta desligada (FLOW_CONFERIR_WHATSAPP=off) o passo só lê o cadastro e volta a custar pouco.
    process.env.FLOW_CONFERIR_WHATSAPP = "off";
    try {
      expect(custoDoPasso(comRamo({ type: "has_whatsapp", modo: "verificar" }))).toBe(CUSTO_PASSO_LEVE);
    } finally {
      delete process.env.FLOW_CONFERIR_WHATSAPP;
    }
  });
});
