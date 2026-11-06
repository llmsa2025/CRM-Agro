import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * Campanhas — core (produto §A.2, A.7): rascunho por etapas, lista com as
 * contagens exatas por motivo, prévia com variação e fallback, segurados e
 * dois times. Nada é enviado: a fila e a checagem externa são mockadas.
 */
const agendada = vi.fn(async (_x: unknown) => {});
vi.mock("./queue", () => ({
  agendarMontagemDaLista: (x: unknown) => agendada(x),
  getCampaignQueue: () => ({}),
}));
// "Tem WhatsApp?" (A.4) controlado pelo teste.
const semWhats = new Set<string>();
vi.mock("./tem-whatsapp", () => ({
  temWhatsApp: async (numeros: string[]) =>
    new Map(numeros.map((n) => [n, { existe: semWhats.has(n) ? false : null, nome: null }])),
}));
const gatilhos = vi.fn();
vi.mock("../flows/triggers", async (original) => ({
  ...(await original<typeof import("../flows/triggers")>()),
  safeEnrollByTrigger: (...a: unknown[]) => gatilhos(...a),
}));

const {
  createCampaign,
  saveStep,
  getCampaign,
  listCampaigns,
  prepararLista,
  montarLista,
  liberarSegurados,
  previewMessage,
  escolherVariacao,
  lerColados,
  CampaignNotFound,
} = await import("./service");

const TEAM = "00000000-0000-0000-0000-0000000003ab";
const OUTRO = "00000000-0000-0000-0000-0000000003ac";
const ADMIN = { userId: "admin", role: "admin" };
const MEMBRO = { userId: "membro", role: "member" };
const VIEWER = { userId: "leitor", role: "viewer" };
const sufixo = Math.random().toString(36).slice(2, 8);

let contaId = "";

beforeAll(async () => {
  for (const t of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id: t }, update: {}, create: { id: t, name: `Team Campanhas core ${t.slice(-2)} (test)` } });
  }
});

beforeEach(async () => {
  agendada.mockClear();
  gatilhos.mockClear();
  semWhats.clear();
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.campaignRecipient.deleteMany({ where: w });
  await basePrisma.campaign.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
  const conta = await basePrisma.channelAccount.create({
    data: { teamId: TEAM, canal: "whatsapp", label: "WA", provider: "evolution", externalId: `camp-${sufixo}`, status: "connected" },
  });
  contaId = conta.id;
});

async function contato(teamId: string, nome: string, numero: string, extra: Record<string, unknown> = {}) {
  const c = await basePrisma.contact.create({ data: { teamId, nome, ...extra } });
  await basePrisma.channelIdentifier.create({ data: { teamId, contactId: c.id, canal: "whatsapp", valor: numero, isPrimary: true } });
  return c;
}

const RITMO = {
  channelAccountId: "",
  janelaInicio: "08:30",
  janelaFim: "17:30",
  pausaAlmocoInicio: "11:30",
  pausaAlmocoFim: "13:30",
  intervaloMinS: 60,
  intervaloMaxS: 180,
  loteTamanho: 20,
  pausaLoteMinM: 15,
  pausaLoteMaxM: 25,
  freioSaidasPct: 3,
  freioFalhasSeq: 5,
};

