import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { basePrisma, db, runWithTeam } from "@crmagro/db";
import { hashDoCpf } from "./cpf";
import { listContactIds, list, count, listarContatosDaTela } from "./service";
import { buscarContatos, BUSCA_TETO } from "./busca";
import { resolverBuscaDaExportacao } from "./export";

/**
 * Busca da tela de Contatos por QUALQUER dado do contato e da empresa (busca.ts), com banco de teste:
 * acento e maiúscula, telefone e CNPJ com ou sem máscara, várias palavras (E), e-mail parcial, enriquecimento
 * (razão social, sócios), tag, responsável, CPF só por igualdade, escopo por dono, dois times, cifra ligada e
 * desligada, teto e o "achado em" de cada linha.
 */
const TEAM = "00000000-0000-0000-0000-0000000b5c01";
const OUTRO = "00000000-0000-0000-0000-0000000b5c02";
const sufixo = Math.random().toString(36).slice(2, 7);
const CPF = "12345678909";

let master: { id: string }, vendA: { id: string }, vendB: { id: string };
const ids: Record<string, string> = {};

const comoDono = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: master.id, role: "owner" });
const como = <T>(u: { id: string }, role: string, fn: () => Promise<T>, extra: { verTudoEm?: string[] } = {}) => runWithTeam(TEAM, fn, { userId: u.id, role, ...extra });
const nomes = (r: { items: { nome: string }[] }) => r.items.map((c) => c.nome);
const acha = async (search: string) => nomes(await comoDono(() => list({ search, limit: 100 }))).sort();

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.contactTag.deleteMany({ where: w });
  await basePrisma.tag.deleteMany({ where: w });
  await basePrisma.contactCompany.deleteMany({ where: w });
  await basePrisma.company.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
}

async function contato(teamId: string, chave: string, dados: Record<string, unknown>, ident: { whatsapp?: string; email?: string } = {}) {
  const c = await basePrisma.contact.create({ data: { teamId, ...(dados as { nome: string }) } });
  ids[chave] = c.id;
  if (ident.whatsapp) await basePrisma.channelIdentifier.create({ data: { teamId, contactId: c.id, canal: "whatsapp", valor: ident.whatsapp, isPrimary: true } });
  if (ident.email) await basePrisma.channelIdentifier.create({ data: { teamId, contactId: c.id, canal: "email", valor: ident.email, isPrimary: true } });
  return c;
}

async function empresa(teamId: string, contactId: string, dados: Record<string, unknown>) {
  const co = await basePrisma.company.create({ data: { teamId, ...(dados as { nome: string }) } });
  await basePrisma.contactCompany.create({ data: { teamId, contactId, companyId: co.id, papel: "dono" } });
  return co;
}

