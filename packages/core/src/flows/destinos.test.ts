import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Condição com vários destinos na mesma saída (todos ao mesmo tempo, cada um como um ramo = inscrição filha) e o passo
 * "Enriquecer dados". Fila e consulta de CNPJ MOCKADAS; contatos descartáveis.
 */
const agendados = vi.hoisted(() => [] as unknown[][]);
vi.mock("./queue", () => ({
  scheduleStep: async (...a: unknown[]) => {
    agendados.push(a);
  },
  acordarPasso: async () => {},
  flowJobId: (e: string, n: string, r: number) => `${e}:${n}:${r}`,
  getStepJobState: async () => null,
  removeStepJob: async () => {},
  getFlowQueue: () => ({}),
}));
const cnpjMock = vi.hoisted(() => ({ falha: false }));
vi.mock("../captacao/cnpj", async (importOriginal) => {
  const real = await importOriginal<typeof import("../captacao/cnpj")>();
  return {
    ...real,
    consultarCnpj: async () => {
      if (cnpjMock.falha) throw new Error("fora do ar");
      return { ie: "123456789", email: "contato@agro.com", telefone: "6633337703", endereco: "Rua A, 10", cidade: "Sorriso", uf: "MT", nomeFantasia: null, cnae: "0115600", cnaesSecundarios: [], ies: [] };
    },
  };
});

const { concluirPasso, MAX_RAMOS_POR_INSCRICAO } = await import("./avanco");
const { executeNode } = await import("./executor");
const { destinosDoNo, referenciasPendentes } = await import("./snapshot");
const { findStartNode } = await import("./triggers");
const { enriquecerContatoDoFluxo } = await import("./enriquecer-dados");

const TEAM = "00000000-0000-0000-0000-0000000000d6";
let flowId = "";
let contatoId = "";

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Team destinos e enriquecimento" } });
});
const limpar = async () => {
  const w = { teamId: TEAM };
  await basePrisma.flowStepExecution.deleteMany({ where: w });
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.deal.deleteMany({ where: w });
  await basePrisma.stage.deleteMany({ where: w });
  await basePrisma.funnel.deleteMany({ where: w });
  await basePrisma.contactCompany.deleteMany({ where: w });
  await basePrisma.company.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
};
beforeEach(async () => {
  cnpjMock.falha = false;
  agendados.length = 0;
  await limpar();
  flowId = (await basePrisma.flow.create({ data: { teamId: TEAM, nome: "F", triggerType: "manual", status: "active" } })).id;
  contatoId = (await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } })).id;
});
afterAll(limpar);

const enr = (tags: string[]) => ({ id: "enr-x", teamId: TEAM, contactId: contatoId, lastOutboundAt: null, round: 1, contact: { id: contatoId, nome: "Lead", tags, ownerId: null, relacionamentoStatus: "novo" } }) as never;
const condicao = (extra: object = {}) =>
  ({
    id: "c",
    tipo: "condition",
    branches: { branches: [{ id: "b1", label: "Sim", condition: { type: "tag_present", tag: "x" }, nextNodeId: "A", ...extra }], default: "D", defaultMais: ["E"] },
  }) as never;