describe("rascunho por etapas", () => {
  it("mensagem: recusa link e variável que o motor não preenche; ritmo: conta de outro time é recusada", async () => {
    const c = await runWithTeam(TEAM, () => createCampaign("Safra 26/27"));
    expect(c).toMatchObject({ status: "draft", etapa: 1 });
    await expect(runWithTeam(TEAM, () => saveStep(c.id, 2, { mensagem: "Veja https://x.com" }))).rejects.toThrow(/sem link/);
    await expect(runWithTeam(TEAM, () => saveStep(c.id, 2, { mensagem: "Oi {cultura}" }))).rejects.toThrow(/\{cultura\}/);
    const m = await runWithTeam(TEAM, () => saveStep(c.id, 2, { mensagem: "{saudacao}, {primeiro_nome|tudo bem}?" }));
    expect(m.etapa).toBe(3);

    const alheia = await basePrisma.channelAccount.create({
      data: { teamId: OUTRO, canal: "whatsapp", label: "B", provider: "evolution", externalId: `camp-b-${sufixo}`, status: "connected" },
    });
    await expect(runWithTeam(TEAM, () => saveStep(c.id, 3, { ...RITMO, channelAccountId: alheia.id }))).rejects.toMatchObject({
      name: "OwnedNotFound",
    });
    await expect(
      runWithTeam(TEAM, () => saveStep(c.id, 3, { ...RITMO, channelAccountId: contaId, intervaloMinS: 5 })),
    ).rejects.toThrow();
    const r = await runWithTeam(TEAM, () => saveStep(c.id, 3, { ...RITMO, channelAccountId: contaId, intervaloMaxS: 240 }));
    expect(r).toMatchObject({ channelAccountId: contaId, intervaloMaxS: 240, etapa: 4 });
  });

  it("viewer não cria campanha", async () => {
    await expect(runWithTeam(TEAM, () => createCampaign("x"), { userId: "v", role: "viewer" })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });
});

describe("lista: contagens exatas por motivo", () => {
  async function cenario() {
    const c = await runWithTeam(TEAM, () => createCampaign("Lista"));
    // Contatos que já existem, um por situação.
    const novo = await contato(TEAM, "Ana Paula", "+5565999000001");
    const conversou = await contato(TEAM, "Beto", "+5565999000002", { relacionamentoStatus: "ja_conversou" });
    const saiu = await contato(TEAM, "Caio", "+5565999000003", { relacionamentoStatus: "opt_out" });
    const recente = await contato(TEAM, "Duda", "+5565999000004");
    const semHist = await contato(TEAM, "Edu", "+5565999000005");
    const celular = await contato(TEAM, "Fabi", "+5565999000006");
    // Duda recebeu outra campanha há 5 dias.
    const antiga = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "Antiga", status: "done" } });
    await basePrisma.campaignRecipient.create({
      data: { teamId: TEAM, campaignId: antiga.id, contactId: recente.id, status: "sent", sentAt: new Date(Date.now() - 5 * 86_400_000) },
    });
    semWhats.add("+5565999000009");
    const texto = [
      "Ana Paula; +55 65 99900-0001",
      "65 9900-0001", // mesmo celular da Ana sem o nono dígito → repetido
      "Beto; 65999000002",
      "Caio, 65999000003",
      "65999000004",
      "65999000005",
      "65999000006",
      "Gil; 65999000007", // número novo → contato criado
      "abc", // inválido
      "65999000009", // sem WhatsApp
    ].join("\n");
    const { versao } = await runWithTeam(TEAM, () => prepararLista(c.id, { tipo: "colados", texto }));
    const historico = async ({ number }: { number: string }) =>
      number === "+5565999000005" ? null : number === "+5565999000006" ? true : false;
    return { c, versao, historico, ids: { novo, conversou, saiu, recente, semHist, celular } };
  }

  it("colados: 10 linhas → 1 inválida, 1 repetida, 1 sem WhatsApp; fila, segurados e pulados com o motivo", async () => {
    const { c, versao, historico, ids } = await cenario();
    expect(agendada).toHaveBeenCalledWith({ teamId: TEAM, campaignId: c.id, versao });
    const resumo = await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico }), ADMIN);
    expect(resumo).toEqual({
      linhas: 10,
      invalidos: 1,
      duplicados: 1,
      semWhatsApp: 1,
      contatosNovos: 1,
      fila: 2, // Ana + Gil
      segurados: 3, // Beto (já conversou) + Edu (histórico indisponível) + Fabi (histórico no celular)
      pulados: 2, // Caio (pediu para sair) + Duda (campanha há 5 dias)
      porMotivo: {
        "já conversou": 2,
        "histórico do WhatsApp indisponível": 1,
        "pediu para sair": 1,
        "campanha recente": 1,
      },
    });
    const dest = await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id }, select: { contactId: true, status: true, motivo: true } });
    const de = (id: string) => dest.find((d) => d.contactId === id);
    expect(de(ids.novo.id)).toMatchObject({ status: "queued", motivo: null });
    expect(de(ids.conversou.id)).toMatchObject({ status: "held", motivo: "já conversou" });
    expect(de(ids.saiu.id)).toMatchObject({ status: "skipped", motivo: "pediu para sair" });
    expect(de(ids.recente.id)).toMatchObject({ status: "skipped", motivo: "campanha há 5 dias" });
    expect(de(ids.semHist.id)).toMatchObject({ status: "held", motivo: "histórico do WhatsApp indisponível" });
    expect(de(ids.celular.id)).toMatchObject({ status: "held", motivo: "já conversou" });
    // Contato novo pela escrita canônica, com origem "campanha" e SEM o gatilho
    // contact_created (a campanha já é o primeiro contato).
    const gil = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM, nome: "Gil" } });
    expect(gil.origem).toBe("campanha");
    expect(gatilhos).not.toHaveBeenCalled();
    // Sem WhatsApp não vira contato.
    expect(await basePrisma.channelIdentifier.count({ where: { teamId: TEAM, valor: "+5565999000009" } })).toBe(0);
    const dto = await runWithTeam(TEAM, () => getCampaign(c.id));
    expect(dto.lista).toMatchObject({ estado: "pronta", versao, resumo: { fila: 2 } });
    expect(dto.contagem).toEqual({ queued: 2, held: 3, skipped: 2 });
  });

  it("refazer com a MESMA versão dá o mesmo resultado (retry do job); versão antiga não mexe; a lista bruta sai do banco", async () => {
    const { c, versao, historico } = await cenario();
    const r1 = await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico }), ADMIN);
    const r2 = await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico }), ADMIN);
    expect(r2).toEqual(r1);
    expect(await basePrisma.campaignRecipient.count({ where: { campaignId: c.id } })).toBe(7);
    expect(await basePrisma.contact.count({ where: { teamId: TEAM, nome: "Gil" } })).toBe(1);
    expect(await runWithTeam(TEAM, () => montarLista(c.id, "versao-velha", { historico }), ADMIN)).toBeNull();
    // LGPD: depois de montada, só o resumo — sem os telefones/nomes colados.
    const bruto = (await basePrisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).listaOrigem as Record<string, unknown>;
    expect(bruto).toMatchObject({ tipo: "colados", versao, estado: "pronta", contaDaChecagem: contaId });
    expect(bruto.texto).toBeUndefined();
    // E a tela não recebe a lista bruta nem o token da corrente.
    const dto = await runWithTeam(TEAM, () => getCampaign(c.id));
    expect("listaOrigem" in dto).toBe(false);
    expect("tickToken" in dto).toBe(false);
  });

  it("auditoria do #108: trocar a lista NO MEIO da montagem — a velha não sobrescreve a nova", async () => {
    const { c, versao: velha } = await cenario();
    let nova = "";
    let trocou = false;
    const historico = async () => {
      if (!trocou) {
        trocou = true;
        // Enquanto a velha checa o histórico, sobe a nova e ela termina primeiro.
        nova = (await prepararLista(c.id, { tipo: "colados", texto: "Zé; 65999000077" })).versao;
        await montarLista(c.id, nova, { historico: async () => false });
      }
      return false;
    };
    expect(await runWithTeam(TEAM, () => montarLista(c.id, velha, { historico }), ADMIN)).toBeNull();
    const dest = await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id }, select: { telefone: true } });
    expect(dest).toEqual([{ telefone: "+5565999000077" }]);
    expect((await runWithTeam(TEAM, () => getCampaign(c.id))).lista).toMatchObject({ versao: nova, estado: "pronta", resumo: { linhas: 1 } });
  });

  it("auditoria do #108: sem WhatsApp conectado para checar o histórico, ninguém vai para a fila sem checagem", async () => {
    const { c, versao } = await cenario();
    await basePrisma.channelAccount.update({ where: { id: contaId }, data: { status: "disconnected" } });
    const historico = vi.fn(async () => false);
    const r = await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico }), ADMIN);
    expect(historico).not.toHaveBeenCalled();
    expect(r).toMatchObject({ fila: 0, segurados: 5, pulados: 2 });
    expect(r?.porMotivo["histórico do WhatsApp indisponível"]).toBe(4); // Ana, Edu, Fabi, Gil
  });

  it("lista colada acima de 5000 linhas é recusada na hora", async () => {
    const c = await runWithTeam(TEAM, () => createCampaign("Grande"));
    const texto = Array.from({ length: 5001 }, (_, i) => `659${String(i).padStart(8, "0")}`).join("\n");
    await expect(runWithTeam(TEAM, () => prepararLista(c.id, { tipo: "colados", texto }))).rejects.toMatchObject({
      name: "ListaGrandeDemais",
    });
    expect(agendada).not.toHaveBeenCalled();
  });

  it("trocar a regra de quem já conversou reaplica sem remontar; liberar segurados: membro pode, viewer não", async () => {
    const { c, versao, historico } = await cenario();
    await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico }), ADMIN);
    await runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: "retomada" }));
    expect(await basePrisma.campaignRecipient.count({ where: { campaignId: c.id, status: "queued", motivo: "retomada" } })).toBe(2);
    // Histórico indisponível não é "já conversou": continua segurado.
    expect(await basePrisma.campaignRecipient.count({ where: { campaignId: c.id, status: "held" } })).toBe(1);

    // Campanha do time (F3): o teste é de papel, não de escopo por dono.
    await basePrisma.campaign.update({ where: { id: c.id }, data: { compartilhado: true } });
    await expect(runWithTeam(TEAM, () => liberarSegurados(c.id, "todos"), VIEWER)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await runWithTeam(TEAM, () => liberarSegurados(c.id, "todos"), MEMBRO)).toEqual({ liberados: 1 });
    expect(await basePrisma.campaignRecipient.count({ where: { campaignId: c.id, status: "held" } })).toBe(0);
  });

  it("regra \"recebeu na campanha X\": pula só quem teve mensagem ENVIADA em X; quem só conversou segue na fila", async () => {
    const { c, versao, historico, ids } = await cenario();
    const origem = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "Outra", status: "sending", compartilhado: true } });
    // Ana: mensagem enviada (não importa se chegou). Beto: ficou na fila, nunca recebeu.
    await basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: origem.id, contactId: ids.novo.id, status: "sent", sentAt: new Date() } });
    await basePrisma.campaignRecipient.create({ data: { teamId: TEAM, campaignId: origem.id, contactId: ids.conversou.id, status: "queued" } });
    await runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: `campanha:${origem.id}` }));
    await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico }), ADMIN);
    const de = (contactId: string) => basePrisma.campaignRecipient.findFirst({ where: { campaignId: c.id, contactId }, select: { status: true, motivo: true } });
    expect(await de(ids.novo.id)).toEqual({ status: "skipped", motivo: "recebeu em outra campanha" });
    expect(await de(ids.conversou.id)).toEqual({ status: "queued", motivo: "já conversou, mensagem normal" });

    // Trocar a regra devolve quem foi pulado por ela ao tratamento de "já conversou".
    await runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: "hold" }));
    expect(await de(ids.novo.id)).toEqual({ status: "held", motivo: "já conversou" });
    // E voltar à regra por campanha pula de novo, sem remontar a lista.
    await runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: `campanha:${origem.id}` }));
    expect(await de(ids.novo.id)).toEqual({ status: "skipped", motivo: "recebeu em outra campanha" });
  });

  it("regra por campanha recusa a própria campanha e a de outro time", async () => {
    const c = await runWithTeam(TEAM, () => createCampaign("Minha"));
    const alheia = await basePrisma.campaign.create({ data: { teamId: OUTRO, nome: "Alheia", compartilhado: true } });
    await expect(runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: `campanha:${c.id}` }))).rejects.toThrow();
    await expect(runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: `campanha:${alheia.id}` }))).rejects.toThrow();
    await expect(runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: "campanha:xyz" }))).rejects.toThrow();
  });

  it("regra \"enviar\" (Nenhuma): quem já conversou vai na fila com a mensagem normal, e dá para voltar a segurar", async () => {
    const { c, versao, historico } = await cenario();
    await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico }), ADMIN);
    await runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: "enviar" }));
    const normais = await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id, motivo: "já conversou, mensagem normal" }, select: { status: true } });
    expect(normais).toEqual([{ status: "queued" }, { status: "queued" }]);
    expect(await basePrisma.campaignRecipient.count({ where: { campaignId: c.id, motivo: "retomada" } })).toBe(0);

    await runWithTeam(TEAM, () => saveStep(c.id, 1, { regraJaConversou: "hold" }));
    expect(await basePrisma.campaignRecipient.count({ where: { campaignId: c.id, status: "held", motivo: "já conversou" } })).toBe(2);
  });
});

