import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import * as tags from "./index";
import * as contacts from "../contacts/index";
import { TagJaExiste, TagNotFound } from "./index";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000c3", "00000000-0000-0000-0000-0000000000d4"];

const TEAM_A = "00000000-0000-0000-0000-0000000000c3";
const TEAM_B = "00000000-0000-0000-0000-0000000000d4";

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Team A (tags test)"],
    [TEAM_B, "Team B (tags test)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

beforeEach(async () => {
  await basePrisma.contactTag.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.tag.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
});

describe("createTag", () => {
  it("cria e impede nome duplicado no mesmo time", async () => {
    await runWithTeam(TEAM_A, async () => {
      const t = await tags.createTag({ nome: "Quentes", cor: "amber" });
      expect(t.nome).toBe("Quentes");
      await expect(tags.createTag({ nome: "Quentes" })).rejects.toThrow(TagJaExiste);
    });
  });

  it("nomes iguais em times diferentes coexistem (isolamento)", async () => {
    await runWithTeam(TEAM_A, async () => tags.createTag({ nome: "VIP" }));
    await runWithTeam(TEAM_B, async () => {
      const t = await tags.createTag({ nome: "VIP" });
      expect(t.nome).toBe("VIP");
      const lista = await tags.listTags();
      expect(lista.length).toBe(1); // só a do time B
    });
  });
});

describe("setContactTag — regra de 1 tag por contato", () => {
  it("substitui a tag existente ao atribuir outra", async () => {
    await runWithTeam(TEAM_A, async () => {
      const c = await contacts.create({ nome: "Ana", tags: [] });
      const t1 = await tags.createTag({ nome: "Frio" });
      const t2 = await tags.createTag({ nome: "Morno" });

      await tags.setContactTag(c.id, t1.id);
      expect((await tags.getContactTag(c.id))?.nome).toBe("Frio");

      await tags.setContactTag(c.id, t2.id);
      const atual = await tags.getContactTag(c.id);
      expect(atual?.nome).toBe("Morno");

      // Só uma linha de vínculo — nunca duas.
      const vinculos = await basePrisma.contactTag.count({ where: { contactId: c.id } });
      expect(vinculos).toBe(1);
    });
  });

  it("tagId null remove a tag (contato pode ficar sem tag)", async () => {
    await runWithTeam(TEAM_A, async () => {
      const c = await contacts.create({ nome: "Bia", tags: [] });
      const t = await tags.createTag({ nome: "X" });
      await tags.setContactTag(c.id, t.id);
      await tags.setContactTag(c.id, null);
      expect(await tags.getContactTag(c.id)).toBeNull();
    });
  });

  it("rejeita tag inexistente", async () => {
    await runWithTeam(TEAM_A, async () => {
      const c = await contacts.create({ nome: "Cba", tags: [] });
      await expect(
        tags.setContactTag(c.id, "00000000-0000-0000-0000-000000000999"),
      ).rejects.toThrow(TagNotFound);
    });
  });
});

describe("assignTagBulk + filtro por tag", () => {
  it("move N contatos e o filtro reflete", async () => {
    await runWithTeam(TEAM_A, async () => {
      const c1 = await contacts.create({ nome: "C1", tags: [] });
      const c2 = await contacts.create({ nome: "C2", tags: [] });
      const c3 = await contacts.create({ nome: "C3", tags: [] });
      const t = await tags.createTag({ nome: "Lote" });

      const res = await tags.assignTagBulk([c1.id, c2.id], t.id);
      expect(res.updated).toBe(2);

      const naTag = await contacts.count({ tag: t.id });
      expect(naTag).toBe(2);

      const semTag = await contacts.count({ tag: contacts.TAG_NONE });
      expect(semTag).toBe(1); // só c3

      const resumo = await tags.tagFilterSummary();
      expect(resumo.total).toBe(3);
      expect(resumo.semTag).toBe(1);
      expect(resumo.tags.find((x) => x.id === t.id)?.count).toBe(2);
      void c3;
    });
  });
});

describe("adicionar e tirar tag sem mexer nas outras", () => {
  const legado = async (id: string) => (await basePrisma.contact.findUniqueOrThrow({ where: { id } })).tags;
  const doCatalogo = async (id: string) =>
    (await basePrisma.contactTag.findMany({ where: { contactId: id }, include: { tag: true } })).map((v) => v.tag.nome).sort();

  it("addContactTag soma à tag que o contato já tem e espelha no campo antigo", async () => {
    await runWithTeam(TEAM_A, async () => {
      const c = await contacts.create({ nome: "Caio", tags: [] });
      const frio = await tags.createTag({ nome: "Frio" });
      const soja = await tags.createTag({ nome: "Soja" });
      await tags.setContactTag(c.id, frio.id);

      expect(await tags.addContactTag(c.id, soja.id)).toEqual({ adicionada: true });
      expect(await doCatalogo(c.id)).toEqual(["Frio", "Soja"]);
      expect(await legado(c.id)).toContain("Soja");

      // De novo: nada muda (nem duplica no campo antigo).
      expect(await tags.addContactTag(c.id, soja.id)).toEqual({ adicionada: false });
      expect((await legado(c.id)).filter((n) => n === "Soja")).toHaveLength(1);
    });
  });

  it("removeContactTag tira só aquela, inclusive do campo antigo com outra grafia", async () => {
    await runWithTeam(TEAM_A, async () => {
      const c = await contacts.create({ nome: "Davi", tags: [] });
      // Só no campo antigo (o cadastro levaria "SOJA" ao catálogo como outra tag).
      await basePrisma.contact.update({ where: { id: c.id }, data: { tags: ["SOJA", "Pediu para sair"] } });
      const soja = await tags.createTag({ nome: "Soja" });
      const milho = await tags.createTag({ nome: "Milho" });
      await tags.addContactTag(c.id, soja.id);
      await tags.addContactTag(c.id, milho.id);

      expect(await tags.removeContactTag(c.id, soja.id)).toEqual({ removida: true });
      expect(await doCatalogo(c.id)).toEqual(["Milho"]);
      const l = await legado(c.id);
      expect(l).not.toContain("SOJA");
      expect(l).toContain("Pediu para sair"); // marca do sistema fica
      expect(l).toContain("Milho");
      expect(await tags.removeContactTag(c.id, soja.id)).toEqual({ removida: false });
    });
  });

  it("addTagBulk conta só quem ainda não tinha; removeTagBulk só quem tinha", async () => {
    await runWithTeam(TEAM_A, async () => {
      const c1 = await contacts.create({ nome: "E1", tags: [] });
      const c2 = await contacts.create({ nome: "E2", tags: [] });
      const c3 = await contacts.create({ nome: "E3", tags: [] });
      const frio = await tags.createTag({ nome: "Frio" });
      const vip = await tags.createTag({ nome: "VIP" });
      await tags.addContactTag(c1.id, frio.id);
      await tags.addContactTag(c2.id, vip.id);

      expect(await tags.addTagBulk([c1.id, c2.id, c3.id, c3.id], vip.id)).toEqual({ updated: 2, jaTinham: 1 });
      expect(await doCatalogo(c1.id)).toEqual(["Frio", "VIP"]);
      expect(await doCatalogo(c3.id)).toEqual(["VIP"]);

      expect(await tags.removeTagBulk([c1.id, c2.id], vip.id)).toEqual({ updated: 2 });
      expect(await doCatalogo(c1.id)).toEqual(["Frio"]);
      expect(await doCatalogo(c2.id)).toEqual([]);
      expect(await legado(c2.id)).not.toContain("VIP");
      expect(await doCatalogo(c3.id)).toEqual(["VIP"]);
    });
  });

  it("recusa contato e tag de outro time", async () => {
    const deB = await runWithTeam(TEAM_B, async () => contacts.create({ nome: "Do B", tags: [] }));
    const tagB = await runWithTeam(TEAM_B, async () => tags.createTag({ nome: "Só do B" }));
    await runWithTeam(TEAM_A, async () => {
      const c = await contacts.create({ nome: "Do A", tags: [] });
      const t = await tags.createTag({ nome: "Do A" });
      await expect(tags.addContactTag(deB.id, t.id)).rejects.toThrow();
      await expect(tags.addTagBulk([c.id, deB.id], t.id)).rejects.toThrow();
      await expect(tags.addContactTag(c.id, tagB.id)).rejects.toThrow(TagNotFound);
      await expect(tags.removeTagBulk([c.id], tagB.id)).rejects.toThrow(TagNotFound);
    });
    expect(await basePrisma.contactTag.count({ where: { contactId: deB.id } })).toBe(0);
  });
});
