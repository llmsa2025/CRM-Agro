import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { vinculosDosRascunhos, type RascunhoDedup } from "./vinculo";
import { listDrafts } from "./service";

/**
 * Vínculo da empresa captada com os contatos do time (linha da Captação:
 * "Contato: Fulano +N"). Cobre: sem vínculo, um, vários (telefone, CNPJ no
 * contato e CNPJ da empresa ligada), outro time sem vazar e o escopo de quem só
 * vê os próprios contatos. Só banco de teste; nada é enviado.
 */

const TEAM = "00000000-0000-0000-0000-0000000e7c01";
const OUTRO_TIME = "00000000-0000-0000-0000-0000000e7c02";
const TIMES = [TEAM, OUTRO_TIME];
const sufixo = Math.random().toString(36).slice(2, 7);

const CNPJ_VARIOS = "11222333000181";
const CNPJ_DE_OUTRO_TIME = "44555666000172";
const TEL_UM = "+5565988880001";
const TEL_COLEGA = "+5565988880002";
const TEL_OUTRO_TIME = "+5565988880003";

let master: { id: string };
let joao: { id: string };
let pedro: { id: string };
const ids: Record<string, string> = {};

const comoMaster = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: master.id, role: "owner" });
const comoPedro = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: pedro.id, role: "member" });

const rasc = (id: string, d: Partial<RascunhoDedup>): RascunhoDedup => ({ id, origem: "cnpj", telefone: null, email: null, cnpj: null, extra: null, ...d });

async function limpar() {
  for (const teamId of TIMES) {
    for (const m of ["contactCompany", "company", "channelIdentifier", "prospectDraft", "contact", "user"] as const) {
      await (basePrisma[m] as unknown as { deleteMany: (x: unknown) => Promise<unknown> }).deleteMany({ where: { teamId } });
    }
  }
}

beforeAll(async () => {
  await limpar();
  for (const [id, name] of [[TEAM, "Vínculo captação (test)"], [OUTRO_TIME, "Vínculo captação outro (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  const mk = (name: string, role: string, teamId = TEAM) =>
    basePrisma.user.create({ data: { teamId, name, email: `${name.toLowerCase()}-${sufixo}@vinc.dev`, role } });
  master = await mk("Master", "owner");
  joao = await mk("João", "member");
  pedro = await mk("Pedro", "member");

  const contato = (chave: string, nome: string, ownerId: string, extra: { cnpj?: string; compartilhado?: boolean; teamId?: string } = {}) =>
    basePrisma.contact.create({ data: { teamId: extra.teamId ?? TEAM, nome, ownerId, cnpj: extra.cnpj ?? null, compartilhado: extra.compartilhado ?? false } }).then((c) => {
      ids[chave] = c.id;
      return c;
    });
  const identificador = (contactId: string, valor: string, teamId = TEAM) =>
    basePrisma.channelIdentifier.create({ data: { teamId, contactId, canal: "whatsapp", valor, isPrimary: true } });

  // Um contato do Pedro, achado pelo telefone.
  await identificador((await contato("pedro", "Pedro Contato", pedro.id)).id, TEL_UM);
  // Um contato do João (colega), achado pelo telefone.
  await identificador((await contato("joao", "João Contato", joao.id)).id, TEL_COLEGA);
  // Vários para o mesmo CNPJ: dois pelo CNPJ gravado no contato, um pela empresa ligada.
  await contato("cnpjA", "Ana Fazenda", joao.id, { cnpj: CNPJ_VARIOS });
  await contato("cnpjB", "Beto Fazenda", pedro.id, { cnpj: CNPJ_VARIOS });
  const cLigado = await contato("cnpjC", "Caio Fazenda", joao.id, { compartilhado: true });
  const empresa = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Fazenda Boa", cnpj: CNPJ_VARIOS } });
  await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: cLigado.id, companyId: empresa.id, papel: "socio" } });

  // Outro time: mesmo telefone e outro CNPJ. Não pode aparecer para o TEAM.
  const dono2 = await mk("Dono2", "owner", OUTRO_TIME);
  await identificador((await contato("outroTime", "Contato de Outro Time", dono2.id, { teamId: OUTRO_TIME })).id, TEL_OUTRO_TIME, OUTRO_TIME);
  await contato("outroTimeCnpj", "Empresa de Outro Time", dono2.id, { teamId: OUTRO_TIME, cnpj: CNPJ_DE_OUTRO_TIME });
});

afterAll(limpar);