describe("prévia da mensagem", () => {
  it("variação determinística por contato; fallback quando o nome é só o número; retomada usa o texto de retomada", async () => {
    const c = await runWithTeam(TEAM, () => createCampaign("Prévia"));
    await runWithTeam(TEAM, () =>
      saveStep(c.id, 2, {
        mensagem: "Oi {primeiro_nome|tudo bem}, tudo certo na {empresa|fazenda}?",
        variacoes: ["Olá {primeiro_nome|pessoal}!"],
        textoRetomada: "Oi {primeiro_nome}, lembra da gente?",
      }),
    );
    const semNome = await contato(TEAM, "+55 65 99900-0010", "+5565999000010");
    const joao = await contato(TEAM, "João Silva", "+5565999000011", { empresa: "Fazenda Boa Vista" });
    const esperado = (id: string, nome: string) =>
      escolherVariacao(id, 1) === 0 ? `Oi ${nome.split(" ")[0] ?? ""}` : "Olá";

    const p1 = await runWithTeam(TEAM, () => previewMessage(c.id, semNome.id));
    expect(p1?.variacao).toBe(escolherVariacao(semNome.id, 1));
    expect(p1?.texto).toBe(p1?.variacao === 0 ? "Oi tudo bem, tudo certo na fazenda?" : "Olá pessoal!");
    const p2 = await runWithTeam(TEAM, () => previewMessage(c.id, joao.id));
    expect(p2?.texto.startsWith(esperado(joao.id, "João Silva"))).toBe(true);
    // Mesma entrada → mesma variação, sempre.
    expect(await runWithTeam(TEAM, () => previewMessage(c.id, joao.id))).toEqual(p2);

    await basePrisma.campaignRecipient.create({
      data: { teamId: TEAM, campaignId: c.id, contactId: joao.id, status: "queued", motivo: "retomada" },
    });
    expect((await runWithTeam(TEAM, () => previewMessage(c.id, joao.id)))?.texto).toBe("Oi João, lembra da gente?");
    // Sem texto de retomada: nada (segura) — nunca a mensagem fria para quem já conversou.
    await basePrisma.campaign.update({ where: { id: c.id }, data: { textoRetomada: null } });
    expect(await runWithTeam(TEAM, () => previewMessage(c.id, joao.id))).toBeNull();
  });

  it("lerColados: nome e telefone em qualquer ordem, separados por ; , ou tab", () => {
    expect(lerColados("Ana; 65 99900-0001\n\n65999000002\t Beto\n")).toEqual([
      { telefone: "65 99900-0001", nome: "Ana" },
      { telefone: "65999000002", nome: "Beto" },
    ]);
  });
});

