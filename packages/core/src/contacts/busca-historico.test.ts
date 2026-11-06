import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { basePrisma, runWithTeam } from "@crmagro/db";
import { list, listarContatosDaTela, listContactIds } from "./service";
import { AJUSTES_DA_BUSCA, esquecerPausasDoHistorico, buscarContatos, consultaDeHistorico, interpretarBusca, montarTrecho } from "./busca";
import { resolverBuscaDaExportacao } from "./export";

/**
 * Busca no HISTÓRICO do contato (busca.ts, PR 2): mensagens (WhatsApp e e-mail com o assunto), notas, e-mails do
 * histórico e ligações (transcrição, resumo, anotações). Palavra do dicionário português, começo de palavra,
 * sempre por time primeiro; só a tela de Contatos liga (`historico: true`).
 */
const TEAM = "00000000-0000-0000-0000-0000000b5c11";
const OUTRO = "00000000-0000-0000-0000-0000000b5c12";
const sufixo = Math.random().toString(36).slice(2, 7);

let master: { id: string }, vendA: { id: string }, vendB: { id: string };
const ids: Record<string, string> = {};

const comoDono = <T>(fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: master.id, role: "owner" });
const como = <T>(u: { id: string }, role: string, fn: () => Promise<T>) => runWithTeam(TEAM, fn, { userId: u.id, role });
const nomes = (r: { items: { nome: string }[] }) => r.items.map((c) => c.nome).sort();
const acha = async (search: string) => nomes(await comoDono(() => list({ search, historico: true, limit: 100 })));
const tela = (search: string) => comoDono(() => listarContatosDaTela({ search, historico: true }, { limit: 50, offset: 0 }));

async function limpar(teamId: string) {
  const w = { teamId };
  await basePrisma.call.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
}

async function contato(teamId: string, chave: string, dados: Record<string, unknown>) {
  const c = await basePrisma.contact.create({ data: { teamId, ...(dados as { nome: string }) } });
  ids[chave] = c.id;
  return c;
}

async function conversa(teamId: string, contactId: string, canal: "whatsapp" | "email", msgs: { texto?: string; assunto?: string; quando: Date; direcao?: "in" | "out" }[]) {
  const cv = await basePrisma.conversation.create({ data: { teamId, contactId, canal } });
  for (const m of msgs) {
    await basePrisma.message.create({
      data: {
        teamId,
        conversationId: cv.id,
        direcao: m.direcao ?? "in",
        tipo: "text",
        conteudo: m.texto ?? null,
        createdAt: m.quando,
        ...(m.assunto ? { meta: { subject: m.assunto } } : {}),
      },
    });
  }
  return cv;
}