describe("vinculosDosRascunhos", () => {
  it("empresa sem vínculo não entra no mapa", async () => {
    const m = await comoMaster(() => vinculosDosRascunhos([rasc("sem", { telefone: "+5565988889999", cnpj: "99888777000166" }), rasc("vazio", {})]));
    expect(m.size).toBe(0);
  });

  it("um vínculo: o nome do contato, sem outros", async () => {
    const m = await comoMaster(() => vinculosDosRascunhos([rasc("um", { telefone: TEL_UM })]));
    expect(m.get("um")).toEqual({ contato: { id: ids.pedro, nome: "Pedro Contato" }, outros: 0 });
  });

  it("vários vínculos (CNPJ no contato e empresa ligada): o primeiro por nome e o resto em +N, sem repetir", async () => {
    const m = await comoMaster(() => vinculosDosRascunhos([rasc("varios", { cnpj: CNPJ_VARIOS })]));
    expect(m.get("varios")).toEqual({ contato: { id: ids.cnpjA, nome: "Ana Fazenda" }, outros: 2 });
  });

  it("telefone e CNPJ do mesmo contato contam uma vez só", async () => {
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: ids.cnpjB!, canal: "whatsapp", valor: "+5565988880010" } });
    const m = await comoMaster(() => vinculosDosRascunhos([rasc("misto", { telefone: "+5565988880010", cnpj: CNPJ_VARIOS })]));
    // Telefone vem primeiro na ordem das chaves (Beto), depois os do CNPJ sem repetir o Beto.
    expect(m.get("misto")).toEqual({ contato: { id: ids.cnpjB, nome: "Beto Fazenda" }, outros: 2 });
  });

  it("outro time não vaza: o mesmo telefone e o CNPJ de lá não vinculam nada aqui", async () => {
    const m = await comoMaster(() => vinculosDosRascunhos([rasc("t", { telefone: TEL_OUTRO_TIME, cnpj: CNPJ_DE_OUTRO_TIME })]));
    expect(m.size).toBe(0);
    // E o inverso: quem está no outro time não enxerga os contatos deste.
    const doOutro = await runWithTeam(OUTRO_TIME, () => vinculosDosRascunhos([rasc("t", { telefone: TEL_UM, cnpj: CNPJ_VARIOS })]), {
      userId: "qualquer",
      role: "owner",
    });
    expect(doOutro.size).toBe(0);
  });

  it("quem só vê os próprios contatos não recebe o nome do contato do colega", async () => {
    const m = await comoPedro(() => vinculosDosRascunhos([rasc("colega", { telefone: TEL_COLEGA }), rasc("proprio", { telefone: TEL_UM })]));
    // Existe vínculo, mas o contato é do João: sem nome.
    expect(m.get("colega")).toEqual({ contato: null, outros: 0 });
    expect(m.get("proprio")).toEqual({ contato: { id: ids.pedro, nome: "Pedro Contato" }, outros: 0 });
  });

  it("no CNPJ com vários, o Pedro vê o dele e o compartilhado; o contato privado do João fica de fora", async () => {
    const m = await comoPedro(() => vinculosDosRascunhos([rasc("varios", { cnpj: CNPJ_VARIOS })]));
    // Visíveis: Beto (dele) e Caio (compartilhado). A Ana (do João, privada) não conta nem aparece.
    expect(m.get("varios")).toEqual({ contato: { id: ids.cnpjB, nome: "Beto Fazenda" }, outros: 1 });
  });

  it("sem ator (fail-closed) não recebe nome nenhum", async () => {
    const m = await runWithTeam(TEAM, () => vinculosDosRascunhos([rasc("x", { telefone: TEL_UM })]));
    expect(m.get("x")).toEqual({ contato: null, outros: 0 });
  });
});

describe("listDrafts leva o vínculo na linha", () => {
  it("já cadastrado traz o contato visível; o que não é cadastrado fica sem vínculo", async () => {
    const mkRasc = (nome: string, d: { telefone?: string; cnpj?: string }) =>
      basePrisma.prospectDraft.create({
        data: { teamId: TEAM, origem: "cnpj", lote: `l-${sufixo}`, nome, telefone: d.telefone ?? null, cnpj: d.cnpj ?? null, ownerId: pedro.id },
      });
    const cadastrada = await mkRasc("Fazenda Boa", { cnpj: CNPJ_VARIOS });
    const doColega = await mkRasc("Do colega", { telefone: TEL_COLEGA });
    const nova = await mkRasc("Fazenda Nova", { telefone: "+5565988887777" });

    const fila = await comoPedro(() => listDrafts({ lote: `l-${sufixo}` }));
    const de = (id: string) => fila.find((d) => d.id === id)!;
    expect(de(cadastrada.id)).toMatchObject({ jaExiste: true, vinculo: { contato: { nome: "Beto Fazenda" }, outros: 1 } });
    // Colega: continua "já cadastrado" com o responsável, mas sem o nome do contato.
    expect(de(doColega.id)).toMatchObject({ jaExiste: true, jaExisteResponsavel: "João", vinculo: { contato: null, outros: 0 } });
    expect(de(nova.id)).toMatchObject({ jaExiste: false, vinculo: null });
  });
});
