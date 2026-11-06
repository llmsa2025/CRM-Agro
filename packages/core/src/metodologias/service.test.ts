import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import { ForbiddenError } from "../auth/authz";
import { LIMITES_DA_METODOLOGIA, MODELOS_PRONTOS } from "./modelos";
import {
  SEM_METODOLOGIA,
  atualizarMetodologia,
  criarMetodologia,
  definirPadrao,
  excluirMetodologia,
  garantirModelosIniciais,
  limparCacheDeMetodologias,
  listarMetodologias,
  metodologiaParaIa,
} from "./service";

/** Metodologias: modelos iniciais, finalidade, padrão por finalidade, papéis, isolamento e leitura pela IA. */

const TEAM = "00000000-0000-0000-0000-0000000000c1";
const OUTRO = "00000000-0000-0000-0000-0000000000c2";
const comPapel = <T>(role: string, fn: () => Promise<T>, time = TEAM) => runWithTeam(time, fn, { userId: `u-${role}`, role });
const admin = <T>(fn: () => Promise<T>, time = TEAM) => comPapel("admin", fn, time);
const comoSistema = <T>(fn: () => Promise<T>, time = TEAM) => runAsSystem(time, fn);

beforeAll(async () => {
  for (const id of [TEAM, OUTRO]) await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Team metodologias (${id.slice(-2)})` } });
});

beforeEach(async () => {
  limparCacheDeMetodologias();
  await basePrisma.methodology.deleteMany({ where: { teamId: { in: [TEAM, OUTRO] } } });
  await basePrisma.team.updateMany({ where: { id: { in: [TEAM, OUTRO] } }, data: { metodologiasIniciadas: false } });
});

describe("modelos prontos", () => {
  it("o time recebe SPIN Selling, BANT e Consultiva, com o SPIN como padrão do agente", async () => {
    await admin(() => garantirModelosIniciais());
    const lista = await admin(() => listarMetodologias());
    expect(lista.map((m) => m.nome).sort()).toEqual(["BANT", "Consultiva", "SPIN Selling"]);
    expect(lista.every((m) => m.finalidade === "agente_fluxo")).toBe(true);
    expect(lista.filter((m) => m.padrao).map((m) => m.nome)).toEqual(["SPIN Selling"]);
    expect(MODELOS_PRONTOS.every((m) => m.conteudo.length <= LIMITES_DA_METODOLOGIA.conteudo)).toBe(true);
  });

  it("só semeia uma vez: o que o time exclui não volta", async () => {
    await admin(() => garantirModelosIniciais());
    const bant = (await admin(() => listarMetodologias())).find((m) => m.nome === "BANT")!;
    await admin(() => excluirMetodologia(bant.id));
    await admin(() => garantirModelosIniciais());
    await admin(() => garantirModelosIniciais());
    expect((await admin(() => listarMetodologias())).map((m) => m.nome).sort()).toEqual(["Consultiva", "SPIN Selling"]);
  });

  it("chamadas ao mesmo tempo não duplicam", async () => {
    await Promise.all([1, 2, 3, 4].map(() => admin(() => garantirModelosIniciais())));
    expect(await admin(() => listarMetodologias())).toHaveLength(3);
  });

  it("time que já criou as suas antes não ganha os modelos", async () => {
    await admin(() => criarMetodologia({ nome: "Minha", finalidade: "agente_fluxo", conteudo: "Seja direto." }));
    await admin(() => garantirModelosIniciais());
    expect((await admin(() => listarMetodologias())).map((m) => m.nome)).toEqual(["Minha"]);
  });
});

describe("criar, editar e padrão por finalidade", () => {
  it("a finalidade é obrigatória e válida; a primeira de uma finalidade já nasce padrão", async () => {
    await expect(admin(() => criarMetodologia({ nome: "X", finalidade: "qualquer", conteudo: "texto" }))).rejects.toThrow(/Escolha para que serve/);
    const a = await admin(() => criarMetodologia({ nome: "Do assistente", finalidade: "assistente_chat", conteudo: "Sugira o próximo passo." }));
    expect(a).toMatchObject({ finalidade: "assistente_chat", padrao: true });
    const b = await admin(() => criarMetodologia({ nome: "Outra do assistente", finalidade: "assistente_chat", conteudo: "Seja breve." }));
    expect(b.padrao).toBe(false);
  });

  it("nome e texto são obrigatórios, com limites", async () => {
    await expect(admin(() => criarMetodologia({ nome: "  ", finalidade: "agente_fluxo", conteudo: "x" }))).rejects.toThrow(/nome/);
    await expect(admin(() => criarMetodologia({ nome: "X", finalidade: "agente_fluxo", conteudo: "  " }))).rejects.toThrow(/Escreva como o agente/);
    await expect(admin(() => criarMetodologia({ nome: "X", finalidade: "agente_fluxo", conteudo: "a".repeat(LIMITES_DA_METODOLOGIA.conteudo + 1) }))).rejects.toThrow(/Encurte/);
  });

  it("definir padrão troca a anterior na mesma finalidade e não mexe nas outras", async () => {
    await admin(() => garantirModelosIniciais());
    const lista = await admin(() => listarMetodologias());
    const spin = lista.find((m) => m.nome === "SPIN Selling")!;
    const bant = lista.find((m) => m.nome === "BANT")!;
    const chat = await admin(() => criarMetodologia({ nome: "Chat", finalidade: "assistente_chat", conteudo: "Aconselhe." }));
    const r = await admin(() => definirPadrao(bant.id));
    expect(r.padrao).toBe(true);
    const depois = await admin(() => listarMetodologias());
    expect(depois.filter((m) => m.finalidade === "agente_fluxo" && m.padrao).map((m) => m.id)).toEqual([bant.id]);
    expect(depois.find((m) => m.id === spin.id)!.padrao).toBe(false);
    expect(depois.find((m) => m.id === chat.id)!.padrao).toBe(true);
  });

  it("o banco recusa duas padrão na mesma finalidade (índice único parcial)", async () => {
    await admin(() => garantirModelosIniciais());
    const [bant] = (await admin(() => listarMetodologias())).filter((m) => m.nome === "BANT");
    await expect(basePrisma.methodology.update({ where: { id: bant!.id }, data: { padrao: true } })).rejects.toThrow();
  });

  it("edita nome, descrição e texto; excluir a padrão deixa a finalidade sem padrão", async () => {
    await admin(() => garantirModelosIniciais());
    const spin = (await admin(() => listarMetodologias())).find((m) => m.padrao)!;
    const r = await admin(() => atualizarMetodologia(spin.id, { nome: "SPIN da casa", descricao: "  ajustado ", conteudo: "Novo texto." }));
    expect(r).toMatchObject({ nome: "SPIN da casa", descricao: "ajustado", conteudo: "Novo texto." });
    await admin(() => excluirMetodologia(spin.id));
    expect((await admin(() => listarMetodologias())).some((m) => m.padrao)).toBe(false);
    await expect(admin(() => excluirMetodologia(spin.id))).rejects.toThrow(/Não achei/);
  });

  it("no máximo 30 por time", async () => {
    await basePrisma.methodology.createMany({
      data: Array.from({ length: LIMITES_DA_METODOLOGIA.porTime }, (_, i) => ({ teamId: TEAM, nome: `M${i}`, finalidade: "agente_fluxo", conteudo: "x" })),
    });
    await expect(admin(() => criarMetodologia({ nome: "Mais uma", finalidade: "agente_fluxo", conteudo: "x" }))).rejects.toThrow(/limite é de 30/);
  });
});

describe("papéis e isolamento entre times", () => {
  it("só administrador escreve; membro e leitor são negados", async () => {
    await admin(() => garantirModelosIniciais());
    const m = (await admin(() => listarMetodologias()))[0]!;
    for (const papel of ["member", "viewer"]) {
      await expect(comPapel(papel, () => criarMetodologia({ nome: "X", finalidade: "agente_fluxo", conteudo: "y" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(comPapel(papel, () => atualizarMetodologia(m.id, { nome: "Z" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(comPapel(papel, () => definirPadrao(m.id))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(comPapel(papel, () => excluirMetodologia(m.id))).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await comPapel("viewer", () => listarMetodologias())).toHaveLength(3);
  });

  it("dois times: um não vê, não edita, não torna padrão e não exclui a do outro", async () => {
    await admin(() => garantirModelosIniciais());
    const m = (await admin(() => listarMetodologias())).find((x) => !x.padrao)!;
    expect(await admin(() => listarMetodologias(), OUTRO)).toHaveLength(0);
    await expect(admin(() => atualizarMetodologia(m.id, { nome: "Roubada" }), OUTRO)).rejects.toThrow(/Não achei/);
    await expect(admin(() => definirPadrao(m.id), OUTRO)).rejects.toThrow(/Não achei/);
    await expect(admin(() => excluirMetodologia(m.id), OUTRO)).rejects.toThrow(/Não achei/);
    expect(await comoSistema(() => metodologiaParaIa("agente_fluxo", m.id), OUTRO)).toMatchObject({ nome: expect.any(String) }); // cria os do OUTRO, e nunca o id do TEAM
    expect((await comoSistema(() => metodologiaParaIa("agente_fluxo", m.id), OUTRO))!.id).not.toBe(m.id);
  });
});

describe("leitura pela IA", () => {
  it("sem escolha, vale a padrão da finalidade (e o time recebe os modelos sozinho no primeiro uso)", async () => {
    const m = await comoSistema(() => metodologiaParaIa("agente_fluxo"));
    expect(m?.nome).toBe("SPIN Selling");
    expect(m?.conteudo).toContain("Situação");
  });

  it("escolhida pelo id; id que não existe mais cai na padrão; 'nenhuma' desliga", async () => {
    await admin(() => garantirModelosIniciais());
    const bant = (await admin(() => listarMetodologias())).find((x) => x.nome === "BANT")!;
    expect((await comoSistema(() => metodologiaParaIa("agente_fluxo", bant.id)))?.nome).toBe("BANT");
    expect((await comoSistema(() => metodologiaParaIa("agente_fluxo", "id-que-sumiu")))?.nome).toBe("SPIN Selling");
    expect(await comoSistema(() => metodologiaParaIa("agente_fluxo", SEM_METODOLOGIA))).toBeNull();
  });

  it("uma metodologia de outra finalidade não vale para o agente", async () => {
    await admin(() => garantirModelosIniciais());
    const chat = await admin(() => criarMetodologia({ nome: "Chat", finalidade: "assistente_chat", conteudo: "Aconselhe." }));
    expect((await comoSistema(() => metodologiaParaIa("agente_fluxo", chat.id)))?.nome).toBe("SPIN Selling");
    expect((await comoSistema(() => metodologiaParaIa("assistente_chat")))?.nome).toBe("Chat");
  });

  it("depois de editar, a IA lê o texto novo (o cache do processo é invalidado)", async () => {
    await admin(() => garantirModelosIniciais());
    const spin = (await admin(() => listarMetodologias())).find((m) => m.padrao)!;
    expect((await comoSistema(() => metodologiaParaIa("agente_fluxo")))?.conteudo).toContain("Situação");
    await admin(() => atualizarMetodologia(spin.id, { conteudo: "Texto novo e curto." }));
    expect((await comoSistema(() => metodologiaParaIa("agente_fluxo")))?.conteudo).toBe("Texto novo e curto.");
  });

  it("sem time no contexto, devolve nada (fail-closed)", async () => {
    expect(await metodologiaParaIa("agente_fluxo")).toBeNull();
  });
});
