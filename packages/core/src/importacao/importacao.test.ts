import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basePrisma, runAsSystem } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Importação em 4 passos (produto §C) — commit + worker. Storage, fila e tempo
 * real mockados (nada sai do processo); banco e Redis de TESTE. Planilhas
 * geradas aqui.
 */

// Storage privado em memória.
const storage = new Map<string, Uint8Array>();
vi.mock("../storage/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/service")>()),
  storageEnabled: () => true,
  uploadMedia: async (path: string, bytes: Uint8Array) => void storage.set(path, bytes),
  baixarArquivo: async (path: string) => {
    const b = storage.get(path);
    if (!b) throw new Error(`sem arquivo ${path}`);
    return b;
  },
  deleteMedia: async (path: string) => void storage.delete(path),
}));
const enfileirados: { teamId: string; importJobId: string }[] = [];
vi.mock("./fila", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fila")>()),
  enfileirarImportacao: async (job: { teamId: string; importJobId: string }) => void enfileirados.push(job),
}));
const eventos: { event: { type: string; processadas?: number; status?: string; criadas?: number; importJobId?: string }; teamId?: string }[] = [];
vi.mock("../events/redis-bus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../events/redis-bus")>()),
  publishRealtime: (event: (typeof eventos)[number]["event"], teamId?: string) => void eventos.push({ event, teamId }),
}));
// Gancho depois de cada bloco gravado (o teste de cancelar usa para cancelar "no meio").
let aposBloco: () => Promise<void> = async () => {};
vi.mock("../contacts/write", async (importOriginal) => {
  const original = await importOriginal<typeof import("../contacts/write")>();
  return {
    ...original,
    writeContactsEmLote: async (...args: Parameters<typeof original.writeContactsEmLote>) => {
      const r = await original.writeContactsEmLote(...args);
      await aposBloco();
      return r;
    },
  };
});
const scheduleStep = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../flows/queue", () => ({ scheduleStep: (...a: unknown[]) => scheduleStep(...a), getFlowQueue: () => ({}) }));

const { commitImport, getImportJob, cancelImport, listImportJobs } = await import("./jobs");
const { processarImportacao, TravaDaImportacaoPerdida } = await import("./processar");
const { previewImport } = await import("./service");
const { ImportJobNotFound } = await import("./errors");
const { ForbiddenError } = await import("../auth/authz");
const { redisEstado } = await import("../shared/redis-cache");

const TEAM_A = "00000000-0000-0000-0000-0000000001a9";
const TEAM_B = "00000000-0000-0000-0000-0000000001aa";
const TIMES = [TEAM_A, TEAM_B];

async function limpar() {
  const where = { teamId: { in: TIMES } };
  await basePrisma.importJob.deleteMany({ where });
  await basePrisma.enrollment.deleteMany({ where });
  await basePrisma.flowNode.deleteMany({ where });
  await basePrisma.flow.deleteMany({ where });
  await basePrisma.channelIdentifier.deleteMany({ where });
  await basePrisma.contactCompany.deleteMany({ where });
  await basePrisma.contactTag.deleteMany({ where });
  await basePrisma.tag.deleteMany({ where });
  await basePrisma.contact.deleteMany({ where });
  await basePrisma.company.deleteMany({ where });
  for (const t of TIMES) await redisEstado().del(`import:trava:${t}`);
}

