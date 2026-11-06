import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { vincularDrafts } from "./service";

/**
 * "Vincular a contato" (Captação por CNPJ): a empresa vai para a ficha de um contato que já existe,
 * sem virar contato. Cobre: vínculo sem criar contato, o rascunho sair da fila, reuso da empresa
 * pelo CNPJ, repetir sem duplicar, contato de outro time, escopo de quem só vê os próprios,
 * rascunho que não é de CNPJ e papel sem permissão. Só banco de teste.
 */

const TEAM = "00000000-0000-0000-0000-0000000e7c11";
const OUTRO_TIME = "00000000-0000-0000-0000-0000000e7c12";
const TIMES = [TEAM, OUTRO_TIME];
const sufixo = Math.random().toString(36).slice(2, 7);

let master: { id: string };
let joao: { id: string };
let pedro: { id: string };
let contatoJoao: { id: string };
let contatoPedro: { id: string };
let contatoOutroTime: { id: string };

const comoMaster = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: master.id, role: "owner" });
const comoJoao = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: joao.id, role: "member" });
const comoViewer = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: joao.id, role: "viewer" });

async function limpar() {
  for (const teamId of TIMES) {
    for (const m of ["contactCompany", "company", "channelIdentifier", "prospectDraft", "contact", "user"] as const) {
      await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId } });
    }
  }
}

const rascunho = (nome: string, cnpj: string, donoId: string | null, extra: { origem?: string } = {}) =>
  basePrisma.prospectDraft.create({
    data: {
      teamId: TEAM,
      origem: extra.origem ?? "cnpj",
      lote: "lote-vincular",
      nome,
      empresa: nome,
      cnpj,
      cidade: "Sorriso",
      uf: "MT",
      ownerId: donoId,
      extra: { razaoSocial: `${nome} LTDA`, endereco: "Rod. BR-163, km 12", site: null },
    },
  });

beforeAll(async () => {
  await limpar();
  for (const [id, name] of [[TEAM, "Vincular captação (test)"], [OUTRO_TIME, "Vincular captação outro (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const mk = (name: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name, email: `${name.toLowerCase()}-${sufixo}@vincular.dev`, role } });
  master = await mk("Master", "owner");
  joao = await mk("João", "member");
  pedro = await mk("Pedro", "member");
  contatoJoao = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Contato do João", ownerId: joao.id } });
  contatoPedro = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Contato do Pedro", ownerId: pedro.id } });
  contatoOutroTime = await basePrisma.contact.create({ data: { teamId: OUTRO_TIME, nome: "Contato de outro time" } });
});

beforeEach(async () => {
  for (const m of ["contactCompany", "company", "prospectDraft"] as const) {
    await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId: { in: TIMES } } });
  }
  await basePrisma.contact.updateMany({ where: { id: contatoJoao.id }, data: { empresa: null, cnpj: null } });
});

afterAll(limpar);