beforeAll(async () => {
  process.env.CONTATOS_CIFRA = "off";
  for (const [id, name] of [[TEAM, "Busca contatos A (test)"], [OUTRO, "Busca contatos B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar(TEAM);
  await limpar(OUTRO);
  await basePrisma.user.deleteMany({ where: { teamId: TEAM } });
  const mk = (n: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `${n.toLowerCase().replace(/ /g, "")}-${sufixo}@busca.dev`, role } });
  master = await mk("Dono Geral", "owner");
  vendA = await mk("Carlos Vendedor", "member");
  vendB = await mk("Bianca Comercial", "member");

  const base = Date.now() - 600_000;
  const jose = await contato(
    TEAM,
    "jose",
    {
      nome: "José",
      sobrenome: "Conceição Silva",
      cidade: "São Paulo",
      estado: "SP",
      cargo: "Gerente",
      origem: "indicacao",
      tags: ["quente"],
      culturas: ["soja"],
      ownerId: vendA.id,
      cnpj: null,
      createdAt: new Date(base + 1000),
      cpfHash: hashDoCpf(TEAM, CPF),
    },
    { whatsapp: "+5566999887766", email: "jose.silva@fazenda.com" },
  );
  await empresa(TEAM, jose.id, {
    nome: "Fazenda Boa Vista Ltda",
    cnpj: "12.345.678/0001-90",
    ie: "131.234.567-8",
    telefone: "(66) 3521-1234",
    email: "contato@boavista.com.br",
    cidade: "Sorriso",
    enrichment: {
      publico: [
        { rotulo: "Razão social", valor: "AGROPECUÁRIA BOA VISTA LTDA" },
        { rotulo: "Nome fantasia", valor: "Boa Vista Grãos" },
        { rotulo: "Atividade principal", valor: "Cultivo de soja" },
      ],
      socios: [{ nome: "MARIA APARECIDA SOUZA", qualificacao: "Sócio-Administrador" }],
      campos: { cnpj: { fonte: "brasilapi", consultadoEm: "2026-10-01" } },
    },
  });
  await contato(TEAM, "pedro", { nome: "Pedro", sobrenome: "Alves", cidade: "Sinop", empresa: "Cerealista Horizonte", ownerId: vendB.id, relacionamentoStatus: "cliente", createdAt: new Date(base + 2000) }, { whatsapp: "+5565988112233" });
  await contato(TEAM, "ana", { nome: "Ana", sobrenome: "Lima", cidade: "Cuiabá", ownerId: vendA.id, compartilhado: true, createdAt: new Date(base + 3000) });
  await contato(TEAM, "bia", { nome: "Bianca", sobrenome: "Silva", ownerId: vendB.id, createdAt: new Date(base + 4000) });

  // Tag nomeada.
  const tag = await basePrisma.tag.create({ data: { teamId: TEAM, nome: "Reativação" } });
  await basePrisma.contactTag.create({ data: { teamId: TEAM, contactId: ids.ana!, tagId: tag.id } });

  // O OUTRO time tem o mesmo nome, o mesmo CNPJ e o mesmo telefone: nada disso pode aparecer para o time A.
  const alheio = await contato(OUTRO, "alheio", { nome: "José Silva do Outro Time", cidade: "São Paulo", cpfHash: hashDoCpf(OUTRO, CPF) }, { whatsapp: "+5511999887766", email: "jose.silva@outro.com" });
  await empresa(OUTRO, alheio.id, { nome: "Fazenda Alheia", cnpj: "12.345.678/0001-90", enrichment: { socios: [{ nome: "MARIA APARECIDA SOUZA" }] } });
});

afterEach(() => {
  process.env.CONTATOS_CIFRA = "off";
});

afterAll(async () => {
  process.env.CONTATOS_CIFRA = "off";
  await limpar(TEAM);
  await limpar(OUTRO);
  await basePrisma.user.deleteMany({ where: { teamId: TEAM } });
});

describe("busca de contatos: dados do contato", () => {
  it("não diferencia acento nem maiúscula", async () => {
    for (const t of ["jose", "JOSÉ", "José", "conceicao", "CONCEIÇÃO", "sao paulo", "SÃO PAULO"]) expect(await acha(t), t).toEqual(["José"]);
  });

  it("acha em cidade, estado, cargo, origem, tag (legado e nomeada) e cultura", async () => {
    expect(await acha("cuiaba")).toEqual(["Ana"]);
    expect(await acha("sinop")).toEqual(["Pedro"]);
    expect(await acha("gerente")).toEqual(["José"]);
    expect(await acha("indicacao")).toEqual(["José"]);
    expect(await acha("quente")).toEqual(["José"]);
    expect(await acha("reativacao")).toEqual(["Ana"]);
    expect(await acha("soja")).toEqual(["José"]);
  });

  it("várias palavras: todas precisam aparecer, em qualquer ordem e em lugares diferentes", async () => {
    expect(await acha("silva jose")).toEqual(["José"]);
    expect(await acha("jose gerente sao")).toEqual(["José"]);
    expect(await acha("jose cerealista")).toEqual([]);
    expect(await acha("silva")).toEqual(["Bianca", "José"]);
  });

  it("menos de 2 caracteres não filtra (a lista volta inteira)", async () => {
    expect((await acha("j")).length).toBe(4);
  });

  it("curingas do SQL digitados na busca não funcionam como curinga", async () => {
    expect(await acha("%%")).toEqual([]);
    expect(await acha("j_se")).toEqual([]);
  });
});

describe("busca de contatos: telefone, e-mail e CPF", () => {
  it("telefone com ou sem máscara, com ou sem 55, com ou sem o 9º dígito", async () => {
    for (const t of ["66999887766", "(66) 99988-7766", "+55 66 99988-7766", "5566999887766", "6699887766", "99988-7766", "999887766", "99988"]) {
      expect(await acha(t), t).toEqual(["José"]);
    }
  });

  it("e-mail inteiro e parcial", async () => {
    expect(await acha("jose.silva@fazenda.com")).toEqual(["José"]);
    expect(await acha("jose.silva@")).toEqual(["José"]);
    expect(await acha("@fazenda.com")).toEqual(["José"]);
  });

  it("CPF só por igualdade exata (com ou sem máscara); trecho do CPF não acha nada", async () => {
    expect(await acha("123.456.789-09")).toEqual(["José"]);
    expect(await acha("12345678909")).toEqual(["José"]);
    expect(await acha("123.456.789")).toEqual([]);
    expect(await acha("456.789-09")).toEqual([]);
  });
});

describe("busca de contatos: empresa e enriquecimento", () => {
  it("acha pelo nome da empresa, razão social, nome fantasia, atividade e sócio", async () => {
    expect(await acha("boa vista")).toEqual(["José"]);
    expect(await acha("agropecuaria")).toEqual(["José"]);
    expect(await acha("graos")).toEqual(["José"]);
    expect(await acha("cultivo")).toEqual(["José"]);
    expect(await acha("aparecida")).toEqual(["José"]);
    expect(await acha("administrador")).toEqual(["José"]);
    expect(await acha("sorriso")).toEqual(["José"]);
  });

  it("CNPJ com máscara, sem máscara e parcial; inscrição estadual", async () => {
    for (const t of ["12.345.678/0001-90", "12345678000190", "12.345.678", "0001-90", "131.234.567-8"]) expect(await acha(t), t).toEqual(["José"]);
  });

  it("telefone da empresa e e-mail da empresa", async () => {
    for (const t of ["(66) 3521-1234", "6635211234", "3521-1234", "contato@boavista"]) expect(await acha(t), t).toEqual(["José"]);
  });

  it("palavra do contato e da empresa juntas", async () => {
    expect(await acha("jose fazenda 12.345.678")).toEqual(["José"]);
    expect(await acha("pedro fazenda")).toEqual([]);
  });

  it("empresa que mudou aparece na busca (o trigger reescreve o texto de busca)", async () => {
    const co = await basePrisma.company.findFirstOrThrow({ where: { teamId: TEAM, nome: "Fazenda Boa Vista Ltda" } });
    await basePrisma.company.update({ where: { id: co.id }, data: { nome: "Granja Nova Esperança Ltda" } });
    expect(await acha("esperanca")).toEqual(["José"]);
    expect(await acha("granja")).toEqual(["José"]);
    await basePrisma.company.update({ where: { id: co.id }, data: { nome: "Fazenda Boa Vista Ltda" } });
    expect(await acha("granja")).toEqual([]);
  });
});

describe("busca de contatos: responsável, filtros e ordem", () => {
  it("acha pelo nome do responsável (para quem vê as pessoas)", async () => {
    expect(await acha("carlos")).toEqual(["Ana", "José"]);
  });

  it("os filtros da tela continuam valendo junto com a busca", async () => {
    const r = await comoDono(() => list({ search: "silva", status: "cliente" }));
    expect(nomes(r)).toEqual([]);
    expect(nomes(await comoDono(() => list({ search: "alves", status: "cliente" })))).toEqual(["Pedro"]);
    expect(nomes(await comoDono(() => list({ search: "silva", dono: vendB.id })))).toEqual(["Bianca"]);
    expect(nomes(await comoDono(() => list({ search: "silva", origem: "indicacao" })))).toEqual(["José"]);
    expect(nomes(await comoDono(() => list({ search: "silva", interesse: "interessado" })))).toEqual([]);
  });

  it("filtro por tag junto com a busca (com tag e sem tag)", async () => {
    const tag = await basePrisma.tag.findFirstOrThrow({ where: { teamId: TEAM } });
    expect(nomes(await comoDono(() => list({ search: "lima", tag: tag.id })))).toEqual(["Ana"]);
    expect(nomes(await comoDono(() => list({ search: "lima", tag: "__none__" })))).toEqual([]);
  });

  it("mais novos primeiro, paginação por posição e por cursor, total igual ao da lista", async () => {
    const todos = await comoDono(() => list({ search: "silva" }));
    expect(nomes(todos)).toEqual(["Bianca", "José"]);
    const p1 = await comoDono(() => list({ search: "silva", limit: 1 }));
    expect(nomes(p1)).toEqual(["Bianca"]);
    expect(p1.hasMore).toBe(true);
    const p2 = await comoDono(() => list({ search: "silva", limit: 1, offset: 1 }));
    expect(nomes(p2)).toEqual(["José"]);
    expect(p2.hasMore).toBe(false);
    const viaCursor = await comoDono(() => list({ search: "silva", limit: 1, cursor: p1.nextCursor! }));
    expect(nomes(viaCursor)).toEqual(["José"]);
    expect(await comoDono(() => count({ search: "silva" }))).toBe(2);
    expect((await comoDono(() => listContactIds({ search: "silva" }))).sort()).toEqual([ids.jose, ids.bia].sort());
  });
});

describe("busca de contatos: escopo por dono e dois times", () => {
  it("quem só vê os próprios contatos só acha os próprios (e os compartilhados), por qualquer dado", async () => {
    const dosA = async (t: string) => nomes(await como(vendA, "member", () => list({ search: t }))).sort();
    expect(await dosA("silva")).toEqual(["José"]); // Bianca é do vendedor B
    expect(await dosA("sinop")).toEqual([]); // Pedro é do vendedor B
    expect(await dosA("12.345.678/0001-90")).toEqual(["José"]);
    expect(await dosA("cuiaba")).toEqual(["Ana"]); // a Ana é do A e compartilhada
    expect(await como(vendA, "member", () => count({ search: "silva" }))).toBe(1);
    expect(await como(vendA, "member", () => listContactIds({ search: "silva" }))).toEqual([ids.jose]);
  });

  it("o vendedor B não acha o contato do A nem pelo CNPJ, telefone ou CPF", async () => {
    const dosB = async (t: string) => nomes(await como(vendB, "member", () => list({ search: t }))).sort();
    expect(await dosB("12.345.678/0001-90")).toEqual([]);
    expect(await dosB("66999887766")).toEqual([]);
    expect(await dosB("123.456.789-09")).toEqual([]);
    expect(await dosB("sinop")).toEqual(["Pedro"]);
  });

  it("'ver tudo' na tela de Contatos acha de todos; o 'por vendedor' restringe", async () => {
    expect(nomes(await como(vendA, "member", () => list({ search: "silva" }), { verTudoEm: ["contatos"] })).sort()).toEqual(["Bianca", "José"]);
    expect(nomes(await como(vendA, "member", () => list({ search: "silva", dono: vendB.id }), { verTudoEm: ["contatos"] }))).toEqual(["Bianca"]);
  });

  it("dois times: o time B só acha o que é dele, e o A nunca vê nada do B", async () => {
    const doOutro = async (t: string) => nomes(await runWithTeam(OUTRO, () => list({ search: t }), { userId: "u-outro", role: "owner" }));
    expect(await doOutro("silva")).toEqual(["José Silva do Outro Time"]);
    expect(await doOutro("12.345.678/0001-90")).toEqual(["José Silva do Outro Time"]);
    expect(await doOutro("123.456.789-09")).toEqual(["José Silva do Outro Time"]);
    expect(await doOutro("fazenda alheia")).toEqual(["José Silva do Outro Time"]);
    expect(await doOutro("boa vista")).toEqual([]);
    // O time A, com o mesmo telefone parcial, CNPJ, CPF e sócio do B: só os próprios.
    expect(await acha("outro time")).toEqual([]);
    expect(await acha("alheia")).toEqual([]);
    expect(await acha("11999887766")).toEqual([]);
    expect((await comoDono(() => listContactIds({ search: "aparecida" }))).sort()).toEqual([ids.jose]);
  });

  it("sem time no contexto não acha nada (nunca 'todos')", async () => {
    const r = await buscarContatos({ search: "silva" });
    expect(r?.ids).toEqual([]);
  });
});

describe("busca de contatos: teto, 'achado em' e exportação", () => {
  it("passou do teto: devolve só o teto, avisa que truncou e recusa ação em massa", async () => {
    const r = await comoDono(() => buscarContatos({ search: "silva" }, { limite: 1 }));
    expect(r?.ids).toHaveLength(1);
    expect(r?.truncada).toBe(true);
    expect(BUSCA_TETO).toBeGreaterThan(1000);
    const t = await comoDono(() => listarContatosDaTela({ search: "silva" }, { limit: 50, offset: 0 }));
    expect(t.truncada).toBe(false);
    expect(t.total).toBe(2);
  });

  it("cada linha traz ONDE a busca achou", async () => {
    const achados = async (t: string, chave: string) => (await comoDono(() => listarContatosDaTela({ search: t }, { limit: 50, offset: 0 }))).achados[ids[chave]!]?.map((a) => a.rotulo);
    expect(await achados("silva", "jose")).toEqual(["nome"]);
    expect(await achados("12.345.678/0001-90", "jose")).toEqual(["CNPJ da empresa"]);
    expect(await achados("aparecida", "jose")).toEqual(["sócio"]);
    expect(await achados("agropecuaria", "jose")).toEqual(["razão social"]);
    expect(await achados("cultivo", "jose")).toEqual(["atividade principal"]);
    expect(await achados("(66) 99988-7766", "jose")).toEqual(["telefone"]);
    expect(await achados("jose.silva@", "jose")).toEqual(["e-mail"]);
    expect(await achados("123.456.789-09", "jose")).toEqual(["CPF"]);
    expect(await achados("carlos", "jose")).toEqual(["responsável"]);
    expect(await achados("cuiaba", "ana")).toEqual(["cidade"]);
    expect(await achados("reativacao", "ana")).toEqual(["tag"]);
    expect(await achados("jose graos", "jose")).toEqual(["nome", "nome fantasia"]);
  });

  it("o motivo nunca traz o CPF nem texto livre do contato", async () => {
    const t = await comoDono(() => listarContatosDaTela({ search: "123.456.789-09" }, { limit: 50, offset: 0 }));
    expect(JSON.stringify(t.achados)).not.toContain("12345678909");
    expect(JSON.stringify(t.achados)).not.toContain("123.456");
  });

  it("sem busca, a tela lista tudo e não há 'achado em'", async () => {
    const t = await comoDono(() => listarContatosDaTela({}, { limit: 50, offset: 0 }));
    expect(t.total).toBe(4);
    expect(t.buscaAtiva).toBe(false);
    expect(t.achados).toEqual({});
  });

  it("a exportação filtrada traz os mesmos contatos da tela (mesma busca)", async () => {
    const f = await comoDono(() => resolverBuscaDaExportacao({ search: "12.345.678/0001-90" }));
    expect(f.search).toBeUndefined();
    expect(f.ids).toEqual([ids.jose]);
    const nada = await comoDono(() => resolverBuscaDaExportacao({ search: "zzzz-nao-existe" }));
    expect(nada.ids).toHaveLength(1);
    expect(nada.ids![0]).not.toBe(ids.jose);
  });
});

describe("busca de contatos: cifra de e-mail e telefone (CONTATOS_CIFRA)", () => {
  for (const modo of ["dupla", "indice", "ligada"] as const) {
    it(`modo ${modo}: telefone e e-mail completos acham, em qualquer formato; nome, CNPJ e empresa seguem iguais`, async () => {
      process.env.CONTATOS_CIFRA = modo;
      // Contato criado já com a cifra ligada (a extensão do db() grava o texto cifrado e o índice cego).
      const novo = await runWithTeam(TEAM, async () => {
        const c = await db().contact.create({ data: { nome: `Cifrado ${modo}`, ownerId: master.id } as never });
        await db().channelIdentifier.create({ data: { contactId: c.id, canal: "whatsapp", valor: "+5566977665544", isPrimary: true } as never });
        await db().channelIdentifier.create({ data: { contactId: c.id, canal: "email", valor: `cifrado.${modo}@exemplo.com`, isPrimary: true } as never });
        return c;
      }, { userId: master.id, role: "owner" });
      try {
        for (const t of ["+5566977665544", "(66) 97766-5544", "66977665544", `cifrado.${modo}@exemplo.com`, `CIFRADO.${modo}@Exemplo.com`]) {
          expect(await acha(t), t).toEqual([`Cifrado ${modo}`]);
        }
        expect(await acha(`cifrado ${modo}`)).toEqual([`Cifrado ${modo}`]);
        // O que não depende da cifra continua funcionando.
        expect(await acha("12.345.678/0001-90")).toEqual(["José"]);
        expect(await acha("aparecida")).toEqual(["José"]);
        expect(await acha("jose silva")).toEqual(["José"]);
        // Dois times: o telefone do outro time, com o índice cego, também não vaza.
        expect(await acha("11999887766")).toEqual([]);
      } finally {
        await basePrisma.channelIdentifier.deleteMany({ where: { contactId: novo.id } });
        await basePrisma.contact.delete({ where: { id: novo.id } });
      }
    });
  }

  it("com a cifra em índice ou ligada, PEDAÇO de telefone ou e-mail não acha (limitação documentada)", async () => {
    process.env.CONTATOS_CIFRA = "ligada";
    const novo = await runWithTeam(TEAM, async () => {
      const c = await db().contact.create({ data: { nome: "Pedaço Cifrado", ownerId: master.id } as never });
      await db().channelIdentifier.create({ data: { contactId: c.id, canal: "whatsapp", valor: "+5566966554433", isPrimary: true } as never });
      await db().channelIdentifier.create({ data: { contactId: c.id, canal: "email", valor: "pedaco.cifrado@exemplo.com", isPrimary: true } as never });
      return c;
    }, { userId: master.id, role: "owner" });
    try {
      expect(await acha("66554")).toEqual([]);
      expect(await acha("pedaco.cif")).toEqual([]);
      expect(await acha("+5566966554433")).toEqual(["Pedaço Cifrado"]);
      // Os 8 últimos dígitos (telefone sem DDD) acham pelo índice do sufixo.
      expect(await acha("96655-4433")).toEqual(["Pedaço Cifrado"]);
    } finally {
      await basePrisma.channelIdentifier.deleteMany({ where: { contactId: novo.id } });
      await basePrisma.contact.delete({ where: { id: novo.id } });
    }
  });
});
