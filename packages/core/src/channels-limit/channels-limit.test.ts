import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import {
  effectiveDailyLimit,
  consumeSendQuota,
  getAccountRateStatus,
  setAccountPaused,
  checkAndMaybePauseAccount,
} from "./index";

const TEAM = "00000000-0000-0000-0000-0000000000e5";
let accountId: string;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team RL" } });
});

beforeEach(async () => {
  await basePrisma.channelAccountUsage.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.message.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.conversation.deleteMany({ where: { teamId: TEAM } });
  await basePrisma.channelAccount.deleteMany({ where: { teamId: TEAM } });
  const acc = await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", status: "connected" },
  });
  accountId = acc.id;
});

describe("effectiveDailyLimit — warmup", () => {
  it("rampa por idade e override manual", () => {
    const now = new Date("2026-07-27T12:00:00Z");
    const base = { id: "x", dailyLimit: null, warmupStartedAt: null, paused: false };
    expect(effectiveDailyLimit({ ...base, createdAt: now }, now)).toBe(20); // dia 0
    expect(effectiveDailyLimit({ ...base, createdAt: new Date(now.getTime() - 5 * 86400000) }, now)).toBe(50);
    expect(effectiveDailyLimit({ ...base, createdAt: new Date(now.getTime() - 10 * 86400000) }, now)).toBe(100);
    expect(effectiveDailyLimit({ ...base, createdAt: new Date(now.getTime() - 40 * 86400000) }, now)).toBe(400);
    // override manual vence a rampa
    expect(effectiveDailyLimit({ ...base, dailyLimit: 7, createdAt: now }, now)).toBe(7);
  });
});

describe("consumeSendQuota — teto e adiamento", () => {
  it("libera até o teto e depois adia (daily_cap)", async () => {
    await runWithTeam(TEAM, async () => {
      // fixa teto baixo p/ o teste
      await basePrisma.channelAccount.update({ where: { id: accountId }, data: { dailyLimit: 3 } });
      for (let i = 0; i < 3; i++) {
        const r = await consumeSendQuota(accountId);
        expect(r.allowed).toBe(true);
      }
      const capped = await consumeSendQuota(accountId);
      expect(capped.allowed).toBe(false);
      if (!capped.allowed) {
        expect(capped.reason).toBe("daily_cap");
        expect(capped.retryAfterMs).toBeGreaterThan(0);
      }
      const status = await getAccountRateStatus(accountId);
      expect(status?.sent).toBe(3);
      expect(status?.remaining).toBe(0);
    });
  });

  it("limite de quem envia (campanha) substitui o teto da conta, para mais ou para menos", async () => {
    await runWithTeam(TEAM, async () => {
      await basePrisma.channelAccount.update({ where: { id: accountId }, data: { dailyLimit: 2 } });
      for (let i = 0; i < 4; i++) expect((await consumeSendQuota(accountId, new Date(), { limite: 4 })).allowed).toBe(true);
      expect((await consumeSendQuota(accountId, new Date(), { limite: 4 })).allowed).toBe(false);
      // Sem o limite, volta o teto da conta (2), já passado hoje.
      expect((await consumeSendQuota(accountId)).allowed).toBe(false);
    });
  });

  it("conta pausada adia com reason=paused", async () => {
    await runWithTeam(TEAM, async () => {
      await setAccountPaused(accountId, true);
      const r = await consumeSendQuota(accountId);
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toBe("paused");
    });
  });
});

describe("checkAndMaybePauseAccount — monitor de saúde", () => {
  it("pausa a conta quando a taxa de erro recente passa do limiar", async () => {
    await runWithTeam(TEAM, async () => {
      const conv = await basePrisma.conversation.create({
        data: { teamId: TEAM, canal: "whatsapp", channelAccountId: accountId, status: "open" },
      });
      // 10 mensagens de saída, 5 com erro (50% > 30%)
      for (let i = 0; i < 10; i++) {
        await basePrisma.message.create({
          data: {
            teamId: TEAM,
            conversationId: conv.id,
            direcao: "out",
            tipo: "text",
            conteudo: `m${i}`,
            status: i < 5 ? "failed" : "sent",
          },
        });
      }
      const pausou = await checkAndMaybePauseAccount(accountId);
      expect(pausou).toBe(true);
      const acc = await basePrisma.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
      expect(acc.paused).toBe(true);
    });
  });

  it("não pausa com volume baixo", async () => {
    await runWithTeam(TEAM, async () => {
      const conv = await basePrisma.conversation.create({
        data: { teamId: TEAM, canal: "whatsapp", channelAccountId: accountId, status: "open" },
      });
      await basePrisma.message.create({
        data: { teamId: TEAM, conversationId: conv.id, direcao: "out", tipo: "text", status: "failed" },
      });
      expect(await checkAndMaybePauseAccount(accountId)).toBe(false);
    });
  });
});
