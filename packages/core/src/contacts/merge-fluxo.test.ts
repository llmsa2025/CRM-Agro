import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma, runWithTeam as runWithTeamDb } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { mergeContacts } from "./service";

/**
 * Auditoria do #57: unificar contatos que estão no MESMO fluxo batia no índice
 * único `Enrollment_um_ativo` no meio do caminho e deixava a unificação pela
 * metade, para sempre. Nada é enviado.
 */
const TEAM = "00000000-0000-0000-0000-0000000000d1";
const OUTRO = "00000000-0000-0000-0000-0000000000d2";
const sufixo = Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Merge ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  for (const teamId of [TEAM, OUTRO]) {
    const w = { teamId };
    await basePrisma.flowStepExecution.deleteMany({ where: w });
    await basePrisma.enrollment.deleteMany({ where: w });
    await basePrisma.flow.deleteMany({ where: w });
    await basePrisma.activity.deleteMany({ where: w });
    await basePrisma.channelIdentifier.deleteMany({ where: w });
    // Convite e compromisso não caem em cascata com o contato (SetNull); empresa leva o vínculo junto.
    await basePrisma.appointmentAttendee.deleteMany({ where: w });
    await basePrisma.appointment.deleteMany({ where: w });
    await basePrisma.company.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w }); // a Call cai em cascata
  }
});

async function fluxo(teamId = TEAM) {
  return basePrisma.flow.create({ data: { teamId, nome: `F-${sufixo}-${Math.random()}`, triggerType: "manual", status: "active" } });
}
async function inscrever(teamId: string, flowId: string, contactId: string) {
  return basePrisma.enrollment.create({
    data: { teamId, flowId, contactId, currentNodeId: "n", currentRound: 1, status: "waiting", nextRunAt: new Date(), flowSnapshot: [] as never },
  });
}

describe("unificar contatos no mesmo fluxo", () => {
  it("mantido e duplicado ativos no MESMO fluxo: unifica inteiro, fica uma inscrição ativa (a do mantido)", async () => {
    const f = await fluxo();
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Ana" } });
    const dup = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Ana (dup)", empresa: "Fazenda X" } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: dup.id, canal: "whatsapp", valor: `+55659${sufixo.replace(/\D/g, "1").padEnd(8, "1").slice(0, 8)}` } });
    const eKeep = await inscrever(TEAM, f.id, keep.id);
    const eDup = await inscrever(TEAM, f.id, dup.id);

    await runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id]));

    expect(await basePrisma.contact.findUnique({ where: { id: dup.id } })).toBeNull();
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id: keep.id } })).empresa).toBe("Fazenda X");
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM, contactId: keep.id } })).toBe(1);
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: eKeep.id } })).toMatchObject({ status: "waiting", contactId: keep.id });
    // A do duplicado foi ENCERRADA (e segue o contato, para o histórico).
    expect(await basePrisma.enrollment.findUniqueOrThrow({ where: { id: eDup.id } })).toMatchObject({ status: "done", contactId: keep.id });
  });

  it("ramos paralelos do mesmo fluxo não são encerrados; os da inscrição encerrada vão junto", async () => {
    const f = await fluxo();
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Bia" } });
    const dup = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Bia (dup)" } });
    const eKeep = await inscrever(TEAM, f.id, keep.id);
    const ramoKeep = await basePrisma.enrollment.create({ data: { teamId: TEAM, flowId: f.id, contactId: keep.id, paiId: eKeep.id, currentNodeId: "r", currentRound: 1, status: "waiting", nextRunAt: new Date(), flowSnapshot: [] as never } });
    const eDup = await inscrever(TEAM, f.id, dup.id);
    const ramoDup = await basePrisma.enrollment.create({ data: { teamId: TEAM, flowId: f.id, contactId: dup.id, paiId: eDup.id, currentNodeId: "r", currentRound: 1, status: "waiting", nextRunAt: new Date(), flowSnapshot: [] as never } });

    await runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id]));

    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: eKeep.id } })).status).toBe("waiting");
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: ramoKeep.id } })).status).toBe("waiting"); // 2ª inscrição ativa do mantido no fluxo: é ramo, fica
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: eDup.id } })).status).toBe("done");
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: ramoDup.id } })).status).toBe("done"); // ramo da inscrição encerrada
  });

  it("dois duplicados no mesmo fluxo e o mantido fora dele: sobra uma inscrição ativa", async () => {
    const f = await fluxo();
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Bia" } });
    const d1 = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Bia 1" } });
    const d2 = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Bia 2" } });
    await inscrever(TEAM, f.id, d1.id);
    await inscrever(TEAM, f.id, d2.id);

    await runWithTeam(TEAM, () => mergeContacts(keep.id, [d1.id, d2.id]));

    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM, contactId: keep.id, status: { in: ["active", "waiting"] } } })).toBe(1);
    expect(await basePrisma.contact.count({ where: { id: { in: [d1.id, d2.id] } } })).toBe(0);
  });

  it("dois times: duplicado de outro time é recusado e nada muda", async () => {
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Caio" } });
    const alheio = await basePrisma.contact.create({ data: { teamId: OUTRO, nome: "Caio (outro time)" } });
    await expect(runWithTeamDb(TEAM, () => mergeContacts(keep.id, [alheio.id]), { userId: "u", role: "admin" })).rejects.toMatchObject({ name: "OwnedNotFound" });
    expect(await basePrisma.contact.findUnique({ where: { id: alheio.id } })).not.toBeNull();
  });
});