describe("lista por filtro de contatos", () => {
  it("auditoria do #108: o MESMO celular em dois contatos (com e sem o nono dígito) recebe uma vez só", async () => {
    const c = await runWithTeam(TEAM, () => createCampaign("Nono dígito"));
    const com9 = await contato(TEAM, "Com 9", "+5566999997701");
    const sem9 = await contato(TEAM, "Sem 9", "+556699997701");
    const { versao } = await runWithTeam(TEAM, () => prepararLista(c.id, { tipo: "filtro", contactIds: [com9.id, sem9.id] }));
    const r = await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico: async () => false }), ADMIN);
    expect(r).toMatchObject({ linhas: 2, duplicados: 1, fila: 1 });
    expect(await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id }, select: { telefone: true } })).toEqual([
      { telefone: "+5566999997701" },
    ]);
  });

  it("contato sem número de WhatsApp e número sem WhatsApp ficam fora; repetido conta uma vez", async () => {
    const c = await runWithTeam(TEAM, () => createCampaign("Filtro"));
    const ok = await contato(TEAM, "Ok", "+5565999000041");
    const morto = await contato(TEAM, "Morto", "+5565999000042");
    const semNumero = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Sem número" } });
    semWhats.add("+5565999000042");
    const { versao } = await runWithTeam(TEAM, () =>
      prepararLista(c.id, { tipo: "filtro", contactIds: [ok.id, morto.id, semNumero.id, ok.id] }),
    );
    const r = await runWithTeam(TEAM, () => montarLista(c.id, versao, { historico: async () => false }), ADMIN);
    expect(r).toMatchObject({ linhas: 4, duplicados: 1, invalidos: 1, semWhatsApp: 1, fila: 1, contatosNovos: 0 });
    expect(await basePrisma.campaignRecipient.findMany({ where: { campaignId: c.id }, select: { contactId: true } })).toEqual([
      { contactId: ok.id },
    ]);
  });
});

