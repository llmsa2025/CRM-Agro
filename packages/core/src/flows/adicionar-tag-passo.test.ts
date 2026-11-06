import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Passo "Adicionar tag" (incidente de 02/10/2026): a tag precisa existir no catálogo do time e aparecer na barra de
 * Contatos com a contagem certa. Antes o passo só empurrava o texto para `Contact.tags` (campo legado), que a tela
 * não lê. Fila mockada: nada roda de verdade.
 */
vi.mock("./queue", () => ({
  scheduleStep: async () => {},
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
}));

const { executeNode } = await import("./executor");
const { createFlow, activateFlow } = await import("./service");
const { PROFUNDIDADE_MAX } = await import("./limites");
const tags = await import("../tags/index");
const contatos = await import("../contacts/index");

const TEAM = "00000000-0000-0000-0000-0000000e0011";
const OUTRO = "00000000-0000-0000-0000-0000000e0012";
const TIMES = [TEAM, OUTRO];

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team add_tag (test)"], [OUTRO, "Outro team add_tag (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
});

async function limpar() {
  const w = { teamId: { in: TIMES } };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contactTag.deleteMany({ where: w });
  await basePrisma.tag.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
}
beforeEach(limpar);
afterAll(limpar);

const contato = async (teamId = TEAM, extra: { tags?: string[] } = {}) => (await basePrisma.contact.create({ data: { teamId, nome: "Lead", tags: extra.tags ?? [] } })).id;

/** Roda o passo "Adicionar tag" como o worker roda. */
async function adicionar(contactId: string, tag: string, opts: { teamId?: string; profundidade?: number } = {}) {
  const teamId = opts.teamId ?? TEAM;
  const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } });
  return runWithTeam(teamId, () =>
    executeNode(
      { id: "e", teamId, contactId, lastOutboundAt: null, contact: { id: c.id, nome: c.nome, tags: c.tags, ownerId: null }, profundidade: opts.profundidade ?? 0 },
      { id: "t", tipo: "add_tag", config: { tag }, nextNodeId: "fim" } as never,
    ),
  );
}

describe("o passo cria a tag no catálogo e a tela de Contatos a enxerga", () => {
  it("aparece na barra com a contagem, no filtro e na linha do contato", async () => {
    const com = [await contato(), await contato(), await contato()];
    await contato();
    await contato(); // dois contatos ficam sem tag

    for (const id of com) {
      const r = await adicionar(id, "Tem WhatsApp");
      expect(r).toMatchObject({ nextNodeId: "fim" });
    }

    const resumo = await runWithTeam(TEAM, () => tags.tagFilterSummary());
    expect(resumo.total).toBe(5);
    expect(resumo.semTag).toBe(2);
    expect(resumo.tags).toEqual([expect.objectContaining({ nome: "Tem WhatsApp", count: 3 })]);

    const tagId = resumo.tags[0]!.id;
    const filtrados = await runWithTeam(TEAM, () => contatos.list({ tag: tagId }));
    expect(filtrados.items.map((c) => c.id).sort()).toEqual([...com].sort());
    expect(filtrados.items[0]!.contactTags[0]!.tag.nome).toBe("Tem WhatsApp");
    expect(await runWithTeam(TEAM, () => contatos.count({ tag: tagId }))).toBe(3);
  });

  it("o resultado do passo diz o que aconteceu (criou, adicionou, já tinha)", async () => {
    const a = await contato();
    const b = await contato();
    expect((await adicionar(a, "Lead quente")).motivo).toMatch(/criada no catálogo/);
    expect((await adicionar(b, "Lead quente")).motivo).toBe('Tag "Lead quente" adicionada ao contato');
    expect((await adicionar(b, "Lead quente")).motivo).toBe('O contato já tinha a tag "Lead quente"');
  });

  it("repetir o passo no mesmo contato não duplica nada", async () => {
    const id = await contato();
    await adicionar(id, "VIP");
    await adicionar(id, "VIP");
    expect(await basePrisma.tag.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await basePrisma.contactTag.count({ where: { teamId: TEAM, contactId: id } })).toBe(1);
  });

  it("o campo antigo (Contact.tags) continua gravado, sem repetir", async () => {
    const id = await contato();
    await adicionar(id, "VIP");
    await adicionar(id, "vip");
    expect((await basePrisma.contact.findUniqueOrThrow({ where: { id } })).tags).toEqual(["VIP"]);
  });
});