/**
 * F1A-01: a prova da ligação não pode sumir na unificação. Antes, o `deleteMany` final apagava a Call
 * do duplicado em cascata (com os ids do provedor) e a Activity movida ficava com `meta.callId` órfão.
 * Compromisso e convite (SetNull) perdiam o contato em silêncio. Nada é enviado nem ligado.
 */
describe("unificar contatos leva ligações, agenda e empresas", () => {
  const em = (dias: number) => new Date(Date.now() + dias * 86_400_000);

  async function empresa(teamId: string, nome: string) {
    return basePrisma.company.create({ data: { teamId, nome: `${nome} ${sufixo}` } });
  }
  /** Uma ligação já com a Activity que aponta para ela (o formato que `createCall` grava). */
  async function ligacao(teamId: string, contactId: string, providerCallId: string) {
    const call = await basePrisma.call.create({
      data: {
        teamId,
        contactId,
        phoneNumber: "+5565999990000",
        direction: "outbound",
        provider: "manual",
        providerCallId,
        status: "completed",
        durationSeconds: 42,
        recordingUrl: `https://exemplo.test/${providerCallId}.mp3`,
      },
    });
    await basePrisma.activity.create({
      data: { teamId, contactId, tipo: "call", direcao: "out", conteudo: "Ligação", meta: { callId: call.id, provider: "manual" } },
    });
    return call;
  }
  async function compromisso(teamId: string, contactId: string, titulo: string) {
    const a = await basePrisma.appointment.create({ data: { teamId, contactId, titulo, inicio: em(2) } });
    const convite = await basePrisma.appointmentAttendee.create({
      data: { teamId, appointmentId: a.id, contactId, email: `${titulo.toLowerCase().replace(/\W/g, "")}-${sufixo}@exemplo.test` },
    });
    return { a, convite };
  }
  /** Toda Activity de ligação do contato aponta para uma Call que existe e é dele. */
  async function callIdsOrfaos(teamId: string, contactId: string) {
    const atividades = await basePrisma.activity.findMany({ where: { teamId, contactId, tipo: "call" } });
    const orfaos: string[] = [];
    for (const at of atividades) {
      const callId = (at.meta as { callId?: string } | null)?.callId;
      const call = callId ? await basePrisma.call.findFirst({ where: { id: callId, teamId, contactId } }) : null;
      if (!call) orfaos.push(at.id);
    }
    return { total: atividades.length, orfaos };
  }
  async function retrato(teamId: string, contactId: string) {
    return {
      calls: (await basePrisma.call.findMany({ where: { teamId, contactId }, orderBy: { id: "asc" } })).map((c) => c.id),
      activities: await basePrisma.activity.count({ where: { teamId, contactId } }),
      compromissos: (await basePrisma.appointment.findMany({ where: { teamId, contactId }, orderBy: { id: "asc" } })).map((c) => c.id),
      convites: (await basePrisma.appointmentAttendee.findMany({ where: { teamId, contactId }, orderBy: { id: "asc" } })).map((c) => c.id),
      empresas: (await basePrisma.contactCompany.findMany({ where: { teamId, contactId }, orderBy: { id: "asc" } })).map((c) => `${c.companyId}:${c.papel}`),
    };
  }

  it("o duplicado tem 2 ligações, 1 compromisso, 1 convite e a mesma empresa do mantido: tudo vai para o mantido", async () => {
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Dora" } });
    const dup = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Dora (dup)" } });
    const fazenda = await empresa(TEAM, "Fazenda Boa Vista");
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: keep.id, companyId: fazenda.id, papel: "dono" } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: dup.id, companyId: fazenda.id, papel: "funcionario" } });
    const c1 = await ligacao(TEAM, dup.id, `prov-${sufixo}-1`);
    const c2 = await ligacao(TEAM, dup.id, `prov-${sufixo}-2`);
    const { a, convite } = await compromisso(TEAM, dup.id, "Visita");

    await runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id]));

    expect(await basePrisma.contact.findUnique({ where: { id: dup.id } })).toBeNull();
    // As 2 ligações existem, são do mantido e seguem inteiras (o id do provedor, a duração e a gravação).
    const calls = await basePrisma.call.findMany({ where: { id: { in: [c1.id, c2.id] } }, orderBy: { providerCallId: "asc" } });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.contactId)).toEqual([keep.id, keep.id]);
    expect(calls.map((c) => c.providerCallId)).toEqual([`prov-${sufixo}-1`, `prov-${sufixo}-2`]);
    expect(calls.map((c) => c.durationSeconds)).toEqual([42, 42]);
    expect(calls.every((c) => c.recordingUrl?.startsWith("https://exemplo.test/"))).toBe(true);
    // Nenhuma Activity de ligação ficou apontando para o vazio.
    expect(await callIdsOrfaos(TEAM, keep.id)).toEqual({ total: 2, orfaos: [] });
    // Compromisso e convite não perderam o contato.
    expect((await basePrisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).contactId).toBe(keep.id);
    expect((await basePrisma.appointmentAttendee.findUniqueOrThrow({ where: { id: convite.id } })).contactId).toBe(keep.id);
    // Sobra 1 vínculo com a empresa, e o papel do mantido vence.
    const vinculos = await basePrisma.contactCompany.findMany({ where: { teamId: TEAM, companyId: fazenda.id } });
    expect(vinculos).toHaveLength(1);
    expect(vinculos[0]).toMatchObject({ contactId: keep.id, papel: "dono" });
  });

  it("empresa que o mantido não tem vai para ele, com o papel que tinha; dois duplicados com a mesma empresa deixam um vínculo só", async () => {
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Eli" } });
    const d1 = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Eli 1" } });
    const d2 = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Eli 2" } });
    const x = await empresa(TEAM, "Agro X");
    const y = await empresa(TEAM, "Agro Y");
    // createdAt explícito: o vínculo mais antigo entra primeiro, sem depender do relógio do banco.
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: d1.id, companyId: x.id, papel: "socio", createdAt: em(-3) } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: d1.id, companyId: y.id, papel: "dono", createdAt: em(-3) } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: d2.id, companyId: x.id, papel: "funcionario", createdAt: em(-1) } });
    await ligacao(TEAM, d1.id, `prov-${sufixo}-a`);
    await ligacao(TEAM, d2.id, `prov-${sufixo}-b`);

    await runWithTeam(TEAM, () => mergeContacts(keep.id, [d1.id, d2.id]));

    const r = await retrato(TEAM, keep.id);
    expect(r.calls).toHaveLength(2);
    expect(r.empresas.sort()).toEqual([`${x.id}:socio`, `${y.id}:dono`].sort()); // o vínculo mais antigo (d1) vence o de d2
    expect(await basePrisma.contactCompany.count({ where: { teamId: TEAM, contactId: { in: [d1.id, d2.id] } } })).toBe(0);
    expect(await callIdsOrfaos(TEAM, keep.id)).toEqual({ total: 2, orfaos: [] });
  });

  it("rodar de novo não muda nada", async () => {
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Flávia" } });
    const dup = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Flávia (dup)" } });
    const co = await empresa(TEAM, "Sítio Z");
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: dup.id, companyId: co.id } });
    await ligacao(TEAM, dup.id, `prov-${sufixo}-r`);
    await compromisso(TEAM, dup.id, "Retorno");

    await runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id]));
    const depoisDaPrimeira = await retrato(TEAM, keep.id);
    expect(depoisDaPrimeira.calls).toHaveLength(1);

    // O duplicado já não existe: recusa como id que não é do time, sem tocar em nada.
    await expect(runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id]))).rejects.toMatchObject({ name: "OwnedNotFound" });
    expect(await retrato(TEAM, keep.id)).toEqual(depoisDaPrimeira);
  });

  it("rodar de novo com o duplicado ainda vivo (passo 2 já feito): conclui, não duplica nada e leva o que chegou depois", async () => {
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Hugo" } });
    const dup = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Hugo (dup)" } });
    const co = await empresa(TEAM, "Rancho W");
    // Estado de uma unificação interrompida depois do passo 2: o que já seguiu a pessoa está no mantido,
    // e o duplicado continua na lista, vazio.
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: keep.id, companyId: co.id, papel: "dono" } });
    await ligacao(TEAM, keep.id, `prov-${sufixo}-m`);
    await compromisso(TEAM, keep.id, "Reunião");
    const antes = await retrato(TEAM, keep.id);

    await runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id]));
    expect(await basePrisma.contact.findUnique({ where: { id: dup.id } })).toBeNull();
    expect(await retrato(TEAM, keep.id)).toEqual(antes);

    // Uma ligação e um vínculo que entraram num duplicado depois também seguem para o mantido, sem repetir a empresa.
    const dup2 = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Hugo (dup 2)" } });
    await ligacao(TEAM, dup2.id, `prov-${sufixo}-n`);
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: dup2.id, companyId: co.id, papel: "funcionario" } });
    await runWithTeam(TEAM, () => mergeContacts(keep.id, [dup2.id]));
    const depois = await retrato(TEAM, keep.id);
    expect(depois.calls).toHaveLength(2);
    expect(depois.empresas).toEqual(antes.empresas); // o vínculo repetido não voltou nem trocou o papel
    expect(await callIdsOrfaos(TEAM, keep.id)).toEqual({ total: 2, orfaos: [] });
  });

  it("dois times: o duplicado de outro time é recusado e nada dele muda; as ligações de outro time não se mexem", async () => {
    const keep = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Gil" } });
    const dup = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Gil (dup)" } });
    const alheio = await basePrisma.contact.create({ data: { teamId: OUTRO, nome: "Gil (outro time)" } });
    const coAlheia = await empresa(OUTRO, "Fazenda Alheia");
    await basePrisma.contactCompany.create({ data: { teamId: OUTRO, contactId: alheio.id, companyId: coAlheia.id } });
    await ligacao(OUTRO, alheio.id, `prov-${sufixo}-o`);
    await compromisso(OUTRO, alheio.id, "Alheio");
    await ligacao(TEAM, dup.id, `prov-${sufixo}-t`);
    const antes = await retrato(OUTRO, alheio.id);

    // Pedir para unificar o contato de outro time: recusa, e o mantido não ganha nada dele.
    await expect(runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id, alheio.id]))).rejects.toMatchObject({ name: "OwnedNotFound" });
    expect(await retrato(OUTRO, alheio.id)).toEqual(antes);
    expect(await basePrisma.call.count({ where: { contactId: keep.id } })).toBe(0);
    expect(await basePrisma.contact.findUnique({ where: { id: dup.id } })).not.toBeNull();

    // Unificar no próprio time não encosta no outro.
    await runWithTeam(TEAM, () => mergeContacts(keep.id, [dup.id]));
    expect(await basePrisma.call.count({ where: { teamId: TEAM, contactId: keep.id } })).toBe(1);
    expect(await retrato(OUTRO, alheio.id)).toEqual(antes);
    expect(await callIdsOrfaos(OUTRO, alheio.id)).toEqual({ total: 1, orfaos: [] });
  });
});