describe("unificar contatos leva os destinatários de campanha", () => {
  it("move o que não conflita; na mesma campanha fica o mais adiantado — e 'pediu para sair' sempre vence", async () => {
    const { mergeContacts } = await import("../contacts/service");
    const c1 = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "C1" } });
    const c2 = await basePrisma.campaign.create({ data: { teamId: TEAM, nome: "C2" } });
    const fica = await contato(TEAM, "Fica", "+5565999000051");
    const dup = await contato(TEAM, "Dup", "+5565999000052");
    const enviadoEm = new Date(Date.now() - 86_400_000);
    await basePrisma.campaignRecipient.createMany({
      data: [
        { teamId: TEAM, campaignId: c1.id, contactId: fica.id, status: "sent", sentAt: enviadoEm },
        { teamId: TEAM, campaignId: c1.id, contactId: dup.id, status: "opted_out", motivo: "pediu para sair", sentAt: enviadoEm },
        { teamId: TEAM, campaignId: c2.id, contactId: dup.id, status: "replied", sentAt: enviadoEm, repliedAt: new Date() },
      ],
    });
    await runWithTeam(TEAM, () => mergeContacts(fica.id, [dup.id]), ADMIN);
    const depois = await basePrisma.campaignRecipient.findMany({
      where: { teamId: TEAM, campaignId: { in: [c1.id, c2.id] } },
      select: { campaignId: true, contactId: true, status: true, motivo: true },
      orderBy: { campaignId: "asc" },
    });
    expect(depois).toHaveLength(2);
    expect(depois.find((d) => d.campaignId === c1.id)).toEqual({ campaignId: c1.id, contactId: fica.id, status: "opted_out", motivo: "pediu para sair" });
    expect(depois.find((d) => d.campaignId === c2.id)).toMatchObject({ contactId: fica.id, status: "replied" });
  });
});

