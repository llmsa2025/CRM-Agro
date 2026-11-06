import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { basePrisma, db, runAsSystem } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { listaDoDia, type ItemDia } from "./service";
import { markTaskDone, undoTaskDone, ChaveDeTarefaInvalida, diaNoFuso } from "./tarefas-feitas";
import { ForbiddenError } from "../auth/authz";
import { limparTarefasFeitasAntigas, executarRetencao, _reiniciarRetencaoGeral } from "../retencao/service";
import { MODULOS_COM_DONO } from "../auth/modulos";

/**
 * Tarefas do dia com estado "feita" (produto §F). A marca é por usuário e por
 * dia (fuso do time): some da lista hoje, volta amanhã se a condição persistir,
 * não vaza entre times nem entre colegas do mesmo time.
 */

const TEAM = "00000000-0000-0000-0000-0000000007a1";
const OUTRO = "00000000-0000-0000-0000-0000000007a2";
const TZ = "America/Sao_Paulo";
const DIA = 86_400_000;

// Usuários REAIS (DailyTaskState.userId é FK de User).
const ANA_USER = "00000000-0000-0000-0000-00000007a1a1";
const BETO_USER = "00000000-0000-0000-0000-00000007a1b2";
const OUTRO_USER = "00000000-0000-0000-0000-00000007a2c3";

// "Ver tudo" em todas as telas (F3): o cenário é do time todo; aqui se testa o
// estado "feita" por pessoa, não o escopo por dono (coberto em tenancy/escopo-leituras.test.ts).
const TUDO = { verTudoEm: [...MODULOS_COM_DONO] };
const comoAna = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: ANA_USER, role: "member", ...TUDO });
const comoBeto = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: BETO_USER, role: "member", ...TUDO });
const comoOutro = <T>(fn: () => Promise<T>) => runWithTeam(OUTRO, fn, { userId: OUTRO_USER, role: "member", ...TUDO });

const ids = (itens: ItemDia[]) => itens.map((i) => `${i.kind}:${i.id}`).sort();

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team Tarefas (test G)"], [OUTRO, "Team Tarefas B (test G)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  for (const [id, teamId, email] of [
    [ANA_USER, TEAM, "g-tarefas-ana@teste.local"],
    [BETO_USER, TEAM, "g-tarefas-beto@teste.local"],
    [OUTRO_USER, OUTRO, "g-tarefas-outro@teste.local"],
  ] as const) {
    await basePrisma.user.upsert({ where: { id }, update: {}, create: { id, teamId, email, name: email, role: "member" } });
  }
});

