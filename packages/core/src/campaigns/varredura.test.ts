import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";

/**
 * Auditoria do #125: campanha "enviando" cujo tick esgotou as tentativas ficava
 * parada para sempre. Fila mockada; nada é enviado.
 */
const fila = vi.hoisted(() => ({ agendados: [] as Array<Record<string, unknown>> }));
vi.mock("./queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue")>()),
  agendarTick: async (j: Record<string, unknown>) => void fila.agendados.push(j),
}));

const { varrerCampanhasParadas, MOTIVO_PARADA_REPETIDA } = await import("./varredura");
const { processarTickDaCampanha } = await import("./tick");
const { runAsSystem } = await import("@crmagro/db");
const { redisEstado } = await import("../shared/redis-cache");

const TEAM = "00000000-0000-0000-0000-0000000000d7";
const token = `tk-${Math.random().toString(36).slice(2, 8)}`;
let campanhaId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team Varredura Campanha (test)" } });
});

beforeEach(async () => {
  fila.agendados.length = 0;
  await basePrisma.campaign.deleteMany({ where: { teamId: TEAM } });
  const c = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "Safra", status: "sending", tickToken: token } });
  campanhaId = c.id;
  await redisEstado().del(`campanha:rearme:${c.id}`);
});

const filaCom = (jobs: Array<{ data: Record<string, unknown> }>) => ({ getJobs: async () => jobs as never });
const soDestaCampanha = () => fila.agendados.filter((j) => j.campaignId === campanhaId);

describe("campanha parada", () => {
  it("com tick vivo da corrente atual: não mexe", async () => {
    await varrerCampanhasParadas({ fila: filaCom([{ data: { kind: "tick", campaignId: campanhaId, token } }]) });
    expect(soDestaCampanha()).toHaveLength(0);
  });

  it("sem tick vivo (tentativas esgotadas): rearma com uma corrente NOVA (token girado, seq 0)", async () => {
    await varrerCampanhasParadas({ fila: filaCom([{ data: { kind: "tick", campaignId: campanhaId, token: "token-velho" } }]) });
    const { tickToken } = await basePrisma.campaign.findUniqueOrThrow({ where: { id: campanhaId } });
    expect(tickToken).not.toBe(token);
    expect(soDestaCampanha()).toEqual([expect.objectContaining({ campaignId: campanhaId, token: tickToken, seq: 0, teamId: TEAM, delayMs: 0 })]);
  });

  it("varredura no meio de um início: o tick do token velho que chega depois morre — só UMA corrente segue", async () => {
    // "Meio do start": a campanha já está sending com o token T, e o seq 0 de T
    // ainda não entrou na fila. A varredura rearma; logo depois chega o seq 0 de T.
    await varrerCampanhasParadas({ fila: filaCom([]) });
    expect(soDestaCampanha()).toHaveLength(1);
    const desfecho = await runAsSystem(TEAM, () =>
      processarTickDaCampanha({ kind: "tick", teamId: TEAM, campaignId: campanhaId, token, seq: 0 }),
    );
    expect(desfecho).toBe("corrente_morta");
    expect(soDestaCampanha()).toHaveLength(1); // a corrente velha não se reagendou
  });

  it("pausa ou retomada no meio (token mudou): não rearma", async () => {
    const filaQueMuda = {
      getJobs: async () => {
        await basePrisma.campaign.update({ where: { id: campanhaId }, data: { status: "paused", tickToken: null } });
        return [] as never;
      },
    };
    await varrerCampanhasParadas({ fila: filaQueMuda });
    expect(soDestaCampanha()).toHaveLength(0);
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: campanhaId } })).toMatchObject({ status: "paused", tickToken: null });
  });

  it("agendada cujo 1º tick esgotou as tentativas: também é rearmada", async () => {
    await basePrisma.campaign.update({ where: { id: campanhaId }, data: { status: "scheduled" } });
    await varrerCampanhasParadas({ fila: filaCom([]) });
    expect(soDestaCampanha()).toEqual([expect.objectContaining({ seq: 0 })]);
  });

  it("parada de novo mais de 3× em 1 h: pausa com motivo visível em vez de girar em falha", async () => {
    for (let i = 0; i < 3; i++) await varrerCampanhasParadas({ fila: filaCom([]) });
    expect(soDestaCampanha()).toHaveLength(3);
    await varrerCampanhasParadas({ fila: filaCom([]) });
    expect(await basePrisma.campaign.findUniqueOrThrow({ where: { id: campanhaId } })).toMatchObject({
      status: "paused",
      pausadoMotivo: MOTIVO_PARADA_REPETIDA,
      tickToken: null,
    });
  });
});