describe("condição com vários destinos", () => {
  it("devolve todos os destinos da saída que casou, na ordem; sem 'mais' fica como antes", async () => {
    // `escolha` é o que o log do fluxo mostra (saída que casou, ou "senão").
    const casou = { tipo: "condicao", saida: "Sim", senao: false, testadas: ["Sim"] };
    const senao = { tipo: "condicao", saida: "senão", senao: true, testadas: ["Sim"] };
    expect(await runWithTeam(TEAM, () => executeNode(enr(["x"]), condicao({ maisDestinos: ["B", "C"] })))).toEqual({ nextNodeId: "A", nextNodeIds: ["A", "B", "C"], escolha: casou });
    expect(await runWithTeam(TEAM, () => executeNode(enr(["x"]), condicao()))).toEqual({ nextNodeId: "A", escolha: casou });
    expect(await runWithTeam(TEAM, () => executeNode(enr([]), condicao()))).toEqual({ nextNodeId: "D", nextNodeIds: ["D", "E"], escolha: senao }); // o "senão" também aceita vários
  });

  const inscricao = async (nodeId = "c") => {
    const e = await basePrisma.enrollment.create({ data: { teamId: TEAM, flowId, contactId: contatoId, currentNodeId: nodeId, currentRound: 1, status: "active", nextRunAt: new Date(), stepNumber: 3, lastOutboundAt: new Date(1_700_000_000_000), profundidade: 1 } });
    await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: e.id, nodeId, round: 1, status: "running" } });
    return e;
  };
  const concluir = (enrollmentId: string, nodeId: string, result: object) => runWithTeam(TEAM, () => concluirPasso({ enrollmentId, nodeId, round: 1, result: result as never }));

  it("cada destino extra vira um ramo (inscrição filha) que começa ao mesmo tempo; o primeiro segue na inscrição", async () => {
    const e = await inscricao();
    const prox = await concluir(e.id, "c", { nextNodeId: "A", nextNodeIds: ["A", "B", "C"] });
    expect(prox).toMatchObject({ nodeId: "A", round: 1 });
    const pai = await basePrisma.enrollment.findUniqueOrThrow({ where: { id: e.id } });
    expect(pai).toMatchObject({ currentNodeId: "A", status: "active", paiId: null });
    const ramos = await basePrisma.enrollment.findMany({ where: { paiId: e.id }, orderBy: { currentNodeId: "asc" } });
    expect(ramos.map((r) => [r.currentNodeId, r.status, r.currentRound])).toEqual([["B", "active", 1], ["C", "active", 1]]);
    for (const r of ramos) expect(r).toMatchObject({ flowId, contactId: contatoId, stepNumber: 4, profundidade: 1, teamId: TEAM });
    expect(ramos[0]!.lastOutboundAt?.getTime()).toBe(1_700_000_000_000); // a condição "respondeu?" do ramo olha o mesmo último envio
    expect(agendados.map((a) => [a[1], a[2]]).sort()).toEqual([["B", 1], ["C", 1]]); // os ramos são agendados; o 1º é agendado por quem chamou
  });

  it("os ramos são independentes: o fim de um caminho não encerra os outros; ramo de ramo aponta para a origem", async () => {
    const e = await inscricao();
    await concluir(e.id, "c", { nextNodeId: "A", nextNodeIds: ["A", "B"] });
    await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: e.id, nodeId: "A", round: 1, status: "running" } });
    expect(await concluir(e.id, "A", { nextNodeId: null })).toBeNull();
    expect((await basePrisma.enrollment.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("done");
    const b = await basePrisma.enrollment.findFirstOrThrow({ where: { paiId: e.id } });
    expect(b.status).toBe("active");
    // o ramo B também ramifica: os novos ramos apontam para a inscrição de ORIGEM, não para o ramo
    await basePrisma.flowStepExecution.create({ data: { teamId: TEAM, enrollmentId: b.id, nodeId: "B", round: 1, status: "running" } });
    await concluir(b.id, "B", { nextNodeId: "B1", nextNodeIds: ["B1", "B2"] });
    expect(await basePrisma.enrollment.count({ where: { paiId: e.id } })).toBe(2);
    expect((await basePrisma.enrollment.findFirstOrThrow({ where: { paiId: e.id, currentNodeId: "B2" } })).id).not.toBe(b.id);
  });

  it("passou do teto de ramos: não cria os extras, e a inscrição segue no primeiro", async () => {
    const e = await inscricao();
    const muitos = Array.from({ length: MAX_RAMOS_POR_INSCRICAO + 2 }, (_, i) => `N${i}`);
    expect(await concluir(e.id, "c", { nextNodeId: muitos[0], nextNodeIds: muitos })).toMatchObject({ nodeId: "N0" });
    expect(await basePrisma.enrollment.count({ where: { paiId: e.id } })).toBe(0);
  });

  it("passo que já não é o do ponteiro não cria ramo (compare-and-set)", async () => {
    const e = await inscricao();
    await basePrisma.enrollment.update({ where: { id: e.id }, data: { currentNodeId: "outro" } });
    expect(await concluir(e.id, "c", { nextNodeId: "A", nextNodeIds: ["A", "B"] })).toBeNull();
    expect(await basePrisma.enrollment.count({ where: { paiId: e.id } })).toBe(0);
  });

  it("os destinos extras contam como 'tem entrada' (não viram início) e seta solta neles é recusada", () => {
    const nos = [
      { id: "c", tipo: "condition", branches: { branches: [{ id: "b1", nextNodeId: "A", maisDestinos: ["B"] }], default: "D", defaultMais: ["E"] } },
      { id: "A", tipo: "wait", nextNodeId: null },
      { id: "B", tipo: "wait", nextNodeId: null },
      { id: "D", tipo: "wait", nextNodeId: null },
      { id: "E", tipo: "wait", nextNodeId: null },
    ];
    expect(destinosDoNo(nos[0]!)).toEqual(["A", "B", "D", "E"]);
    expect(findStartNode(nos as never, nos)?.id).toBe("c");
    expect(referenciasPendentes(nos.slice(0, 3))).toEqual(expect.arrayContaining([{ de: "c", para: "D" }, { de: "c", para: "E" }]));
  });
});