beforeAll(async () => {
  for (const [id, name] of [
    [TEAM_A, "Time A (agente A — importação worker)"],
    [TEAM_B, "Time B (agente A — importação worker)"],
  ] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});
beforeEach(async () => {
  storage.clear();
  enfileirados.length = 0;
  eventos.length = 0;
  aposBloco = async () => {};
  scheduleStep.mockClear();
  await limpar();
});
afterAll(limpar);

const cel = (n: number) => {
  const d = String(90_000_000 + n).padStart(8, "0");
  return `(65) 9${d.slice(0, 4)}-${d.slice(4)}`;
};
const e164 = (n: number) => `+55659${String(90_000_000 + n).padStart(8, "0")}`;
const MAPA_MOCKUP = ["nome", "whatsapp", "email", "empresa", "cidade", "estado", "tags", null];

async function contato(teamId: string, dados: { nome: string; cidade?: string; tags?: string[] }, idents: { whatsapp?: string; email?: string }) {
  const c = await basePrisma.contact.create({ data: { teamId, nome: dados.nome, cidade: dados.cidade, tags: dados.tags ?? [] } });
  const rows = [
    ...(idents.whatsapp ? [{ teamId, contactId: c.id, canal: "whatsapp" as const, valor: idents.whatsapp, isPrimary: true }] : []),
    ...(idents.email ? [{ teamId, contactId: c.id, canal: "email" as const, valor: idents.email, isPrimary: true }] : []),
  ];
  if (rows.length) await basePrisma.channelIdentifier.createMany({ data: rows });
  return c.id;
}

/** A planilha do mockup (201 novos · 18 já existem · 9 repetidos · 8 inválidos). */
async function planilhaDoMockup() {
  for (let i = 0; i < 12; i++) {
    await contato(TEAM_A, { nome: `Existente ${i}`, cidade: i === 0 ? "Lucas" : undefined, tags: ["antigo"] }, { whatsapp: e164(5000 + i) });
  }
  for (let i = 0; i < 6; i++) await contato(TEAM_A, { nome: `Existente mail ${i}` }, { email: `existe${i}@agro.com.br` });
  const linhas: string[] = [];
  for (let i = 0; i < 201; i++) {
    const tel = i < 191 ? cel(i) : "";
    const mail = i >= 191 || i % 3 === 0 ? `novo${i}@agro.com.br` : "";
    linhas.push(`Novo ${i};${tel};${mail};Fazenda ${i};Tapurah;MT;soja;${i * 10}`);
  }
  for (let i = 0; i < 12; i++) linhas.push(`Já ${i};${cel(5000 + i)};ja${i}@agro.com.br;;Sorriso;MT;milho;`);
  for (let i = 0; i < 6; i++) linhas.push(`Já mail ${i};${cel(6000 + i)};EXISTE${i}@AGRO.COM.BR;;;;;`);
  for (let i = 1; i <= 9; i++) linhas.push(`Novo ${i} de novo;${cel(i)};rep${i}@agro.com.br;;;;algodão;`);
  for (let i = 0; i < 5; i++) linhas.push(`Quebrado ${i};(65) 3382-1${i};;;;;;`);
  linhas.push(`;${cel(7000)};;;;;;`, `;;sem-nome@agro.com.br;;;;;`, `E-mail ruim;;nao-e-email;;;;;`);
  return ["Produtor;Celular;E-mail;Fazenda;Município;UF;Cultura;Área (ha)", ...linhas].join("\n");
}

async function fluxoContactCreated(teamId: string) {
  const flow = await basePrisma.flow.create({ data: { teamId, nome: "Boas-vindas", triggerType: "contact_created", status: "active" } });
  await basePrisma.flowNode.create({ data: { teamId, flowId: flow.id, tipo: "notify_user" as never, config: {} as never } });
}

const processar = (teamId: string, importJobId: string) => runAsSystem(teamId, () => processarImportacao({ teamId, importJobId }));

describe("commitImport + worker", () => {
  it("planilha do mockup ponta a ponta: contagens iguais às da prévia, existentes completados, gatilho em lote", async () => {
    const texto = await planilhaDoMockup();
    await fluxoContactCreated(TEAM_A);

    const previa = await runWithTeam(TEAM_A, async () => previewImport({ texto }));
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "produtores-parecis.xlsx", mapeamento: MAPA_MOCKUP }));
    expect(job).toMatchObject({ status: "queued", total: 236, processadas: 0, nomeArquivo: "produtores-parecis.xlsx" });
    // Arquivo no Storage privado, na pasta do time; job na fila com o time.
    expect([...storage.keys()]).toEqual([`imports/${TEAM_A}/${job.id}.csv`]);
    expect(enfileirados).toEqual([{ teamId: TEAM_A, importJobId: job.id }]);
    // O commit não gravou contato nenhum.
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(18);

    expect(await processar(TEAM_A, job.id)).toBe("concluido");
    const fim = await runWithTeam(TEAM_A, async () => getImportJob(job.id));
    expect(fim).toMatchObject({ status: "done", total: 236, processadas: 236, criadas: 201, atualizadas: 18, puladas: 9, invalidas: 8 });
    expect({ novos: fim.criadas, jaExistem: fim.atualizadas, repetidos: fim.puladas, invalidos: fim.invalidas }).toEqual(previa.contagens);
    expect(new Set(fim.erros.map((e) => e.motivo))).toEqual(new Set(["Telefone inválido", "Sem nome", "E-mail inválido"]));
    expect(storage.size).toBe(0); // a planilha sai do Storage no fim
    expect(eventos.at(-1)).toMatchObject({ teamId: TEAM_A, event: { type: "import:progress", status: "done", criadas: 201 } });

    // Novos: 201, com a repetida unida (e-mail e tag a mais) e a origem padrão.
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(18 + 201);
    const novo1 = await basePrisma.contact.findFirst({
      where: { teamId: TEAM_A, nome: "Novo 1" },
      select: { tags: true, origem: true, cidade: true, enrichment: true, identifiers: { select: { canal: true, valor: true } } },
    });
    expect(novo1).toMatchObject({ tags: ["soja", "algodão"], origem: "csv", cidade: "Tapurah", enrichment: { provenance: { source: "importacao" } } });
    expect(novo1!.identifiers.map((i) => i.valor).sort()).toEqual([e164(1), "rep1@agro.com.br"].sort());

    // Existentes completados — só o vazio; nada sobrescrito.
    const ex0 = await basePrisma.contact.findFirst({ where: { teamId: TEAM_A, nome: "Existente 0" }, select: { cidade: true, tags: true, identifiers: { select: { valor: true } } } });
    const ex1 = await basePrisma.contact.findFirst({ where: { teamId: TEAM_A, nome: "Existente 1" }, select: { cidade: true, tags: true } });
    expect(ex0).toMatchObject({ cidade: "Lucas", tags: ["antigo", "milho"] });
    expect(ex0!.identifiers.map((i) => i.valor).sort()).toEqual([e164(5000), "ja0@agro.com.br"].sort());
    expect(ex1).toMatchObject({ cidade: "Sorriso", tags: ["antigo", "milho"] });
    // Achado pelo e-mail: ganha o WhatsApp que não tinha.
    const exMail = await basePrisma.contact.findFirst({ where: { teamId: TEAM_A, nome: "Existente mail 0" }, select: { identifiers: { select: { canal: true, valor: true, isPrimary: true } } } });
    expect(exMail!.identifiers).toContainEqual({ canal: "whatsapp", valor: e164(6000), isPrimary: true });

    // As tags da planilha também entram no catálogo (a barra de filtro de Contatos lê de lá), nos criados e nos
    // completados. "antigo" já estava só no campo antigo e a importação não mexe nela.
    const catalogo = await basePrisma.tag.findMany({ where: { teamId: TEAM_A }, select: { id: true, nome: true } });
    expect(catalogo.map((t) => t.nome).sort()).toEqual(["algodão", "milho", "soja"]);
    const vinculos = await basePrisma.contactTag.groupBy({ by: ["tagId"], where: { teamId: TEAM_A }, _count: { _all: true } });
    const contatosPorTag = Object.fromEntries(vinculos.map((v) => [catalogo.find((t) => t.id === v.tagId)!.nome, v._count._all]));
    expect(contatosPorTag).toEqual({ soja: 201, algodão: 9, milho: 12 });

    // contact_created em lote: uma inscrição por NOVO (não pelos existentes).
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM_A } })).toBe(201);
    expect(scheduleStep).toHaveBeenCalledTimes(201);
  });

  it("dois times: o B não vê, não cancela nem processa o job do A; arquivo fora da pasta do time é recusado", async () => {
    const texto = "nome,celular\nAna,(65) 99999-1111\n";
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "a.csv", mapeamento: ["nome", "whatsapp"] }));
    await runWithTeam(TEAM_B, async () => {
      await expect(getImportJob(job.id)).rejects.toBeInstanceOf(ImportJobNotFound);
      await expect(cancelImport(job.id)).rejects.toBeInstanceOf(ImportJobNotFound);
      expect(await listImportJobs()).toEqual([]);
    });
    expect(await processar(TEAM_B, job.id)).toBe("nao_encontrado");
    expect(await basePrisma.importJob.findUnique({ where: { id: job.id }, select: { status: true } })).toEqual({ status: "queued" });

    // Caminho adulterado para a pasta de outro time: falha sem ler.
    await basePrisma.importJob.update({ where: { id: job.id }, data: { arquivoPath: `imports/${TEAM_B}/x.csv` } });
    expect(await processar(TEAM_A, job.id)).toBe("falhou");
    expect(await basePrisma.contact.count({ where: { teamId: { in: TIMES } } })).toBe(0);
  });

  it("cancelar para ENTRE blocos: o 1º bloco fica, o resto não entra", async () => {
    const linhas = Array.from({ length: 1200 }, (_, i) => `Lote ${i},${cel(30_000 + i)}`);
    const job = await runWithTeam(TEAM_A, async () =>
      commitImport({ texto: ["nome,celular", ...linhas].join("\n"), nomeArquivo: "lote.csv", mapeamento: ["nome", "whatsapp"] }),
    );
    // O usuário cancela enquanto o 1º bloco (500) está sendo gravado.
    let blocos = 0;
    aposBloco = async () => {
      if (++blocos === 1) await basePrisma.importJob.updateMany({ where: { id: job.id, status: "processing" }, data: { status: "canceled" } });
    };
    expect(await processar(TEAM_A, job.id)).toBe("cancelado");
    const fim = await runWithTeam(TEAM_A, async () => getImportJob(job.id));
    expect(fim).toMatchObject({ status: "canceled", criadas: 500, processadas: 500 });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(500);
    expect(storage.size).toBe(0);
  });

  it("cancelado na fila não importa nada; viewer não importa nem cancela", async () => {
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto: "nome\nAna\nBeto\n", nomeArquivo: "x.csv", mapeamento: ["nome"] }));
    await expect(
      runWithTeam(TEAM_A, async () => cancelImport(job.id), { userId: randomUUID(), role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      runWithTeam(TEAM_A, async () => commitImport({ texto: "nome\nAna\n", nomeArquivo: "x.csv", mapeamento: ["nome"] }), { userId: randomUUID(), role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect((await runWithTeam(TEAM_A, async () => cancelImport(job.id))).status).toBe("canceled");
    expect(await processar(TEAM_A, job.id)).toBe("cancelado");
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(0);
    expect(storage.size).toBe(0);
  });

  it("uma importação por time por vez; retentativa retoma do último bloco concluído", async () => {
    const linhas = Array.from({ length: 1000 }, (_, i) => `Retoma ${i},${cel(40_000 + i)}`);
    const job = await runWithTeam(TEAM_A, async () =>
      commitImport({ texto: ["nome,celular", ...linhas].join("\n"), nomeArquivo: "r.csv", mapeamento: ["nome", "whatsapp"] }),
    );
    // Outra importação do mesmo time rodando → "ocupado", nada muda.
    await redisEstado().set(`import:trava:${TEAM_A}`, "outro-job", "PX", 60_000);
    expect(await processar(TEAM_A, job.id)).toBe("ocupado");
    expect(await basePrisma.importJob.findUnique({ where: { id: job.id }, select: { status: true } })).toEqual({ status: "queued" });
    await redisEstado().del(`import:trava:${TEAM_A}`);

    // Como se o worker tivesse caído depois do 1º bloco (500 linhas gravadas no job).
    await basePrisma.importJob.update({ where: { id: job.id }, data: { status: "processing", processadas: 500, criadas: 500 } });
    expect(await processar(TEAM_A, job.id)).toBe("concluido");
    const fim = await runWithTeam(TEAM_A, async () => getImportJob(job.id));
    expect(fim).toMatchObject({ status: "done", processadas: 1000, criadas: 1000 });
    // Só o 2º bloco foi gravado nesta execução.
    const nomes = await basePrisma.contact.findMany({ where: { teamId: TEAM_A }, select: { nome: true } });
    expect(nomes).toHaveLength(500);
    expect(nomes.every((n) => Number(n.nome.split(" ")[1]) >= 500)).toBe(true);
  });

  it("bloco refeito depois de queda entre gravar e disparar: o que esta importação criou conta como criado e recebe o gatilho 1×", async () => {
    await fluxoContactCreated(TEAM_A);
    const flow = await basePrisma.flow.findFirstOrThrow({ where: { teamId: TEAM_A } });
    const texto = ["nome,celular", `Ana,${cel(80_001)}`, `Beto,${cel(80_002)}`, `Caio,${cel(80_003)}`, `Dani,${cel(80_004)}`].join("\n");
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "q.csv", mapeamento: ["nome", "whatsapp"] }));
    // A tentativa anterior começou há 1 min, gravou Ana e Beto e caiu; Beto chegou a entrar (e sair) do fluxo.
    const inicio = new Date(Date.now() - 60_000);
    await basePrisma.importJob.update({ where: { id: job.id }, data: { status: "processing", iniciadoEm: inicio } });
    const prov = { provenance: { source: "importacao", actor: "human" } };
    const ana = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Ana", enrichment: prov } });
    const beto = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Beto", enrichment: prov } });
    // Dani veio de uma importação ANTERIOR (ontem): continua "já existia".
    const dani = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Dani", enrichment: prov, createdAt: new Date(Date.now() - 86_400_000) } });
    await basePrisma.channelIdentifier.createMany({
      data: [
        { teamId: TEAM_A, contactId: ana.id, canal: "whatsapp", valor: e164(80_001), isPrimary: true },
        { teamId: TEAM_A, contactId: beto.id, canal: "whatsapp", valor: e164(80_002), isPrimary: true },
        { teamId: TEAM_A, contactId: dani.id, canal: "whatsapp", valor: e164(80_004), isPrimary: true },
      ],
    });
    await basePrisma.enrollment.create({ data: { teamId: TEAM_A, flowId: flow.id, contactId: beto.id, currentNodeId: "x", status: "done" } });

    expect(await processar(TEAM_A, job.id)).toBe("concluido");
    const fim = await runWithTeam(TEAM_A, async () => getImportJob(job.id));
    expect(fim).toMatchObject({ criadas: 3, atualizadas: 1, processadas: 4 });
    const porContato = await basePrisma.enrollment.groupBy({ by: ["contactId"], where: { teamId: TEAM_A }, _count: { _all: true } });
    const nomes = new Map((await basePrisma.contact.findMany({ where: { teamId: TEAM_A }, select: { id: true, nome: true } })).map((c) => [c.id, c.nome]));
    const inscricoes = Object.fromEntries(porContato.map((g) => [nomes.get(g.contactId), g._count._all]));
    // Ana (gravada e sem gatilho) entra agora; Beto não entra de novo; Caio entra como novo; Dani não é "nova".
    expect(inscricoes).toEqual({ Ana: 1, Beto: 1, Caio: 1 });
  });

  it("trava perdida para outro job do time no meio: para sem soltar a trava alheia", async () => {
    const linhas = Array.from({ length: 1200 }, (_, i) => `Trava ${i},${cel(60_000 + i)}`);
    const job = await runWithTeam(TEAM_A, async () =>
      commitImport({ texto: ["nome,celular", ...linhas].join("\n"), nomeArquivo: "t.csv", mapeamento: ["nome", "whatsapp"] }),
    );
    let blocos = 0;
    aposBloco = async () => {
      if (++blocos === 1) await redisEstado().set(`import:trava:${TEAM_A}`, "outro-job", "PX", 60_000);
    };
    await expect(processar(TEAM_A, job.id)).rejects.toBeInstanceOf(TravaDaImportacaoPerdida);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(500);
    expect(await redisEstado().get(`import:trava:${TEAM_A}`)).toBe("outro-job");
  });

  it("10.000 linhas: o commit volta na hora (web) e o worker importa tudo em blocos", async () => {
    await fluxoContactCreated(TEAM_A);
    const linhas = Array.from({ length: 10_000 }, (_, i) => `Pessoa ${i},${cel(50_000 + i)},p${i}@agro.com.br,Fazenda ${i},soja`);
    const texto = ["nome,celular,email,fazenda,cultura", ...linhas].join("\n");

    const t0 = Date.now();
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "grande.csv", mapeamento: ["nome", "whatsapp", "email", "empresa", "tags"] }));
    const msCommit = Date.now() - t0;
    expect(msCommit).toBeLessThan(5_000);

    const t1 = Date.now();
    expect(await processar(TEAM_A, job.id)).toBe("concluido");
    const msWorker = Date.now() - t1;
    const fim = await runWithTeam(TEAM_A, async () => getImportJob(job.id));
    expect(fim).toMatchObject({ status: "done", total: 10_000, processadas: 10_000, criadas: 10_000 });
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(10_000);
    expect(await basePrisma.enrollment.count({ where: { teamId: TEAM_A } })).toBe(10_000);
    // Progresso publicado a cada bloco (20 blocos + início + fim).
    expect(eventos.filter((e) => e.event.importJobId === job.id).length).toBeGreaterThanOrEqual(20);
    console.info(`[teste] 10 mil linhas: commit ${msCommit} ms · worker ${msWorker} ms`);
  }, 300_000);
});