describe("dois times", () => {
  it("o time B não vê, não lê e não monta lista com contato do time A", async () => {
    const a = await runWithTeam(TEAM, () => createCampaign("Do A"));
    await runWithTeam(OUTRO, () => createCampaign("Do B"));
    expect((await runWithTeam(OUTRO, () => listCampaigns())).map((c) => c.nome)).toEqual(["Do B"]);
    await expect(runWithTeam(OUTRO, () => getCampaign(a.id))).rejects.toBeInstanceOf(CampaignNotFound);
    const doA = await contato(TEAM, "Lead A", "+5565999000020");
    const b = (await runWithTeam(OUTRO, () => listCampaigns()))[0]!;
    await expect(
      runWithTeam(OUTRO, () => prepararLista(b.id, { tipo: "filtro", contactIds: [doA.id] })),
    ).rejects.toMatchObject({ name: "OwnedNotFound" });
    await expect(runWithTeam(OUTRO, () => previewMessage(b.id, doA.id))).rejects.toMatchObject({ name: "OwnedNotFound" });
  });

  it("listCampaigns traz os contadores por status de cada campanha", async () => {
    const c = await runWithTeam(TEAM, () => createCampaign("Contadores"));
    const k1 = await contato(TEAM, "K1", "+5565999000031");
    const k2 = await contato(TEAM, "K2", "+5565999000032");
    await basePrisma.campaignRecipient.createMany({
      data: [
        { teamId: TEAM, campaignId: c.id, contactId: k1.id, status: "sent" },
        { teamId: TEAM, campaignId: c.id, contactId: k2.id, status: "queued" },
      ],
    });
    const [dto] = await runWithTeam(TEAM, () => listCampaigns());
    expect(dto?.contagem).toEqual({ sent: 1, queued: 1 });
  });
});