describe("sem duplicar a tag", () => {
  it("caixa, acento e espaço sobrando são a mesma tag", async () => {
    for (const nome of ["Cliente Prioritário", "cliente prioritario", "CLIENTE   PRIORITÁRIO ", "  Cliente Prioritario"]) {
      await adicionar(await contato(), nome);
    }
    const lista = await runWithTeam(TEAM, () => tags.listTags());
    expect(lista).toEqual([expect.objectContaining({ nome: "Cliente Prioritário", count: 4 })]);
  });

  it("20 passos ao mesmo tempo com a mesma tag nova: uma tag só e 20 vínculos", async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => contato()));
    await Promise.all(ids.map((id) => adicionar(id, "Lista de maio")));
    expect(await basePrisma.tag.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await basePrisma.contactTag.count({ where: { teamId: TEAM } })).toBe(20);
  });

  it("usa a tag que já existe no catálogo (criada à mão), com a cor dela", async () => {
    const feita = await runWithTeam(TEAM, () => tags.createTag({ nome: "Quente", cor: "amber" }));
    const id = await contato();
    await adicionar(id, "quente");
    const lista = await runWithTeam(TEAM, () => tags.listTags());
    expect(lista).toEqual([expect.objectContaining({ id: feita.id, nome: "Quente", cor: "amber", count: 1 })]);
  });

  it("o mesmo nome em outro time é outra tag (isolamento)", async () => {
    await adicionar(await contato(TEAM), "VIP");
    await adicionar(await contato(OUTRO), "VIP", { teamId: OUTRO });
    expect(await basePrisma.tag.count({ where: { teamId: TEAM } })).toBe(1);
    expect(await basePrisma.tag.count({ where: { teamId: OUTRO } })).toBe(1);
    expect((await runWithTeam(OUTRO, () => tags.listTags())).map((t) => t.count)).toEqual([1]);
  });

  it("nome com mais de 40 caracteres é cortado no limite do cadastro; nome vazio não cria nada", async () => {
    await adicionar(await contato(), "x".repeat(60));
    expect((await basePrisma.tag.findFirstOrThrow({ where: { teamId: TEAM } })).nome).toHaveLength(40);
    await expect(adicionar(await contato(), "   ")).rejects.toThrow(/TagNomeVazio/);
    expect(await basePrisma.tag.count({ where: { teamId: TEAM } })).toBe(1);
  });
});

describe("não tira o que o contato já tem", () => {
  it("a tag da lista de origem fica, a nova entra, e a linha mostra a mais recente", async () => {
    const id = await contato();
    const lista = await runWithTeam(TEAM, () => tags.createTag({ nome: "Lista soja" }));
    await runWithTeam(TEAM, () => tags.setContactTag(id, lista.id));
    await adicionar(id, "Tem WhatsApp");

    const resumo = await runWithTeam(TEAM, () => tags.tagFilterSummary());
    expect(Object.fromEntries(resumo.tags.map((t) => [t.nome, t.count]))).toEqual({ "Lista soja": 1, "Tem WhatsApp": 1 });
    expect(resumo.semTag).toBe(0);
    const linha = (await runWithTeam(TEAM, () => contatos.list())).items.find((c) => c.id === id)!;
    expect(linha.contactTags.map((c) => c.tag.nome)).toEqual(["Tem WhatsApp", "Lista soja"]);
  });
});

describe("condição 'tem a tag'", () => {
  const condicao = { id: "c", tipo: "condition", branches: { branches: [{ id: "b", label: "tem", condition: { type: "tag_present", tag: "tem whatsapp" }, nextNodeId: "sim" }], default: "nao" } } as never;
  const decidir = async (contactId: string) => {
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    return (
      await runWithTeam(TEAM, () =>
        executeNode({ id: "e", teamId: TEAM, contactId, lastOutboundAt: null, contact: { id: c.id, nome: c.nome, tags: c.tags, ownerId: null } } as never, condicao),
      )
    ).nextNodeId;
  };

  it("enxerga a tag do catálogo (qualquer caixa e acento) e a do campo antigo", async () => {
    const dado = await contato();
    await adicionar(dado, "Tem WhatsApp");
    expect(await decidir(dado)).toBe("sim");
    expect(await decidir(await contato(TEAM, { tags: ["TEM WHATSAPP"] }))).toBe("sim"); // só no campo antigo
    expect(await decidir(await contato())).toBe("nao");
  });
});

describe("gatilho 'tag adicionada'", () => {
  async function fluxoDaTag(tagNome: string) {
    const tag = await runWithTeam(TEAM, () => tags.createTag({ nome: tagNome }));
    const f = await runWithTeam(TEAM, () =>
      createFlow({ nome: "Da tag", triggerType: "tag_added", triggerConfig: { tagId: tag.id }, nodes: [{ id: "w1", tipo: "wait", config: { duration: 1, unit: "min" }, nextNodeId: null }] as never }),
    );
    await runWithTeam(TEAM, () => activateFlow(f.id));
    return f.id;
  }

  it("a tag adicionada por um passo inscreve o contato no fluxo dessa tag, como a atribuição manual", async () => {
    const flowId = await fluxoDaTag("Qualificado");
    const id = await contato();
    await adicionar(id, "qualificado");
    expect(await basePrisma.enrollment.count({ where: { flowId, contactId: id } })).toBe(1);
    await adicionar(id, "Qualificado"); // já tinha: não inscreve de novo
    expect(await basePrisma.enrollment.count({ where: { flowId, contactId: id } })).toBe(1);
  });

  it("o limite de cascata do motor vale: passo na profundidade máxima não dispara outro fluxo", async () => {
    const flowId = await fluxoDaTag("Qualificado");
    const id = await contato();
    await adicionar(id, "Qualificado", { profundidade: PROFUNDIDADE_MAX });
    expect(await basePrisma.enrollment.count({ where: { flowId, contactId: id } })).toBe(0);
    expect(await basePrisma.contactTag.count({ where: { teamId: TEAM, contactId: id } })).toBe(1); // a tag entrou mesmo assim
  });
});