describe("regra do responsável (dono, 28/09)", () => {
  it("linha de um contato de OUTRO responsável é recusada com o nome dele; o contato do colega fica intacto", async () => {
    const suf = randomUUID().slice(0, 6);
    const mk = (name: string) =>
      basePrisma.user.create({ data: { teamId: TEAM_A, name, email: `${name.toLowerCase()}-${suf}@imp-resp.dev`, role: "member" } });
    const joao = await mk("João");
    const pedro = await mk("Pedro");
    try {
      const doJoao = await contato(TEAM_A, { nome: "Marcos", tags: ["do-joao"] }, { whatsapp: e164(8000) });
      await basePrisma.contact.update({ where: { id: doJoao }, data: { ownerId: joao.id } });
      const texto = ["Nome;Celular;Município;Cultura", `Marcos de novo;${cel(8000)};Sinop;soja`, `Novo do Pedro;${cel(8001)};Sinop;milho`].join("\n");
      const job = await runWithTeam(
        TEAM_A,
        async () =>
          commitImport({ texto, nomeArquivo: "pedro.csv", mapeamento: ["nome", "whatsapp", "cidade", "tags"], opcoes: { existentes: "completar" } }),
        { userId: pedro.id, role: "member" },
      );
      expect(await processar(TEAM_A, job.id)).toBe("concluido");
      const fim = await basePrisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(fim).toMatchObject({ status: "done", criadas: 1, atualizadas: 0 });
      expect((fim.erros as { motivo: string }[]).map((e) => e.motivo)).toEqual(["já cadastrado com o responsável João"]);
      // O contato do João não foi "completado" (cidade/tag) nem mudou de responsável.
      expect(await basePrisma.contact.findUniqueOrThrow({ where: { id: doJoao }, select: { ownerId: true, cidade: true, tags: true } })).toEqual({
        ownerId: joao.id,
        cidade: null,
        tags: ["do-joao"],
      });
      expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM_A, valor: e164(8000) } })).toBe(1);
      // A linha nova entra com quem importou como responsável.
      expect((await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM_A, nome: "Novo do Pedro" } })).ownerId).toBe(pedro.id);
    } finally {
      await limpar();
      await basePrisma.user.deleteMany({ where: { id: { in: [joao.id, pedro.id] } } });
    }
  });
});

