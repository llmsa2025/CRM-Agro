import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { count, list, listContactIds, listarContatosDaTela } from "../contacts/service";
import { exportFiltersSchema } from "../contacts/export";
import { AGRO_SEM_TIPO } from "./schema";

/** Filtro da lista de Contatos pelo que o contato é no agro (chips da tela). */

const TEAM = "00000000-0000-0000-0000-0000000a9203";
const OUTRO_TIME = "00000000-0000-0000-0000-0000000a9204";
const adm = { userId: "ana", role: "admin" };

const como = <T>(fn: () => Promise<T>, time = TEAM) => runWithTeam(time, fn, adm);
const nomes = (r: { items: { nome: string }[] }) => r.items.map((c) => c.nome).sort();

beforeAll(async () => {
  for (const id of [TEAM, OUTRO_TIME]) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Team Agro filtro (test) ${id.slice(-4)}` } });
  }
});

beforeEach(async () => {
  for (const t of [TEAM, OUTRO_TIME]) await basePrisma.contact.deleteMany({ where: { teamId: t } });
  const novo = (teamId: string, nome: string, agroTipos: string[]) => basePrisma.contact.create({ data: { teamId, nome, sobrenome: "Silva", agroTipos } });
  await novo(TEAM, "Ana", ["fazenda", "pecuaria"]);
  await novo(TEAM, "Beto", ["produtor"]);
  await novo(TEAM, "Caio", []);
  await novo(TEAM, "Duda", []);
  await novo(OUTRO_TIME, "Eva", ["fazenda"]);
});

describe("filtro agro na lista", () => {
  it("um tipo traz só quem tem esse tipo (e quem tem vários aparece em cada um)", async () => {
    expect(nomes(await como(() => list({ agro: "fazenda" })))).toEqual(["Ana"]);
    expect(nomes(await como(() => list({ agro: "pecuaria" })))).toEqual(["Ana"]);
    expect(nomes(await como(() => list({ agro: "produtor" })))).toEqual(["Beto"]);
    expect(nomes(await como(() => list({ agro: "transportadora" })))).toEqual([]);
  });

  it("'nenhum' traz quem não tem classificação", async () => {
    expect(nomes(await como(() => list({ agro: AGRO_SEM_TIPO })))).toEqual(["Caio", "Duda"]);
    expect(await como(() => count({ agro: AGRO_SEM_TIPO }))).toBe(2);
  });

  it("sem filtro, ou com valor estranho, traz todos", async () => {
    expect(await como(() => count({}))).toBe(4);
    expect(await como(() => count({ agro: "soja" }))).toBe(4);
  });

  it("não vaza contato de outro time", async () => {
    expect(nomes(await como(() => list({ agro: "fazenda" }), OUTRO_TIME))).toEqual(["Eva"]);
    expect(await como(() => count({ agro: "fazenda" }))).toBe(1);
  });

  it("junto com a busca por texto (caminho do SQL) e com 'selecionar todos do filtro'", async () => {
    const achados = await como(() => listarContatosDaTela({ search: "silva", agro: AGRO_SEM_TIPO }, { limit: 50, offset: 0 }));
    expect(nomes(achados)).toEqual(["Caio", "Duda"]);
    expect(achados.total).toBe(2);

    const comTipo = await como(() => listarContatosDaTela({ search: "silva", agro: "produtor" }, { limit: 50, offset: 0 }));
    expect(nomes(comTipo)).toEqual(["Beto"]);

    expect(await como(() => listContactIds({ agro: "fazenda", historico: true }))).toHaveLength(1);
    expect(await como(() => listContactIds({ agro: AGRO_SEM_TIPO, historico: true }))).toHaveLength(2);
  });
});

describe("filtro agro na exportação", () => {
  it("a URL aceita os tipos e 'nenhum', e recusa o resto", () => {
    expect(exportFiltersSchema.safeParse({ agro: "transportadora" }).success).toBe(true);
    expect(exportFiltersSchema.safeParse({ agro: "nenhum" }).success).toBe(true);
    expect(exportFiltersSchema.safeParse({ agro: "soja" }).success).toBe(false);
  });
});
