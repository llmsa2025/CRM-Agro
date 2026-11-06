import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * Auditoria de isolamento 09/2026 — S-03 (alto), padrão "dois times": a
 * mensagem de WhatsApp de uma instância SEM ChannelAccount (o número novo do
 * time B, entre o QR lido e o "confirmar") não pode cair no inbox do time A.
 *
 * A versão antiga caía na ÚNICA conta WhatsApp conectada do SISTEMA. Na base de
 * teste compartilhada há várias contas conectadas, então o teste simula a base
 * de produção de hoje ("o A é a única conta conectada") embrulhando o
 * `basePrisma` só DESTE arquivo: `channelAccount.findMany` devolve só a conta do
 * A enquanto `simular.ativo`. Nada é mutado no client compartilhado (um
 * `vi.spyOn` no delegate do Prisma quebrava os arquivos seguintes).
 * Relatório: a documentação interna.
 */
const simular = vi.hoisted(() => ({ ativo: false, contas: [] as Array<{ id: string; teamId: string }> }));
vi.mock("@crmagro/db", async (original) => {
  const m = await original<typeof import("@crmagro/db")>();
  const real = m.basePrisma;
  const channelAccount = new Proxy(real.channelAccount, {
    get(alvo, chave) {
      if (chave === "findMany" && simular.ativo) return async () => simular.contas;
      const v = Reflect.get(alvo, chave);
      return typeof v === "function" ? v.bind(alvo) : v;
    },
  });
  const basePrisma = new Proxy(real, {
    get(alvo, chave) {
      if (chave === "channelAccount") return channelAccount;
      const v = Reflect.get(alvo, chave);
      return typeof v === "function" ? v.bind(alvo) : v;
    },
  });
  return { ...m, basePrisma };
});

const { basePrisma } = await import("@crmagro/db");
const { receiveInbound, resolveInboundAccount } = await import("../conversations/service");

const TEAM_A = "00000000-0000-0000-0000-00000005ec3a";
const TEAM_B = "00000000-0000-0000-0000-00000005ec3b";
const sufixo = Math.random().toString(36).slice(2, 7);
const INST_A = `seg-s03-a-${sufixo}`;
const INST_B = `seg-s03-b-pendente-${sufixo}`; // criada no onboarding, ainda sem ChannelAccount
const NUMERO = "+5566988887777";

async function limpar() {
  for (const teamId of [TEAM_A, TEAM_B]) {
    await basePrisma.message.deleteMany({ where: { teamId } });
    await basePrisma.conversation.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  }
}

let contaA: { id: string; teamId: string };

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Seg S-03 A (test)"],
    [TEAM_B, "Seg S-03 B (test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar();
  const c = await basePrisma.channelAccount.create({
    data: { teamId: TEAM_A, canal: "whatsapp", label: "WA do A", provider: "evolution", externalId: INST_A, status: "connected" },
  });
  contaA = { id: c.id, teamId: c.teamId };
});

afterAll(async () => {
  simular.ativo = false;
  await limpar();
});

describe("WhatsApp — mensagem de instância sem conta não cai em outro time (S-03, corrigido)", () => {
  it("número novo do time B (QR lido, conta ainda não confirmada) não entra no inbox do A — com o A sendo a ÚNICA conta conectada", async () => {
    simular.contas = [contaA];
    simular.ativo = true;
    const pid = `S03-${sufixo}`;
    try {
      // A simulação vale: o sistema "tem" só a conta do A conectada.
      expect(await basePrisma.channelAccount.findMany({ where: { canal: "whatsapp", status: "connected" } })).toEqual([contaA]);
      expect(await resolveInboundAccount(INST_B)).toBeNull();
      expect(await resolveInboundAccount(null)).toBeNull();
      await receiveInbound({
        from: NUMERO, fromMe: false, text: "oi, sou cliente do B", media: null,
        providerMessageId: pid, timestamp: null, name: "Cliente do B", instance: INST_B,
      });
    } finally {
      simular.ativo = false;
    }
    // Descartada: nada gravado em time nenhum. A mensagem fica na Evolution e
    // entra pela importação do histórico quando o B confirmar a conta.
    expect(await basePrisma.message.count({ where: { providerMessageId: pid } })).toBe(0);
    expect(await basePrisma.conversation.count({ where: { externalNumber: NUMERO } })).toBe(0);
  });

  it("a instância do próprio time resolve para ele; conta desconectada não cai em outra", async () => {
    expect(await resolveInboundAccount(INST_A)).toEqual(contaA);
    await basePrisma.channelAccount.update({ where: { id: contaA.id }, data: { status: "disconnected" } });
    try {
      expect(await resolveInboundAccount(INST_A)).toBeNull();
    } finally {
      await basePrisma.channelAccount.update({ where: { id: contaA.id }, data: { status: "connected" } });
    }
  });
});