beforeEach(async () => {
  for (const teamId of [TEAM, OUTRO]) {
    const w = { where: { teamId } };
    await basePrisma.dailyTaskState.deleteMany(w);
    await basePrisma.enrollment.deleteMany(w);
    await basePrisma.flow.deleteMany(w);
    await basePrisma.deal.deleteMany(w);
    await basePrisma.funnel.deleteMany(w);
    await basePrisma.activity.deleteMany(w);
    await basePrisma.contact.deleteMany(w);
  }
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lead novo sem toque + deal parado há 10 dias + follow-up vencido, no time `teamId`. */
async function cenario(teamId: string) {
  const lead = await basePrisma.contact.create({ data: { teamId, nome: "Ana Lead" } });
  const dono = await basePrisma.contact.create({ data: { teamId, nome: "Bruno Deal", relacionamentoStatus: "ja_conversou" } });
  const funil = await basePrisma.funnel.create({ data: { teamId, nome: "Vendas", tipo: "vendas" } });
  const etapa = await basePrisma.stage.create({ data: { teamId, funnelId: funil.id, nome: "Proposta", ordem: 1 } });
  const deal = await basePrisma.deal.create({
    data: { teamId, funnelId: funil.id, stageId: etapa.id, contactId: dono.id, enteredStageAt: new Date(Date.now() - 10 * DIA) },
  });
  const fluxo = await basePrisma.flow.create({ data: { teamId, nome: "Cadência", triggerType: "manual", status: "active" } });
  const insc = await basePrisma.enrollment.create({
    data: { teamId, flowId: fluxo.id, contactId: dono.id, currentNodeId: "n1", status: "active", nextRunAt: new Date(Date.now() - 3_600_000) },
  });
  return { lead, deal, insc };
}

describe("tarefas do dia com estado feita (produto §F)", () => {
  it("marcada some das pendentes e aparece em feitas; desfazer devolve", async () => {
    const { lead, deal, insc } = await cenario(TEAM);

    const antes = await comoAna(() => listaDoDia({ userId: ANA_USER }));
    expect(ids(antes.pendentes)).toEqual(
      [`deal_parado:${deal.id}`, `lead_sem_toque:${lead.id}`, `followup_vencido:${insc.id}`].sort(),
    );
    expect(antes.feitas).toEqual([]);

    const itemLead = antes.pendentes.find((i) => i.kind === "lead_sem_toque")!;
    expect(itemLead.chave).toBe(`lead_sem_toque:${lead.id}:${diaNoFuso(TZ)}`);
    const itemDeal = antes.pendentes.find((i) => i.kind === "deal_parado")!;

    const r = await comoAna(() => markTaskDone(itemLead.chave));
    expect(r.chave).toBe(itemLead.chave);
    await comoAna(() => markTaskDone(itemDeal.chave));

    const depois = await comoAna(() => listaDoDia({ userId: ANA_USER }));
    expect(ids(depois.pendentes)).toEqual([`followup_vencido:${insc.id}`]);
    expect(ids(depois.feitas)).toEqual([`deal_parado:${deal.id}`, `lead_sem_toque:${lead.id}`].sort());

    // Formato antigo (array) também esconde as feitas do usuário do contexto.
    expect(ids(await comoAna(() => listaDoDia()))).toEqual([`followup_vencido:${insc.id}`]);

    expect(await comoAna(() => undoTaskDone(itemLead.chave))).toEqual({ desfeita: true });
    expect(await comoAna(() => undoTaskDone(itemLead.chave))).toEqual({ desfeita: false });
    const desfeito = await comoAna(() => listaDoDia({ userId: ANA_USER }));
    expect(ids(desfeito.feitas)).toEqual([`deal_parado:${deal.id}`]);
    expect(ids(desfeito.pendentes)).toContain(`lead_sem_toque:${lead.id}`);
  });

  it("marcar duas vezes é idempotente (uma linha, feitoEm da 1ª vez)", async () => {
    const { lead } = await cenario(TEAM);
    const chave = `lead_sem_toque:${lead.id}:${diaNoFuso(TZ)}`;
    const [a, b] = await Promise.all([comoAna(() => markTaskDone(chave)), comoAna(() => markTaskDone(chave))]);
    const c = await comoAna(() => markTaskDone(chave));
    expect(a.feitoEm.getTime()).toBe(b.feitoEm.getTime());
    expect(c.feitoEm.getTime()).toBe(a.feitoEm.getTime());
    expect(await basePrisma.dailyTaskState.count({ where: { teamId: TEAM } })).toBe(1);
  });

  it("no dia seguinte a tarefa volta se a condição persistir; se não persistir, some das duas listas", async () => {
    const { lead, deal } = await cenario(TEAM);
    const hoje = await comoAna(() => listaDoDia({ userId: ANA_USER }));
    for (const i of hoje.pendentes) if (i.kind !== "followup_vencido") await comoAna(() => markTaskDone(i.chave));

    // Só o relógio (Date) anda: Prisma e timers seguem reais.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + DIA));
    const amanha = await comoAna(() => listaDoDia({ userId: ANA_USER }));
    expect(amanha.feitas).toEqual([]);
    expect(ids(amanha.pendentes)).toEqual(expect.arrayContaining([`deal_parado:${deal.id}`, `lead_sem_toque:${lead.id}`]));
    vi.useRealTimers();

    // Hoje, com a condição resolvida (o lead recebeu o 1º toque), a feita some das duas listas.
    await basePrisma.activity.create({ data: { teamId: TEAM, contactId: lead.id, tipo: "whatsapp", direcao: "out", conteudo: "oi" } });
    const resolvido = await comoAna(() => listaDoDia({ userId: ANA_USER }));
    expect(ids(resolvido.feitas)).toEqual([`deal_parado:${deal.id}`]);
    expect(ids(resolvido.pendentes)).not.toContain(`lead_sem_toque:${lead.id}`);
  });

  it("um usuário não vê as feitas do outro (e não pede a lista de outro)", async () => {
    const { lead } = await cenario(TEAM);
    const chave = `lead_sem_toque:${lead.id}:${diaNoFuso(TZ)}`;
    await comoAna(() => markTaskDone(chave));

    const doBeto = await comoBeto(() => listaDoDia({ userId: BETO_USER }));
    expect(doBeto.feitas).toEqual([]);
    expect(ids(doBeto.pendentes)).toContain(`lead_sem_toque:${lead.id}`);
    await expect(comoBeto(() => listaDoDia({ userId: ANA_USER }))).rejects.toBeInstanceOf(ForbiddenError);

    // Desfazer do Beto não mexe na marca da Ana.
    expect(await comoBeto(() => undoTaskDone(chave))).toEqual({ desfeita: false });
    expect(ids((await comoAna(() => listaDoDia({ userId: ANA_USER }))).feitas)).toEqual([`lead_sem_toque:${lead.id}`]);
  });

  it("dois times: marca de um time não esconde nem vaza para o outro", async () => {
    const a = await cenario(TEAM);
    const b = await cenario(OUTRO);
    // O outro time tenta marcar uma chave com id do time A: fica só na lista DELE.
    await comoOutro(() => markTaskDone(`lead_sem_toque:${a.lead.id}:${diaNoFuso(TZ)}`));
    await comoAna(() => markTaskDone(`lead_sem_toque:${a.lead.id}:${diaNoFuso(TZ)}`));

    const listaB = await comoOutro(() => listaDoDia({ userId: OUTRO_USER }));
    expect(listaB.feitas).toEqual([]);
    expect(ids(listaB.pendentes)).toEqual(
      [`deal_parado:${b.deal.id}`, `lead_sem_toque:${b.lead.id}`, `followup_vencido:${b.insc.id}`].sort(),
    );
    const listaA = await comoAna(() => listaDoDia({ userId: ANA_USER }));
    expect(ids(listaA.feitas)).toEqual([`lead_sem_toque:${a.lead.id}`]);
    expect(listaA.pendentes.every((i) => i.id !== b.lead.id && i.id !== b.deal.id)).toBe(true);

    // Leitura pelo client tenant: cada time só enxerga as próprias marcas.
    const marcasB = await comoOutro(async () => db().dailyTaskState.findMany({ select: { userId: true } }));
    expect(marcasB).toEqual([{ userId: OUTRO_USER }]);
  });

  it("RBAC: viewer não marca; o sistema não marca; chave malformada é recusada", async () => {
    const { lead } = await cenario(TEAM);
    const chave = `lead_sem_toque:${lead.id}:${diaNoFuso(TZ)}`;
    await expect(runWithTeam(TEAM, () => markTaskDone(chave), { userId: ANA_USER, role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runWithTeam(TEAM, () => undoTaskDone(chave), { userId: ANA_USER, role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runAsSystem(TEAM, () => markTaskDone(chave))).rejects.toBeInstanceOf(ForbiddenError);
    for (const ruim of ["", "outro:abc:2026-09-27", `lead_sem_toque:${lead.id}`, `lead_sem_toque:a:b:2026-09-27`, `lead_sem_toque:${"x".repeat(65)}:2026-09-27`]) {
      await expect(comoAna(() => markTaskDone(ruim))).rejects.toBeInstanceOf(ChaveDeTarefaInvalida);
    }
    expect(await basePrisma.dailyTaskState.count({ where: { teamId: TEAM } })).toBe(0);
  });
});

describe("retenção das marcas de tarefa feita (> 30 dias)", () => {
  it("apaga só as marcas com mais de 30 dias, só do time pedido", async () => {
    const mk = (teamId: string, userId: string, chave: string, dias: number) =>
      basePrisma.dailyTaskState.create({ data: { teamId, userId, chave, feitoEm: new Date(Date.now() - dias * DIA) } });
    await mk(TEAM, ANA_USER, "lead_sem_toque:velha:2026-08-01", 31);
    await mk(TEAM, BETO_USER, "lead_sem_toque:velha2:2026-08-01", 45);
    const recente = await mk(TEAM, ANA_USER, "lead_sem_toque:recente:2026-09-20", 5);
    const deOutro = await mk(OUTRO, OUTRO_USER, "lead_sem_toque:velha:2026-08-01", 60);

    expect((await limparTarefasFeitasAntigas({ teamId: TEAM, lote: 1 })).apagados).toBe(2);
    const ficaram = await basePrisma.dailyTaskState.findMany({ where: { teamId: { in: [TEAM, OUTRO] } }, select: { id: true } });
    expect(ficaram.map((f) => f.id).sort()).toEqual([recente.id, deOutro.id].sort());
  });

  it("entra no job geral diário", async () => {
    _reiniciarRetencaoGeral();
    await basePrisma.dailyTaskState.create({
      data: { teamId: TEAM, userId: ANA_USER, chave: "deal_parado:x:2026-08-01", feitoEm: new Date(Date.now() - 40 * DIA) },
    });
    const r = await executarRetencao({ teamId: TEAM });
    expect(r.geral?.tarefasFeitas).toBe(1);
    _reiniciarRetencaoGeral();
  });
});
