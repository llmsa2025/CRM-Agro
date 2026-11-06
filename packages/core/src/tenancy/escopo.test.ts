import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam, SYSTEM_USER_ID, SYSTEM_ROLE } from "@crmagro/db";
import { escopoDoAtor, chaveDoEscopo, whereDoEscopo, donoPadrao, donoValido } from "./escopo";
import { create as criarContato, importCsv } from "../contacts/service";
import { createDeal } from "../funnels/service";
import { createFlow } from "../flows/service";
import { insertDrafts } from "../captacao/service";

/**
 * Escopo por dono (F3a): quem vê tudo, o filtro de quem não vê, e o dono dos
 * registros novos (quem cria; sistema = sem dono; negócio = dono do contato).
 */
const TEAM = "00000000-0000-0000-0000-00000000f3a1";
const sufixo = Math.random().toString(36).slice(2, 7);
let dono: { id: string }, vendedor: { id: string };

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Escopo (test)" } });
  const mk = (n: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `${n}-${sufixo}@escopo.dev`, role } });
  dono = await mk("dono", "owner");
  vendedor = await mk("vendedor", "member");
});
afterAll(async () => {
  for (const m of ["prospectDraft", "deal", "stage", "funnel", "flowNode", "flow", "activity", "channelIdentifier", "contact", "user"] as const) {
    await (basePrisma[m] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: TEAM } });
  }
});

const como = <T>(u: { id: string }, role: string, fn: () => T, extra: { verTudoEm?: string[] } = {}) =>
  runWithTeam(TEAM, fn, { userId: u.id, role, ...extra });

describe("escopo por dono", () => {
  it("master, admin, 'ver tudo' e sistema veem tudo; membro e só leitura veem o seu", () => {
    expect(como(dono, "owner", () => escopoDoAtor("contatos"))).toEqual({ tudo: true });
    expect(como(vendedor, "admin", () => escopoDoAtor("conversas"))).toEqual({ tudo: true });
    expect(como(vendedor, "member", () => escopoDoAtor("contatos"), { verTudoEm: ["contatos"] })).toEqual({ tudo: true });
    expect(runWithTeam(TEAM, () => escopoDoAtor("funis"), { userId: SYSTEM_USER_ID, role: SYSTEM_ROLE })).toEqual({ tudo: true });
    expect(como(vendedor, "member", () => escopoDoAtor("contatos"))).toEqual({ tudo: false, userId: vendedor.id });
    expect(como(vendedor, "viewer", () => whereDoEscopo("contatos", "ownerId"))).toEqual({ ownerId: vendedor.id });
    expect(como(vendedor, "member", () => whereDoEscopo("contatos", "ownerId", { compartilhado: true }))).toEqual({
      OR: [{ ownerId: vendedor.id }, { compartilhado: true }],
    });
    expect(como(dono, "owner", () => whereDoEscopo("contatos", "ownerId"))).toEqual({});
    // Sem ator: filtro impossível (fail-closed), nunca "tudo".
    expect(runWithTeam(TEAM, () => escopoDoAtor("contatos"))).toMatchObject({ tudo: false, userId: "__sem_ator__" });
    // ...nem o compartilhado aparece sem ator.
    expect(runWithTeam(TEAM, () => whereDoEscopo("contatos", "ownerId", { compartilhado: true }))).toEqual({ ownerId: "__sem_ator__" });
  });

  it("'ver tudo' é POR TELA: vale só nas telas liberadas; a chave de cache separa as telas", () => {
    const soContatos = { verTudoEm: ["contatos"] };
    expect(como(vendedor, "member", () => escopoDoAtor("contatos"), soContatos)).toEqual({ tudo: true });
    expect(como(vendedor, "member", () => escopoDoAtor("conversas"), soContatos)).toEqual({ tudo: false, userId: vendedor.id });
    expect(como(vendedor, "member", () => whereDoEscopo("funis", "ownerId"), soContatos)).toEqual({ ownerId: vendedor.id });
    expect(como(vendedor, "member", () => chaveDoEscopo("contatos", "funis"), soContatos)).toBe(`tudo|${vendedor.id}`);
    // Lista com lixo (tela desconhecida) não libera nada além do que diz.
    expect(como(vendedor, "member", () => escopoDoAtor("fluxos"), { verTudoEm: ["tudo", "*"] })).toEqual({ tudo: false, userId: vendedor.id });
  });

  it("registros novos nascem com o dono certo", async () => {
    const c = await como(vendedor, "member", () => criarContato({ nome: "Meu lead", tags: [] }));
    expect(c.ownerId).toBe(vendedor.id);
    // Negócio: dono do contato, mesmo quando é o master que cria.
    const funil = await basePrisma.funnel.create({ data: { teamId: TEAM, nome: "Vendas", tipo: "vendas" } });
    const etapa = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: funil.id, nome: "Novo", ordem: 0 } });
    const d = await como(dono, "owner", () => createDeal({ funnelId: funil.id, stageId: etapa.id, contactId: c.id }));
    expect(d.ownerId).toBe(vendedor.id);
    const f = await como(vendedor, "member", () => createFlow({ nome: "Meu fluxo", triggerType: "manual", triggerConfig: {}, nodes: [] } as never));
    expect((await basePrisma.flow.findUniqueOrThrow({ where: { id: (f as { id: string }).id } })).createdById).toBe(vendedor.id);
    // Captação no worker (sistema): o dono vem do job.
    await runWithTeam(TEAM, () => insertDrafts("maps", `lote-${sufixo}`, [{ nome: "Fazenda X" }], vendedor.id), { userId: SYSTEM_USER_ID, role: SYSTEM_ROLE });
    expect((await basePrisma.prospectDraft.findFirstOrThrow({ where: { teamId: TEAM, lote: `lote-${sufixo}` } })).ownerId).toBe(vendedor.id);
    // Sistema sem dono explícito: null.
    expect(runWithTeam(TEAM, () => donoPadrao(), { userId: SYSTEM_USER_ID, role: SYSTEM_ROLE })).toBeNull();
  });

  it("donoValido: só aceita quem existe NESTE time", async () => {
    const outro = "00000000-0000-0000-0000-00000000f3a2";
    await basePrisma.team.upsert({ where: { id: outro }, update: {}, create: { id: outro, name: "Outro (test)" } });
    const alheio = await basePrisma.user.create({ data: { teamId: outro, name: "alheio", email: `alheio-${sufixo}@escopo.dev`, role: "owner" } });
    try {
      expect(await runWithTeam(TEAM, () => donoValido(vendedor.id))).toBe(vendedor.id);
      expect(await runWithTeam(TEAM, () => donoValido(alheio.id))).toBeNull();
      expect(await runWithTeam(TEAM, () => donoValido("00000000-0000-0000-0000-0000000dead0"))).toBeNull();
      expect(await runWithTeam(TEAM, () => donoValido(null))).toBeNull();
    } finally {
      await basePrisma.user.delete({ where: { id: alheio.id } });
      await basePrisma.team.delete({ where: { id: outro } });
    }
  });

  it("importar CSV: os contatos são de quem importou", async () => {
    const r = await como(vendedor, "member", () => importCsv(`nome,telefone\nImportado ${sufixo},659${String(Date.now()).slice(-8)}`));
    expect(r.created).toBe(1);
    const c = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM, nome: `Importado ${sufixo}` } });
    expect(c.ownerId).toBe(vendedor.id);
  });
});