describe("passo Enriquecer dados", () => {
  const empresa = async (cnpj: string | null) => {
    const c = await basePrisma.company.create({ data: { teamId: TEAM, nome: "Agro Lima", cnpj } });
    await basePrisma.contactCompany.create({ data: { teamId: TEAM, contactId: contatoId, companyId: c.id, papel: "dono" } });
    return c.id;
  };
  const rodar = () => runWithTeam(TEAM, () => enriquecerContatoDoFluxo(contatoId));

  it("sem empresa ou sem CNPJ pula e diz o motivo", async () => {
    expect(await rodar()).toEqual({ skipped: true, motivo: "Sem empresa cadastrada para consultar" });
    await empresa(null);
    expect((await rodar()).motivo).toMatch(/Nenhuma empresa com CNPJ/);
  });

  it("com CNPJ preenche só o que está vazio (IE, e-mail, telefone, cidade...) e não troca o que já tem", async () => {
    const id = await empresa("01234567000195");
    await basePrisma.company.update({ where: { id }, data: { email: "meu@email.com" } });
    const r = await rodar();
    expect(r.skipped).toBe(false);
    expect(r.motivo).toMatch(/^Preencheu \d+ campo\(s\)/);
    const c = await basePrisma.company.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ ie: "123456789", email: "meu@email.com", cidade: "Sorriso", estado: "MT", cnae: "0115600" });
    expect((await rodar()).motivo).toBe("1 CNPJ consultado(s), nada novo para preencher");
  });

  it("consulta que não responde pula (não trava a inscrição)", async () => {
    await empresa("01234567000195");
    cnpjMock.falha = true;
    expect(await rodar()).toEqual({ skipped: true, motivo: "A consulta de CNPJ não respondeu agora" });
  });
});

describe("passo Criar card depois de enriquecer", () => {
  const funil = async (nome: string) => {
    const f = await basePrisma.funnel.create({ data: { teamId: TEAM, nome, tipo: "vendas" } });
    const e = await basePrisma.stage.create({ data: { teamId: TEAM, funnelId: f.id, nome: "Novo", ordem: 0 } });
    return { funnelId: f.id, stageId: e.id };
  };
  const criarCard = (cfg: { funnelId: string; stageId: string }) => runWithTeam(TEAM, () => executeNode(enr([]), { id: "d", tipo: "create_deal", config: cfg, nextNodeId: "x" } as never));

  it("cria o card se o contato ainda não tem card aberto no funil; passar de novo não duplica; outro funil cria", async () => {
    const a = await funil("Vendas");
    expect(await criarCard(a)).toEqual({ nextNodeId: "x", motivo: "Card criado no funil" });
    expect(await criarCard(a)).toEqual({ nextNodeId: "x", motivo: "Já tinha card aberto neste funil, não criou outro" });
    expect(await basePrisma.deal.count({ where: { contactId: contatoId, funnelId: a.funnelId } })).toBe(1);
    const b = await funil("Pós-venda");
    expect((await criarCard(b)).motivo).toBe("Card criado no funil");
    expect(await basePrisma.deal.count({ where: { contactId: contatoId } })).toBe(2);
  });
});