describe("CPF, CNPJ e IE na planilha", () => {
  const MAPA = ["nome", "cpf", "whatsapp", "empresa", "cnpj", "ie"] as const;

  it("grava o CPF cifrado e vincula a empresa (CNPJ e IE), reaproveitando a de mesmo CNPJ", async () => {
    const texto = ["Nome;CPF;Celular;Empresa;CNPJ;IE", `Ana;012.345.678-90;${cel(1)};Agro Lima;01.234.567/0001-95;123456`, `Beto;;${cel(2)};Agro Lima 2;01234567000195;`].join("\n");
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "c.csv", mapeamento: [...MAPA] }));
    await processar(TEAM_A, job.id);
    const ana = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM_A, nome: "Ana" }, include: { companies: { include: { company: true } } } });
    expect(ana.cpfCifrado).toBeTruthy();
    expect(ana.cpfCifrado).not.toContain("01234567890");
    expect(ana.companies.map((c) => c.company)).toMatchObject([{ nome: "Agro Lima", cnpj: "01234567000195", ie: "123456" }]);
    const empresas = await basePrisma.company.findMany({ where: { teamId: TEAM_A } });
    expect(empresas).toHaveLength(1); // o Beto reaproveitou a empresa pelo CNPJ
    expect(await basePrisma.contactCompany.count({ where: { teamId: TEAM_A } })).toBe(2);
  });

  it("contato que já existe: completa o CPF vazio e vincula a empresa, sem trocar o que tem", async () => {
    const id = await contato(TEAM_A, { nome: "Carla" }, { whatsapp: e164(3) });
    const texto = ["Nome;CPF;Celular;Empresa;CNPJ;IE", `Carla;01234567890;${cel(3)};;;654321`].join("\n");
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "c.csv", mapeamento: [...MAPA] }));
    await processar(TEAM_A, job.id);
    const c = await basePrisma.contact.findUniqueOrThrow({ where: { id }, include: { companies: { include: { company: true } } } });
    expect(c.cpfCifrado).toBeTruthy();
    expect(c.companies.map((x) => x.company)).toMatchObject([{ nome: "Empresa de Carla", ie: "654321" }]);
  });

  it("o mesmo produtor em 3 linhas (mesmo CPF, 3 IEs): 1 contato, 3 empresas, todos os telefones e e-mails", async () => {
    const texto = [
      "Nome;CPF;Telefone;Email;Cidade;Estado;Empresa;IE",
      "PRODUTOR EXEMPLO;3456789157;55 33337703;financeiro@x.com;PEIXOTO DE AZEVEDO;MT;PRODUTOR EXEMPLO;10.000.001-1",
      "PRODUTOR EXEMPLO;3456789157;66 33337703;produtor2@x.com;SANTA CARMEM;MT;PRODUTOR EXEMPLO;10.000.002-2",
      "PRODUTOR EXEMPLO;3456789157;66 33337703;produtor@x.com;APIACAS;MT;PRODUTOR EXEMPLO;10.000.003-3",
    ].join("\n");
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "p.csv", mapeamento: ["nome", "cpf", "whatsapp", "email", "cidade", "estado", "empresa", "ie"] }));
    await processar(TEAM_A, job.id);
    const contatos = await basePrisma.contact.findMany({ where: { teamId: TEAM_A }, include: { identifiers: true, companies: { include: { company: true } } } });
    expect(contatos).toHaveLength(1);
    const c = contatos[0]!;
    expect(c.identifiers.filter((i) => i.canal === "whatsapp").map((i) => i.valor).sort()).toEqual(["+555533337703", "+556633337703"]);
    expect(c.identifiers.filter((i) => i.canal === "email")).toHaveLength(3);
    expect(c.identifiers.filter((i) => i.isPrimary)).toHaveLength(2); // um principal por canal
    expect(c.companies.map((x) => [x.company.ie, x.company.cidade]).sort()).toEqual([
      ["10.000.001-1", "PEIXOTO DE AZEVEDO"],
      ["10.000.002-2", "SANTA CARMEM"],
      ["10.000.003-3", "APIACAS"],
    ]);
    // Rodar a mesma planilha de novo não duplica contato nem empresa (acha pelo CPF e pela IE).
    const de_novo = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "p2.csv", mapeamento: ["nome", "cpf", "whatsapp", "email", "cidade", "estado", "empresa", "ie"] }));
    await processar(TEAM_A, de_novo.id);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(1);
    expect(await basePrisma.company.count({ where: { teamId: TEAM_A } })).toBe(3);
  });

  it("acha quem já está no CRM Agro pelo CPF (mesmo com telefone novo) e soma o telefone, sem criar outro contato", async () => {
    const { cifrarCpf, hashDoCpf } = await import("../contacts/cpf");
    const c = await basePrisma.contact.create({ data: { teamId: TEAM_A, nome: "Carla Souza", cpfCifrado: cifrarCpf("01234567890"), cpfHash: hashDoCpf(TEAM_A, "01234567890") } });
    await basePrisma.channelIdentifier.create({ data: { teamId: TEAM_A, contactId: c.id, canal: "whatsapp", valor: e164(1), isPrimary: true } });
    const texto = ["Nome;CPF;Celular", `Carla Souza;012.345.678-90;${cel(2)}`].join("\n");
    const previa = await runWithTeam(TEAM_A, async () => previewImport({ texto }));
    expect(previa.contagens).toMatchObject({ novos: 0, jaExistem: 1 });
    const job = await runWithTeam(TEAM_A, async () => commitImport({ texto, nomeArquivo: "c.csv", mapeamento: ["nome", "cpf", "whatsapp"] }));
    await processar(TEAM_A, job.id);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM_A } })).toBe(1);
    const ids = await basePrisma.channelIdentifier.findMany({ where: { contactId: c.id }, orderBy: { createdAt: "asc" } });
    expect(ids.map((i) => [i.valor, i.isPrimary])).toEqual([[e164(1), true], [e164(2), false]]);
  });
});