describe("vincularDrafts", () => {
  it("liga as empresas ao contato, sem criar contato, e tira os rascunhos da fila", async () => {
    const a = await rascunho("Fazenda Alfa", "11222333000181", joao.id);
    const b = await rascunho("Fazenda Beta", "44555666000172", joao.id);
    const contatosAntes = await basePrisma.contact.count({ where: { teamId: TEAM } });

    const r = await comoJoao(() => vincularDrafts([a.id, b.id], contatoJoao.id));

    expect(r).toEqual({ vinculados: 2, pulados: 0 });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM } })).toBe(contatosAntes);
    const links = await basePrisma.contactCompany.findMany({ where: { contactId: contatoJoao.id }, include: { company: true } });
    expect(links.map((l) => l.company.cnpj).sort()).toEqual(["11222333000181", "44555666000172"]);
    expect(links.every((l) => l.papel === "socio")).toBe(true);
    // Usa a razão social do CNPJ, como na importação.
    expect(links.map((l) => l.company.nome).sort()).toEqual(["Fazenda Alfa LTDA", "Fazenda Beta LTDA"]);
    expect(links.find((l) => l.company.cnpj === "11222333000181")?.company.cidade).toBe("Sorriso");
    const rascunhos = await basePrisma.prospectDraft.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rascunhos.every((d) => d.status === "importado")).toBe(true);
  });

  it("reusa a empresa que já existe com o mesmo CNPJ e não repete o vínculo", async () => {
    const empresa = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Alfa já cadastrada", cnpj: "11222333000181" } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: contatoJoao.id, companyId: empresa.id, papel: "dono" } });
    const d = await rascunho("Fazenda Alfa", "11222333000181", joao.id);

    const r = await comoJoao(() => vincularDrafts([d.id], contatoJoao.id));

    expect(r.vinculados).toBe(1);
    expect(await basePrisma.company.count({ where: { teamId: TEAM, cnpj: "11222333000181" } })).toBe(1);
    const links = await basePrisma.contactCompany.findMany({ where: { contactId: contatoJoao.id } });
    expect(links).toHaveLength(1);
    // Quem já era dono não passa a sócio por causa de uma captação.
    expect(links[0]?.papel).toBe("dono");
  });

  it("repetir a chamada com o mesmo rascunho não vincula de novo", async () => {
    const d = await rascunho("Fazenda Alfa", "11222333000181", joao.id);
    await comoJoao(() => vincularDrafts([d.id], contatoJoao.id));
    const r = await comoJoao(() => vincularDrafts([d.id], contatoJoao.id));
    expect(r).toEqual({ vinculados: 0, pulados: 1 });
    expect(await basePrisma.contactCompany.count({ where: { contactId: contatoJoao.id } })).toBe(1);
  });

  it("recusa contato de outro time e deixa os rascunhos na fila", async () => {
    const d = await rascunho("Fazenda Alfa", "11222333000181", joao.id);
    await expect(comoJoao(() => vincularDrafts([d.id], contatoOutroTime.id))).rejects.toMatchObject({ name: "OwnedNotFound" });
    expect((await basePrisma.prospectDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("pendente");
    expect(await basePrisma.company.count({ where: { teamId: { in: TIMES } } })).toBe(0);
  });

  it("quem só vê os próprios não vincula ao contato de um colega", async () => {
    const d = await rascunho("Fazenda Alfa", "11222333000181", joao.id);
    await expect(comoJoao(() => vincularDrafts([d.id], contatoPedro.id))).rejects.toMatchObject({ name: "OwnedNotFound" });
    expect(await basePrisma.contactCompany.count({ where: { teamId: TEAM } })).toBe(0);
  });

  it("não mexe no rascunho da fila de outra pessoa", async () => {
    const doPedro = await rascunho("Fazenda do Pedro", "44555666000172", pedro.id);
    const r = await comoJoao(() => vincularDrafts([doPedro.id], contatoJoao.id));
    expect(r).toEqual({ vinculados: 0, pulados: 1 });
    expect((await basePrisma.prospectDraft.findUniqueOrThrow({ where: { id: doPedro.id } })).status).toBe("pendente");
  });

  it("o master vincula o rascunho de um vendedor ao contato do vendedor", async () => {
    const d = await rascunho("Fazenda Alfa", "11222333000181", joao.id);
    const r = await comoMaster(() => vincularDrafts([d.id], contatoJoao.id));
    expect(r.vinculados).toBe(1);
  });

  it("só vincula rascunho de CNPJ (o do Maps fica na fila)", async () => {
    const maps = await rascunho("Loja do Maps", "11222333000181", joao.id, { origem: "maps" });
    const r = await comoJoao(() => vincularDrafts([maps.id], contatoJoao.id));
    expect(r).toEqual({ vinculados: 0, pulados: 1 });
    expect((await basePrisma.prospectDraft.findUniqueOrThrow({ where: { id: maps.id } })).status).toBe("pendente");
  });

  it("só leitura (viewer) não vincula", async () => {
    const d = await rascunho("Fazenda Alfa", "11222333000181", joao.id);
    await expect(comoViewer(() => vincularDrafts([d.id], contatoJoao.id))).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await basePrisma.contactCompany.count({ where: { teamId: TEAM } })).toBe(0);
  });
});
