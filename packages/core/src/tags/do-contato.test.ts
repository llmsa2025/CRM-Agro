import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Campo "Tags" do contato → catálogo. Antes a tag digitada ia só para `Contact.tags` (campo legado) e nunca
 * aparecia na barra de filtro nem no autocomplete de Contatos, que leem `Tag` + `ContactTag`.
 *
 * O gatilho "tag adicionada" é espiado, não executado: aqui interessa QUEM o dispara, não o motor.
 */
const enroll = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("../flows/triggers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../flows/triggers")>();
  return { ...real, safeEnrollByTrigger: enroll, safeEnrollManyByTrigger: vi.fn(async () => ({ inscritas: 0 })) };
});

const tags = await import("./index");
const contacts = await import("../contacts/index");
const { TAG_NUMERO_ERRADO } = await import("../calls/resultado");
const { TAG_PEDIU_PARA_SAIR } = await import("../conversations/opt-out");
const { ForbiddenError } = await import("../auth/authz");

const TEAM = "00000000-0000-0000-0000-0000000e0041";
const OUTRO = "00000000-0000-0000-0000-0000000e0042";
const TIMES = [TEAM, OUTRO];

beforeAll(async () => {
  for (const [id, name] of [[TEAM, "Team tags do contato (test)"], [OUTRO, "Outro team tags do contato (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: { name }, create: { id, name } });
  }
});

async function limpar() {
  const w = { teamId: { in: TIMES } };
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.contactTag.deleteMany({ where: w });
  await basePrisma.tag.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
}
beforeEach(async () => {
  enroll.mockClear();
  await limpar();
});
afterAll(limpar);

const novoContato = async (teamId = TEAM, legado: string[] = []) =>
  (await basePrisma.contact.create({ data: { teamId, nome: "Lead", tags: legado } })).id;
const catalogo = async (teamId = TEAM) =>
  (await basePrisma.tag.findMany({ where: { teamId }, orderBy: { nome: "asc" } })).map((t) => t.nome);
const tagsNoCatalogoDe = async (contactId: string) =>
  (await basePrisma.contactTag.findMany({ where: { contactId }, include: { tag: true } })).map((v) => v.tag.nome).sort();
const legadoDe = async (contactId: string) => (await basePrisma.contact.findUniqueOrThrow({ where: { id: contactId } })).tags;
const tagAdicionada = () => enroll.mock.calls.filter(([tipo]) => tipo === "tag_added").map(([, payload]) => payload);
/** Põe a tag no catálogo e no contato por "outro caminho" (menu, passo de fluxo, colega): sem gatilho. */
const poePorOutroCaminho = (contactId: string, ...nomes: string[]) =>
  runWithTeam(TEAM, async () => tags.aplicarMudancaDeTags(contactId, { adicionadas: nomes, removidas: [] }));

describe("nomes", () => {
  it("nomesParaOCatalogo: tira vazio, repetido (caixa e acento), corta em 40 e ignora marca do sistema", () => {
    expect(tags.nomesParaOCatalogo(["  Soja  ", "soja", "", "   ", "Café", "cafe", "Milho"])).toEqual(["Soja", "Café", "Milho"]);
    expect(tags.nomesParaOCatalogo(["x".repeat(60)])).toEqual(["x".repeat(40)]);
    expect(tags.nomesParaOCatalogo([TAG_NUMERO_ERRADO, "número errado", "Soja"])).toEqual(["Soja"]);
  });

  it("nomesParaOCatalogo: no máximo 50 tags por contato (lista absurda não vira milhares de tags)", () => {
    const muitas = Array.from({ length: 80 }, (_, i) => `Tag ${i}`);
    expect(tags.nomesParaOCatalogo(muitas)).toHaveLength(tags.MAX_TAGS_POR_CONTATO);
    expect(tags.MAX_TAGS_POR_CONTATO).toBe(50);
  });

  it("unirNomesDeTag: a primeira grafia fica e não repete", () => {
    expect(tags.unirNomesDeTag(["Soja", "Milho"], ["soja", "Algodão", "milho "])).toEqual(["Soja", "Milho", "Algodão"]);
  });
});

describe("marcas internas do sistema (ficam só no campo legado)", () => {
  it("a lista contém as constantes que a ligação e o opt-out gravam", () => {
    expect(tags.MARCAS_DO_SISTEMA).toContain(TAG_NUMERO_ERRADO);
    expect(tags.MARCAS_DO_SISTEMA).toContain(TAG_PEDIU_PARA_SAIR);
  });

  it("reconhece sem caixa e sem acento, e toda tag da IA ('IA: ...')", () => {
    expect(tags.ehMarcaDoSistema("NÚMERO errado")).toBe(true);
    expect(tags.ehMarcaDoSistema("tem historico")).toBe(true);
    expect(tags.ehMarcaDoSistema("IA: interessado em soja")).toBe(true);
    expect(tags.ehMarcaDoSistema("Soja")).toBe(false);
    expect(tags.ehMarcaDoSistema("Diária")).toBe(false);
  });

  it("cobre toda marca que o executor de fluxos põe com pushTagOnce (marca nova fora da lista quebra aqui)", () => {
    const fonte = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../flows/executor.ts"), "utf8");
    const constantes = new Map([...fonte.matchAll(/const (TAG_[A-Z_]+) = "([^"]+)"/g)].map((m) => [m[1]!, m[2]!] as const));
    const usadas = [...fonte.matchAll(/pushTagOnce\(\s*enr\.contactId,\s*(?:"([^"]+)"|(TAG_[A-Z_]+))\s*\)/g)].map(
      (m) => m[1] ?? constantes.get(m[2]!),
    );
    expect(usadas.length).toBeGreaterThan(0);
    for (const marca of usadas) {
      expect(marca, "constante do executor não encontrada").toBeTruthy();
      expect(tags.ehMarcaDoSistema(marca!), `a marca "${marca}" falta em MARCAS_DO_SISTEMA`).toBe(true);
    }
  });
});

describe("a diferença entre o que a pessoa via e o que deixou", () => {
  it("diferencaDeTags: o que foi posto e o que foi tirado, sem caixa e sem acento", () => {
    expect(tags.diferencaDeTags(["Soja", "Milho"], ["milho", "Algodão"])).toEqual({ adicionadas: ["Algodão"], removidas: ["Soja"] });
    expect(tags.diferencaDeTags([], ["Soja", "soja", " "])).toEqual({ adicionadas: ["Soja"], removidas: [] });
  });

  it("diferencaDeTags: listas iguais (mesmo com outra grafia) não têm diferença", () => {
    const d = tags.diferencaDeTags(["Café", "Soja"], ["cafe", "SOJA"]);
    expect(d).toEqual({ adicionadas: [], removidas: [] });
    expect(tags.temMudanca(d)).toBe(false);
  });

  it("legadoComMudanca: tira as tiradas, soma as postas e não mexe no resto nem na grafia dele", () => {
    expect(
      tags.legadoComMudanca(["Soja", "Milho", "Sem Canal", "  Esquisita  "], { adicionadas: ["Algodão", "milho"], removidas: ["soja"] }),
    ).toEqual(["Milho", "Sem Canal", "  Esquisita  ", "Algodão"]);
  });
});

describe("aplicarMudancaDeTags", () => {
  it("cria no catálogo, vincula várias tags e a barra de filtro passa a mostrá-las com a contagem", async () => {
    const id = await novoContato();
    await runWithTeam(TEAM, async () => {
      const r = await tags.aplicarMudancaDeTags(id, { adicionadas: ["Soja", "Milho"], removidas: [] });
      expect(r.adicionadas.map((t) => t.nome).sort()).toEqual(["Milho", "Soja"]);
      const barra = await tags.tagFilterSummary();
      expect(barra.tags.map((t) => [t.nome, t.count]).sort()).toEqual([["Milho", 1], ["Soja", 1]]);
      expect(barra.semTag).toBe(0);
    });
    expect(await tagsNoCatalogoDe(id)).toEqual(["Milho", "Soja"]);
  });

  it("reaproveita a tag que já existe (sem caixa e sem acento) em vez de duplicar", async () => {
    await runWithTeam(TEAM, async () => tags.createTag({ nome: "Café Arábica" }));
    const id = await novoContato();
    await poePorOutroCaminho(id, "cafe arabica");
    expect(await catalogo()).toEqual(["Café Arábica"]);
    expect(await tagsNoCatalogoDe(id)).toEqual(["Café Arábica"]);
  });

  it("tira SÓ o que a mudança pede (por nome sem caixa e sem acento) e mantém o resto", async () => {
    const id = await novoContato();
    await poePorOutroCaminho(id, "A", "B", "Respondeu");
    const r = await runWithTeam(TEAM, async () => tags.aplicarMudancaDeTags(id, { adicionadas: ["C"], removidas: ["a"] }));
    expect(r.adicionadas.map((t) => t.nome)).toEqual(["C"]);
    expect(r.removidas).toBe(1);
    expect(await tagsNoCatalogoDe(id)).toEqual(["B", "C", "Respondeu"]); // "Respondeu" veio de outro caminho e fica
    expect(await catalogo()).toEqual(["A", "B", "C", "Respondeu"]); // "A" continua cadastrada, só sem esse contato
  });

  it("mudança vazia não toca em nada e não cria tag", async () => {
    const id = await novoContato();
    const r = await runWithTeam(TEAM, async () => tags.aplicarMudancaDeTags(id, { adicionadas: [TAG_NUMERO_ERRADO, " "], removidas: [] }));
    expect(r).toEqual({ adicionadas: [], removidas: 0 });
    expect(await catalogo()).toEqual([]);
  });

  it("não leva as marcas internas do sistema para o catálogo (a barra de filtro fica só com tags da equipe)", async () => {
    const id = await novoContato();
    await poePorOutroCaminho(id, TAG_NUMERO_ERRADO, "Sem Canal", "tem historico", "IA: interessado", TAG_PEDIU_PARA_SAIR, "Soja");
    expect(await catalogo()).toEqual(["Soja"]);
    expect(await tagsNoCatalogoDe(id)).toEqual(["Soja"]);
  });

  it("dispara 'tag adicionada' só para vínculo que ESTA chamada criou e só quando o chamador pede", async () => {
    const id = await novoContato();
    await runWithTeam(TEAM, async () => tags.aplicarMudancaDeTags(id, { adicionadas: ["Soja"], removidas: [] }));
    expect(tagAdicionada()).toHaveLength(0); // sem `gatilho`

    // "Soja" já era do contato (outro caminho): só "Milho" é vínculo novo.
    await runWithTeam(TEAM, async () => tags.aplicarMudancaDeTags(id, { adicionadas: ["Soja", "Milho"], removidas: [] }, { gatilho: true }));
    expect(tagAdicionada()).toHaveLength(1);
    expect(tagAdicionada()[0]).toMatchObject({ contactId: id, profundidade: 0 });
  });

  it("recusa contato de outro time e não cria tag nenhuma", async () => {
    const alheio = await novoContato(OUTRO);
    await expect(
      runWithTeam(TEAM, async () => tags.aplicarMudancaDeTags(alheio, { adicionadas: ["Soja"], removidas: [] })),
    ).rejects.toThrow();
    expect(await catalogo(TEAM)).toEqual([]);
    expect(await tagsNoCatalogoDe(alheio)).toEqual([]);
  });

  it("quem só lê (viewer) não grava tag", async () => {
    const id = await novoContato();
    await expect(
      runWithTeam(TEAM, async () => tags.aplicarMudancaDeTags(id, { adicionadas: ["Soja"], removidas: [] }), { userId: "leitor", role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await catalogo()).toEqual([]);
  });

  it("vincularTagsDoCadastro nunca derruba o cadastro: erro no catálogo vai para o log", async () => {
    const alheio = await novoContato(OUTRO);
    await expect(runWithTeam(TEAM, async () => tags.vincularTagsDoCadastro(alheio, ["Soja"]))).resolves.toBeUndefined();
    expect(await catalogo(TEAM)).toEqual([]);
  });
});

describe("tagsDoContato (o que a ficha e o formulário mostram)", () => {
  it("junta as tags do catálogo com as que só existem no campo legado, sem repetir", async () => {
    const id = await novoContato(TEAM, ["soja", "Antiga", TAG_NUMERO_ERRADO]);
    await poePorOutroCaminho(id, "Soja", "Milho");
    const mostradas = await runWithTeam(TEAM, async () => tags.tagsDoContato(id, ["soja", "Antiga", TAG_NUMERO_ERRADO]));
    expect(mostradas).toEqual(["Soja", "Milho", "Antiga", TAG_NUMERO_ERRADO]);
  });

  it("mantém a ordem em que as tags foram digitadas (não a alfabética nem a do banco)", async () => {
    const id = await novoContato();
    await poePorOutroCaminho(id, "Zebra", "Abacaxi", "Milho");
    expect(await runWithTeam(TEAM, async () => tags.tagsDoContato(id))).toEqual(["Zebra", "Abacaxi", "Milho"]);
    // Tag nova entra depois das que o contato já tinha.
    await poePorOutroCaminho(id, "Café");
    expect(await runWithTeam(TEAM, async () => tags.tagsDoContato(id))).toEqual(["Zebra", "Abacaxi", "Milho", "Café"]);
  });
});

describe("pelos caminhos do campo Tags", () => {
  it("contacts.create com tags: aparecem na barra de filtro (a queixa original) e o campo legado segue gravado", async () => {
    const c = await runWithTeam(TEAM, async () => contacts.create({ nome: "Ana", tags: ["Soja", "Milho"] }));
    await runWithTeam(TEAM, async () => {
      const barra = await tags.tagFilterSummary();
      expect(barra.tags.map((t) => t.nome).sort()).toEqual(["Milho", "Soja"]);
      expect(barra.semTag).toBe(0);
    });
    expect(await legadoDe(c.id)).toEqual(["Soja", "Milho"]);
    // Cadastro novo dispara o gatilho, como a atribuição manual.
    expect(tagAdicionada()).toHaveLength(2);
  });

  describe("contacts.update com a lista que a pessoa via ao abrir (tagsIniciais)", () => {
    it("salvar SEM mexer nas tags não toca em nada: não cataloga o que só estava no campo antigo nem dispara fluxo", async () => {
      // "Quente" só no campo antigo, e já existe como tag do time (com fluxo de "tag adicionada" na vida real).
      const id = await novoContato(TEAM, ["Quente", "Sem Canal"]);
      await runWithTeam(TEAM, async () => tags.createTag({ nome: "Quente" }));
      await runWithTeam(TEAM, async () =>
        contacts.update(id, { cargo: "Produtor", tags: ["Quente", "Sem Canal"], tagsIniciais: ["Quente", "Sem Canal"] }),
      );
      expect(await tagsNoCatalogoDe(id)).toEqual([]); // nada foi religado
      expect(await legadoDe(id)).toEqual(["Quente", "Sem Canal"]);
      expect(tagAdicionada()).toHaveLength(0);
    });

    it("tag que entrou por outro caminho enquanto a ficha estava aberta NÃO é apagada ao salvar", async () => {
      const c = await runWithTeam(TEAM, async () => contacts.create({ nome: "Ana", tags: ["Soja"] }));
      // A ficha foi aberta mostrando ["Soja"]. Antes de salvar, um fluxo/colega põe "Respondeu".
      await poePorOutroCaminho(c.id, "Respondeu");
      await basePrisma.contact.update({ where: { id: c.id }, data: { tags: { push: "Respondeu" } } });
      // A pessoa só acrescenta "Milho" e salva.
      await runWithTeam(TEAM, async () => contacts.update(c.id, { tags: ["Soja", "Milho"], tagsIniciais: ["Soja"] }));
      expect(await tagsNoCatalogoDe(c.id)).toEqual(["Milho", "Respondeu", "Soja"]);
      expect(await legadoDe(c.id)).toEqual(["Soja", "Respondeu", "Milho"]);
    });

    it("tirar uma tag no campo tira do catálogo e do campo legado; o resto fica", async () => {
      const c = await runWithTeam(TEAM, async () => contacts.create({ nome: "Ana", tags: ["Soja", "Milho"] }));
      await runWithTeam(TEAM, async () => contacts.update(c.id, { tags: ["milho"], tagsIniciais: ["Soja", "Milho"] }));
      expect(await tagsNoCatalogoDe(c.id)).toEqual(["Milho"]);
      expect(await legadoDe(c.id)).toEqual(["Milho"]);
    });

    it("tirar a pílula de uma tag que só estava no campo antigo a tira de lá; pôr outra não cataloga a antiga", async () => {
      const id = await novoContato(TEAM, ["Antiga", "Velha"]);
      await runWithTeam(TEAM, async () => contacts.update(id, { tags: ["Velha", "Nova"], tagsIniciais: ["Antiga", "Velha"] }));
      expect(await legadoDe(id)).toEqual(["Velha", "Nova"]);
      expect(await tagsNoCatalogoDe(id)).toEqual(["Nova"]); // "Velha" segue só no campo antigo até a migração
    });

    it("dispara 'tag adicionada' só para o vínculo que esta edição criou", async () => {
      const c = await runWithTeam(TEAM, async () => contacts.create({ nome: "Ana", tags: ["Soja"] }));
      enroll.mockClear();
      await runWithTeam(TEAM, async () => contacts.update(c.id, { tags: ["Soja", "Milho"], tagsIniciais: ["Soja"] }));
      expect(tagAdicionada()).toHaveLength(1);

      // Outra pessoa já tinha posto "Algodão" nesse meio-tempo: a edição dela não dispara de novo.
      enroll.mockClear();
      await poePorOutroCaminho(c.id, "Algodão");
      await runWithTeam(TEAM, async () => contacts.update(c.id, { tags: ["Soja", "Milho", "Algodão"], tagsIniciais: ["Soja", "Milho"] }));
      expect(tagAdicionada()).toHaveLength(0);
    });

    it("repetir o mesmo salvamento (erro e nova tentativa) não duplica nem dispara de novo", async () => {
      const c = await runWithTeam(TEAM, async () => contacts.create({ nome: "Ana", tags: ["Soja"] }));
      const pedido = { tags: ["Soja", "Milho"], tagsIniciais: ["Soja"] };
      await runWithTeam(TEAM, async () => contacts.update(c.id, pedido));
      enroll.mockClear();
      await runWithTeam(TEAM, async () => contacts.update(c.id, pedido));
      expect(tagAdicionada()).toHaveLength(0);
      expect(await tagsNoCatalogoDe(c.id)).toEqual(["Milho", "Soja"]);
      expect(await legadoDe(c.id)).toEqual(["Soja", "Milho"]);
    });
  });

  it("contacts.update SEM a lista inicial (API): `tags` é a lista final, relativa ao que o contato tem agora", async () => {
    const c = await runWithTeam(TEAM, async () => contacts.create({ nome: "Ana", tags: ["Soja", "Milho"] }));
    await poePorOutroCaminho(c.id, "Respondeu"); // só no catálogo
    await runWithTeam(TEAM, async () => contacts.update(c.id, { tags: ["Soja", "Algodão"] }));
    expect(await tagsNoCatalogoDe(c.id)).toEqual(["Algodão", "Soja"]); // Milho e Respondeu saíram: a lista é a final
    expect(await legadoDe(c.id)).toEqual(["Soja", "Algodão"]); // campo legado: como sempre, a lista como veio
  });

  it("contacts.update sem o campo tags não mexe em nada (edição rápida da lista, outras telas)", async () => {
    const c = await runWithTeam(TEAM, async () => contacts.create({ nome: "Ana", tags: ["Soja", "Milho"] }));
    await runWithTeam(TEAM, async () => contacts.update(c.id, { cargo: "Produtor" }));
    expect(await tagsNoCatalogoDe(c.id)).toEqual(["Milho", "Soja"]);
    expect(await legadoDe(c.id)).toEqual(["Soja", "Milho"]);
  });

  it("importCsv leva a coluna Tags para o catálogo, em lote, sem disparar 'tag adicionada'", async () => {
    const csv = [
      "nome,telefone,tags",
      'Ana,(11) 99999-0001,"Soja, Milho"',
      "Beto,(11) 99999-0002,soja",
      "Caio,(11) 99999-0003,",
    ].join("\n");
    const r = await runWithTeam(TEAM, async () => contacts.importCsv(csv));
    expect(r.created).toBe(3);
    expect(await catalogo()).toEqual(["Milho", "Soja"]); // "soja" e "Soja" são a mesma tag
    await runWithTeam(TEAM, async () => {
      const barra = await tags.tagFilterSummary();
      expect(barra.tags.map((t) => [t.nome, t.count]).sort()).toEqual([["Milho", 1], ["Soja", 2]]);
      expect(barra.semTag).toBe(1); // Caio veio sem tag
    });
    expect(tagAdicionada()).toHaveLength(0);
  });
});

describe("somarTagsEmLote e catalogarTagsLegadas (migração dos dados antigos)", () => {
  it("simular não grava nada; aplicar grava; rodar de novo não cria nada (idempotente)", async () => {
    const a = await novoContato(TEAM, ["Soja", "Milho"]);
    const b = await novoContato(TEAM, ["soja"]);
    const c = await novoContato(TEAM, [TAG_NUMERO_ERRADO]);
    await novoContato(TEAM, []);

    const ensaio = await runWithTeam(TEAM, async () => tags.catalogarTagsLegadas({ simular: true }));
    expect(ensaio).toMatchObject({ lidos: 3, contatos: 2, vinculosNovos: 3, deForaPeloMinimo: 0 });
    expect(ensaio.tagsNovas.sort()).toEqual(["Milho", "Soja"]);
    expect(await catalogo()).toEqual([]); // nada gravado

    const feito = await runWithTeam(TEAM, async () => tags.catalogarTagsLegadas());
    expect(feito).toMatchObject({ lidos: 3, contatos: 2, vinculosNovos: 3 });
    expect(await catalogo()).toEqual(["Milho", "Soja"]);
    expect(await tagsNoCatalogoDe(a)).toEqual(["Milho", "Soja"]);
    expect(await tagsNoCatalogoDe(b)).toEqual(["Soja"]);
    expect(await tagsNoCatalogoDe(c)).toEqual([]); // marca do sistema fica só no campo legado

    const denovo = await runWithTeam(TEAM, async () => tags.catalogarTagsLegadas());
    expect(denovo).toMatchObject({ vinculosNovos: 0, tagsNovas: [] });
    expect(denovo.todas[0]).toEqual({ nome: "Soja", contatos: 2 });
    expect(tagAdicionada()).toHaveLength(0); // migração nunca dispara fluxo
  });

  it("minimo: só entra tag usada por N contatos ou mais; o resto é contado, listado e não criado", async () => {
    await novoContato(TEAM, ["Soja", "Milho"]);
    await novoContato(TEAM, ["soja", "Raro"]);
    await novoContato(TEAM, ["Soja"]);
    const r = await runWithTeam(TEAM, async () => tags.catalogarTagsLegadas({ minimo: 2 }));
    expect(r.todas.map((t) => [t.nome, t.contatos])).toEqual([["Soja", 3], ["Milho", 1], ["Raro", 1]]);
    expect(r.deForaPeloMinimo).toBe(2);
    expect(await catalogo()).toEqual(["Soja"]);
    expect(r.vinculosNovos).toBe(3);
  });

  it("só soma: não tira o vínculo que o contato já tinha por outro caminho", async () => {
    const id = await novoContato(TEAM, ["Soja"]);
    await poePorOutroCaminho(id, "Manual");
    await runWithTeam(TEAM, async () => tags.catalogarTagsLegadas());
    expect(await tagsNoCatalogoDe(id)).toEqual(["Manual", "Soja"]);
  });

  it("só olha o time de quem chama", async () => {
    await novoContato(OUTRO, ["De outro time"]);
    const r = await runWithTeam(TEAM, async () => tags.catalogarTagsLegadas());
    expect(r.lidos).toBe(0);
    expect(await catalogo(OUTRO)).toEqual([]);
  });

  it("anda por páginas sem pular nem repetir contato", async () => {
    for (let i = 0; i < 5; i++) await novoContato(TEAM, [`Tag ${i % 2}`]);
    const r = await runWithTeam(TEAM, async () => tags.catalogarTagsLegadas({ lote: 2 }));
    expect(r).toMatchObject({ lidos: 5, contatos: 5, vinculosNovos: 5 });
    expect(await catalogo()).toEqual(["Tag 0", "Tag 1"]);
  });
});