const dia = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeAll(async () => {
  process.env.CONTATOS_CIFRA = "off";
  for (const [id, name] of [[TEAM, "Busca historico A (test)"], [OUTRO, "Busca historico B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar(TEAM);
  await limpar(OUTRO);
  await basePrisma.user.deleteMany({ where: { teamId: TEAM } });
  const mk = (n: string, role: string) => basePrisma.user.create({ data: { teamId: TEAM, name: n, email: `${n.toLowerCase().replace(/ /g, "")}-${sufixo}@hist.dev`, role } });
  master = await mk("Dono Historico", "owner");
  vendA = await mk("Vendedor Alfa", "member");
  vendB = await mk("Vendedor Beta", "member");

  const base = Date.now() - 900_000;
  const ana = await contato(TEAM, "ana", { nome: "Ana", sobrenome: "Teixeira", ownerId: vendA.id, createdAt: new Date(base + 1000) });
  const bruno = await contato(TEAM, "bruno", { nome: "Bruno", sobrenome: "Costa", ownerId: vendB.id, createdAt: new Date(base + 2000) });
  const carla = await contato(TEAM, "carla", { nome: "Carla", sobrenome: "Souza", ownerId: vendA.id, createdAt: new Date(base + 3000) });
  const diego = await contato(TEAM, "diego", { nome: "Diego", sobrenome: "Lima", ownerId: vendA.id, createdAt: new Date(base + 4000) });
  await contato(TEAM, "eva", { nome: "Eva", sobrenome: "Boleto", ownerId: vendA.id, createdAt: new Date(base + 5000) });

  // Conversas de WhatsApp.
  await conversa(TEAM, ana.id, "whatsapp", [
    { texto: "Bom dia, preciso do boleto da safra de soja para o financiamento do trator", quando: dia(30) },
    { texto: "Segue o comprovante, meu CPF é 123.456.789-09 para a nota", quando: dia(29), direcao: "out" },
  ]);
  await conversa(TEAM, bruno.id, "whatsapp", [{ texto: "Quero saber o preço da colheitadeira nova, as fazendas vizinhas já compraram", quando: dia(10) }]);
  await conversa(TEAM, carla.id, "whatsapp", [
    { texto: "Podemos marcar a visita na propriedade", quando: dia(5) },
    { texto: "O milho esta lindo, a chuva ajudou muito", quando: dia(4) },
  ]);
  // E-mail: o assunto fica em meta.subject; o corpo em conteudo.
  await conversa(TEAM, diego.id, "email", [{ texto: "Segue em anexo a proposta comercial conforme combinado.", assunto: "Orçamento de defensivos agrícolas", quando: dia(3) }]);

  // Notas e ligação.
  await basePrisma.activity.create({ data: { teamId: TEAM, contactId: carla.id, tipo: "note", conteudo: "Cliente pediu desconto no adubo e quer pagar na colheita", createdAt: dia(2) } as never });
  await basePrisma.activity.create({ data: { teamId: TEAM, contactId: ana.id, tipo: "stage_change", conteudo: "Movido para negociacao de aluguel", createdAt: dia(2) } as never });
  await basePrisma.call.create({
    data: {
      teamId: TEAM,
      contactId: diego.id,
      phoneNumber: "+5566900000001",
      direction: "outbound",
      status: "completed",
      provider: "manual",
      transcript: "Alo, aqui e do CRM Agro. Queria falar sobre o arrendamento da area de pastagem.",
      summary: "Interesse em arrendamento",
      notes: "Ligar de volta na quinta",
      createdAt: dia(1),
    },
  });

  // O OUTRO time tem as mesmas palavras: nada disso pode aparecer para o time A.
  const alheio = await contato(OUTRO, "alheio", { nome: "Fulano Alheio" });
  await conversa(OUTRO, alheio.id, "whatsapp", [{ texto: "boleto financiamento soja arrendamento defensivos", quando: dia(1) }]);
});

afterAll(async () => {
  AJUSTES_DA_BUSCA.simularEstouroDoHistorico = false;
  await limpar(TEAM);
  await limpar(OUTRO);
  await basePrisma.user.deleteMany({ where: { teamId: TEAM } });
});

describe("busca no histórico: mensagens, e-mails, notas e ligações", () => {
  it("acha por palavra de conversa de WhatsApp, sem acento nem maiúscula", async () => {
    expect(await acha("boleto")).toEqual(["Ana", "Eva"]); // Eva também tem "Boleto" no sobrenome (campo)
    expect(await acha("BOLETO")).toEqual(["Ana", "Eva"]);
    expect(await acha("colheitadeira")).toEqual(["Bruno"]);
    expect(await acha("COLHEITADEIRA")).toEqual(["Bruno"]);
    expect(await acha("safrá")).toEqual(["Ana"]);
  });

  it("palavra do dicionário: plural e singular se encontram", async () => {
    expect(await acha("fazenda")).toEqual(["Bruno"]);
    expect(await acha("fazendas")).toEqual(["Bruno"]);
    expect(await acha("colheitadeiras")).toEqual(["Bruno"]);
  });

  it("começo de palavra: quem ainda está digitando já acha", async () => {
    expect(await acha("financ")).toEqual(["Ana"]);
    expect(await acha("arrend")).toEqual(["Diego"]);
  });

  it("acha no assunto e no corpo do e-mail", async () => {
    expect(await acha("defensivos")).toEqual(["Diego"]);
    expect(await acha("orçamento")).toEqual(["Diego"]);
    expect(await acha("anexo")).toEqual(["Diego"]);
  });

  it("acha em nota e na ligação (transcrição, resumo e anotações)", async () => {
    expect(await acha("desconto")).toEqual(["Carla"]);
    expect(await acha("pastagem")).toEqual(["Diego"]);
    expect(await acha("interesse")).toEqual(["Diego"]);
    expect(await acha("quinta")).toEqual(["Diego"]);
  });

  it("registro de etapa do funil não entra na busca", async () => {
    expect(await acha("aluguel")).toEqual([]);
  });

  it("várias palavras: todas precisam estar no contato, em mensagens diferentes ou em campo e histórico", async () => {
    expect(await acha("visita milho")).toEqual(["Carla"]); // duas mensagens diferentes
    expect(await acha("visita desconto")).toEqual(["Carla"]); // conversa + nota
    expect(await acha("carla desconto")).toEqual(["Carla"]); // nome + nota
    expect(await acha("boleto colheitadeira")).toEqual([]);
  });

  it("só a tela de Contatos procura no histórico (os seletores não)", async () => {
    const semHistorico = nomes(await comoDono(() => list({ search: "boleto", limit: 100 })));
    expect(semHistorico).toEqual(["Eva"]);
    expect((await comoDono(() => listContactIds({ search: "desconto", historico: true }))).sort()).toEqual([ids.carla]);
    expect(await comoDono(() => listContactIds({ search: "desconto" }))).toEqual([]);
  });

  it("palavra de 2 letras ou stopword não procura no histórico (e não quebra)", async () => {
    expect(consultaDeHistorico(interpretarBusca("de")[0]!)).toBeNull();
    expect(await acha("para")).toEqual([]); // stopword do dicionário: a consulta fica vazia e nada acha, sem erro
  });
});

describe("busca no histórico: tenancy e escopo", () => {
  it("dois times: a mensagem do outro time nunca aparece", async () => {
    expect(await acha("arrendamento")).toEqual(["Diego"]);
    const doOutro = nomes(await runWithTeam(OUTRO, () => list({ search: "arrendamento", historico: true }), { userId: "u", role: "owner" }));
    expect(doOutro).toEqual(["Fulano Alheio"]);
    expect(nomes(await runWithTeam(OUTRO, () => list({ search: "colheitadeira", historico: true }), { userId: "u", role: "owner" }))).toEqual([]);
  });

  it("quem só vê os próprios contatos só acha o histórico dos próprios", async () => {
    const dosA = async (t: string) => nomes(await como(vendA, "member", () => list({ search: t, historico: true })));
    expect(await dosA("colheitadeira")).toEqual([]); // conversa do Bruno (do vendedor B)
    expect(await dosA("desconto")).toEqual(["Carla"]);
    expect(await como(vendA, "member", () => listContactIds({ search: "colheitadeira", historico: true }))).toEqual([]);
    const dosB = nomes(await como(vendB, "member", () => list({ search: "colheitadeira", historico: true })));
    expect(dosB).toEqual(["Bruno"]);
  });

  it("a exportação filtrada usa a mesma busca, histórico incluído", async () => {
    const f = await comoDono(() => resolverBuscaDaExportacao({ search: "pastagem" }));
    expect(f.ids).toEqual([ids.diego]);
  });
});

describe("busca no histórico: onde achou e trecho", () => {
  it("o selo diz a fonte e traz um trecho curto com a palavra", async () => {
    const t = await tela("colheitadeira");
    const a = t.achados[ids.bruno!]!;
    expect(a).toHaveLength(1);
    expect(a[0]!.rotulo).toBe("histórico (conversa)");
    expect(a[0]!.trecho!.achado.toLowerCase()).toContain("colheitadeira");
    const tudo = a[0]!.trecho!.antes + a[0]!.trecho!.achado + a[0]!.trecho!.depois;
    expect(tudo.length).toBeLessThanOrEqual(125);
    expect(tudo).toContain("preço");
  });

  it("e-mail, nota e ligação têm o próprio rótulo", async () => {
    expect((await tela("defensivos")).achados[ids.diego!]![0]!.rotulo).toBe("histórico (e-mail)");
    expect((await tela("desconto")).achados[ids.carla!]![0]!.rotulo).toBe("nota");
    expect((await tela("pastagem")).achados[ids.diego!]![0]!.rotulo).toBe("ligação");
  });

  it("o trecho mostra a mensagem mais RECENTE com a palavra", async () => {
    const t = await tela("milho");
    expect(t.achados[ids.carla!]![0]!.trecho!.achado.toLowerCase()).toBe("milho");
  });

  it("campo ganha do histórico: a palavra que já está no nome não vira trecho", async () => {
    const t = await tela("boleto");
    expect(t.achados[ids.eva!]!.map((a) => a.rotulo)).toEqual(["nome"]);
    expect(t.achados[ids.ana!]![0]!.rotulo).toBe("histórico (conversa)");
  });

  it("palavra de campo e palavra de histórico juntas: dois motivos", async () => {
    const t = await tela("carla desconto");
    expect(t.achados[ids.carla!]!.map((a) => a.rotulo)).toEqual(["nome", "nota"]);
  });

  it("CPF escrito na conversa nunca sai no trecho", async () => {
    const t = await tela("comprovante");
    const tr = t.achados[ids.ana!]![0]!.trecho!;
    const texto = tr.antes + tr.achado + tr.depois;
    expect(texto).not.toContain("123.456.789-09");
    expect(texto).not.toContain("12345678909");
    expect(texto).toContain("***");
  });

  it("montarTrecho: no máximo ~120 caracteres, destaca o começo da palavra até o fim dela e põe reticências", () => {
    const longo = `${"aaa ".repeat(30)}financiamento do trator ${"zzz ".repeat(30)}`;
    const pos = longo.indexOf("financiamento") + 1;
    const ini = Math.max(1, pos - 40);
    const tr = montarTrecho({ contactId: "x", fonte: "conversa", tam: longo.length, ini, trecho: longo.slice(ini - 1, ini - 1 + 120) }, ["financ"]);
    expect(tr.achado).toBe("financiamento");
    expect(tr.antes.startsWith("…")).toBe(true);
    expect(tr.depois.endsWith("…")).toBe(true);
    expect((tr.antes + tr.achado + tr.depois).length).toBeLessThanOrEqual(125);
  });
});

describe("busca no histórico: tempo limite", () => {
  it("se o histórico demora demais, refaz sem ele e avisa (a busca por campo não quebra)", async () => {
    AJUSTES_DA_BUSCA.simularEstouroDoHistorico = true;
    try {
      const r = await comoDono(() => buscarContatos({ search: "eva", historico: true }));
      expect(r?.historicoIndisponivel).toBe(true);
      expect(r?.ids).toEqual([ids.eva]);
      const t = await tela("boleto");
      expect(t.semHistorico).toBe(true);
      expect(t.items.map((c) => c.nome)).toEqual(["Eva"]); // sem o histórico, só o campo
      // O time fica um tempo sem tentar o histórico (não espera o limite a cada tecla)...
      AJUSTES_DA_BUSCA.simularEstouroDoHistorico = false;
      expect((await tela("boleto")).semHistorico).toBe(true);
      // ...e depois da pausa volta a procurar.
      esquecerPausasDoHistorico();
      const volta = await tela("boleto");
      expect(volta.semHistorico).toBe(false);
      expect(volta.items.map((c) => c.nome).sort()).toEqual(["Ana", "Eva"]);
    } finally {
      AJUSTES_DA_BUSCA.simularEstouroDoHistorico = false;
      esquecerPausasDoHistorico();
    }
  });
});
