import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { basePrisma } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";
import * as contacts from "./index";
import { normalizePhone, primaryEmail, primaryTelefone } from "./index";
import { parseContactsCsv } from "./csv";
import { receiveInbound } from "@crmagro/core";

// Limpeza SÓ dos times deste arquivo: a base de TESTE é compartilhada (outros
// arquivos e agentes em paralelo) — antes, deleteMany({}) apagava a base toda.
// Instância WA própria deste arquivo (resolve o inbound sem depender de ser a
// única conta do sistema).
const INST_A = `inst-a-${Math.random().toString(36).slice(2, 8)}`;
const TIMES_DO_ARQUIVO = ["00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000b2"];

// Times de teste (hex válido). DEV_TEAM_ID (000...001) é do seed — usamos outros.
const TEAM_A = "00000000-0000-0000-0000-0000000000a1";
const TEAM_B = "00000000-0000-0000-0000-0000000000b2";

beforeAll(async () => {
  // Cria os dois times de teste (basePrisma escapa da tenancy).
  for (const [id, name] of [
    [TEAM_A, "Team A (test)"],
    [TEAM_B, "Team B (test)"],
  ] as const) {
    await basePrisma.team.upsert({
      where: { id },
      update: { name },
      create: { id, name },
    });
  }
});

beforeEach(async () => {
  // Limpa entre testes (todos os times). Ordem respeita as FKs: message →
  // conversation → activity/identifier → contact. Inclui message/conversation
  // para os testes de receiveInbound serem determinísticos (idempotência).
  await basePrisma.message.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.conversation.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.activity.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.channelIdentifier.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
  await basePrisma.contact.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO } } });
});

describe("normalizePhone (E.164)", () => {
  it("normaliza formatos BR comuns", () => {
    expect(normalizePhone("(11) 99999-8888")).toBe("+5511999998888");
    expect(normalizePhone("11999998888")).toBe("+5511999998888");
    expect(normalizePhone("5511999998888")).toBe("+5511999998888");
    expect(normalizePhone("(55) 3222-1234")).toBe("+555532221234"); // fixo area 55
  });
  it("rejeita inválidos", () => {
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("parseContactsCsv (pure)", () => {
  it("valida linhas e coleta erros", () => {
    const csv = `nome,telefone,email\nJoão,(11) 99999-8888,joao@x.com\n,x,y\nMaria,invalido,maria@x.com\n`;
    const { valid, errors } = parseContactsCsv(csv);
    expect(valid.length).toBe(1);
    expect(valid[0]?.nome).toBe("João");
    expect(valid[0]?.telefone).toBe("(11) 99999-8888");
    expect(errors.length).toBe(2);
    expect(errors[0]?.row).toBe(3);
  });

  it("deduplica dentro do lote por telefone", () => {
    const csv = `nome,telefone\nA,(11) 99999-8888\nB,11999998888\n`; // mesmo phone, formatos diferentes
    const { valid } = parseContactsCsv(csv);
    expect(valid.length).toBe(1);
  });
});

describe("contacts service — isolamento por teamId", () => {
  it("team A não enxerga contatos do team B", async () => {
    await runWithTeam(TEAM_A, async () => {
      await contacts.create({ nome: "Contato A", email: "a@x.com", tags: [] });
    });
    await runWithTeam(TEAM_B, async () => {
      await contacts.create({ nome: "Contato B", email: "b@x.com", tags: [] });
    });

    const listaA = await runWithTeam(TEAM_A, async () => (await contacts.list()).items);
    const listaB = await runWithTeam(TEAM_B, async () => (await contacts.list()).items);

    expect(listaA).toHaveLength(1);
    expect(listaA[0]?.nome).toBe("Contato A");
    expect(listaB).toHaveLength(1);
    expect(listaB[0]?.nome).toBe("Contato B");
  });

  it("create injeta teamId do contexto e normaliza telefone/email em identifiers", async () => {
    const created = await runWithTeam(TEAM_A, async () =>
      await contacts.create({ nome: "Zé", telefone: "(11) 99999-8888", email: "ZE@X.com", tags: [] }),
    );
    expect(created.teamId).toBe(TEAM_A);
    expect(created.identifiers).toHaveLength(2);
    expect(primaryTelefone(created.identifiers)).toBe("+5511999998888");
    expect(primaryEmail(created.identifiers)).toBe("ze@x.com");

    // team B não consegue ler pelo id (fail-closed via escopo).
    const fromB = await runWithTeam(TEAM_B, async () => {
      try {
        await contacts.getById(created.id);
        return "vazou";
      } catch {
        return "isolado";
      }
    });
    expect(fromB).toBe("isolado");
  });

  it("getById lança ContactNotFound se não existir no time", async () => {
    await expect(
      runWithTeam(TEAM_A, async () => await contacts.getById("inexistente-id")),
    ).rejects.toThrow(/ContactNotFound/);
  });
});

describe("contacts service — CRUD", () => {
  it("create → getById → update → delete", async () => {
    const created = await runWithTeam(TEAM_A, async () =>
      await contacts.create({ nome: "Orig", empresa: "Corp", tags: ["lead"] }),
    );

    const got = await runWithTeam(TEAM_A, async () => await contacts.getById(created.id));
    expect(got.empresa).toBe("Corp");

    const updated = await runWithTeam(TEAM_A, async () =>
      await contacts.update(created.id, { nome: "Alt", telefone: "11988887777" }),
    );
    expect(updated.nome).toBe("Alt");
    expect(primaryTelefone(updated.identifiers)).toBe("+5511988887777");

    await runWithTeam(TEAM_A, async () => await contacts.remove(created.id));
    await expect(
      runWithTeam(TEAM_A, async () => await contacts.getById(created.id)),
    ).rejects.toThrow(/ContactNotFound/);
  });

  it("addNote cria Activity vinculada ao contato (no escopo do time)", async () => {
    const c = await runWithTeam(TEAM_A, async () => await contacts.create({ nome: "N", tags: [] }));
    const note = await runWithTeam(TEAM_A, async () => await contacts.addNote(c.id, "ligar amanhã"));
    expect(note.tipo).toBe("note");
    expect(note.contactId).toBe(c.id);

    const got = await runWithTeam(TEAM_A, async () => await contacts.getById(c.id));
    expect(got.activities).toHaveLength(1);
    expect(got.activities[0]?.conteudo).toBe("ligar amanhã");
  });
});

describe("contacts service — importCsv", () => {
  it("importa, deduplica contra o banco e reporta erros", async () => {
    const csv = `nome,telefone,email\nA1,(11) 99999-8888,a1@x.com\nA2,invalido,a2@x.com\nA3,(11) 99999-8888,a1@x.com\n`;
    const r1 = await runWithTeam(TEAM_A, async () => await contacts.importCsv(csv));
    expect(r1.created).toBe(1); // A1; A2 inválido; A3 = dup de A1
    expect(r1.errors.length).toBe(1);
    expect(r1.skipped).toBe(0); // A3 foi dedup do lote (csv.ts), não do banco

    // re-importar: A1 já existe no banco → skipped.
    const r2 = await runWithTeam(TEAM_A, async () =>
      await contacts.importCsv(`nome,telefone,email\nA1,(11) 99999-8888,a1@x.com\n`),
    );
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("importação no team A não vaza pro team B", async () => {
    await runWithTeam(TEAM_A, async () =>
      await contacts.importCsv(`nome,email\nSó A,a-only@x.com\n`),
    );
    const listaB = await runWithTeam(TEAM_B, async () => (await contacts.list()).items);
    expect(listaB).toHaveLength(0);
  });
});

describe("contacts service — relacionamentoStatus", () => {
  it("create nasce como 'novo' e setRelacionamentoStatus atualiza", async () => {
    const created = await runWithTeam(TEAM_A, async () =>
      await contacts.create({ nome: "Lead", tags: [] }),
    );
    expect(created.relacionamentoStatus).toBe("novo");

    await runWithTeam(TEAM_A, async () =>
      await contacts.setRelacionamentoStatus(created.id, "cliente"),
    );
    const got = await runWithTeam(TEAM_A, async () => await contacts.getById(created.id));
    expect(got.relacionamentoStatus).toBe("cliente");
  });

  it("hasInboundActivity: false antes, true após activity in", async () => {
    const c = await runWithTeam(TEAM_A, async () => await contacts.create({ nome: "X", tags: [] }));
    expect(await runWithTeam(TEAM_A, async () => await contacts.hasInboundActivity(c.id))).toBe(false);

    // nota é direcao out → não conta como inbound.
    await runWithTeam(TEAM_A, async () => await contacts.addNote(c.id, "nota"));
    expect(await runWithTeam(TEAM_A, async () => await contacts.hasInboundActivity(c.id))).toBe(false);

    await runWithTeam(TEAM_A, async () =>
      await basePrisma.activity.create({
        data: { teamId: TEAM_A, contactId: c.id, tipo: "whatsapp", direcao: "in", conteudo: "oi" },
      }),
    );
    expect(await runWithTeam(TEAM_A, async () => await contacts.hasInboundActivity(c.id))).toBe(true);
  });
});

describe("conversations.receiveInbound — identifier + relacionamentoStatus", () => {
  // receiveInbound é self-contained (resolve cross-team via basePrisma). Não
  // chama o canal — só grava Message/Activity.
  //
  // O inbound resolve o TIME pela ChannelAccount (instância) que recebeu — a
  // autoridade de tenant. A conta WA do TEAM_A tem instância PRÓPRIA do teste:
  // antes o arquivo apagava as contas WA de TODOS os times para cair no
  // fallback "conta única do sistema" (instance: null) — na base de TESTE
  // compartilhada isso atropelava os outros arquivos e o demo.
  beforeAll(async () => {
    await basePrisma.channelAccount.deleteMany({ where: { teamId: { in: TIMES_DO_ARQUIVO }, canal: "whatsapp" } });
    await basePrisma.channelAccount.create({
      data: {
        teamId: TEAM_A,
        canal: "whatsapp",
        label: "WhatsApp A (test)",
        provider: "evolution",
        status: "connected",
        externalId: INST_A,
        credentials: { instance: INST_A },
      } as never,
    });
  });

  it("número novo NÃO cria contato — vira conversa com externalNumber/externalName", async () => {
    await receiveInbound({
      from: "+5511999990001",
      fromMe: false,
      text: "olá",
      providerMessageId: "inb-1",
      timestamp: null,
      instance: INST_A,
      name: "Novo Lead",
    });

    // não cria Contact/identifier
    const ident = await basePrisma.channelIdentifier.findFirst({
      where: { teamId: TEAM_A, canal: "whatsapp", valor: "+5511999990001" },
    });
    expect(ident).toBeNull();

    // cria conversa "solta" com o número + pushName
    const conv = await basePrisma.conversation.findFirst({
      where: { teamId: TEAM_A, externalNumber: "+5511999990001" },
    });
    expect(conv).toBeTruthy();
    expect(conv?.contactId).toBeNull();
    expect(conv?.externalName).toBe("Novo Lead");
  });

  it("contato novo (criado manualmente antes) vira ja_conversou no primeiro inbound", async () => {
    const c = await runWithTeam(TEAM_A, async () =>
      await contacts.create({ nome: "Manual", telefone: "+5511999990002", tags: [] }),
    );
    expect(c.relacionamentoStatus).toBe("novo");

    await receiveInbound({
      from: "+5511999990002",
      fromMe: false,
      text: "oi",
      providerMessageId: "inb-2",
      timestamp: null,
      instance: INST_A,
      name: null,
    });

    const got = await runWithTeam(TEAM_A, async () => await contacts.getById(c.id));
    expect(got.relacionamentoStatus).toBe("ja_conversou");
  });

  // Regressão do bug mais grave encontrado em produção: o contato estava
  // cadastrado COM o nono dígito e o WhatsApp entregava SEM ele. A busca era
  // por string exata, o contato não era achado, a conversa nascia "solta" e
  // NENHUMA Activity era criada — deixando a condição "respondeu?" do motor de
  // fluxos cega para respostas que existiam.
  it("casa o contato quando o inbound vem SEM o nono dígito", async () => {
    const c = await runWithTeam(TEAM_A, async () =>
      await contacts.create({ nome: "Nono Digito", telefone: "+5566999997701", tags: [] }),
    );

    await receiveInbound({
      from: "+556699997701", // sem o 9 — como o WhatsApp entrega
      fromMe: false,
      text: "Oi quem é?",
      providerMessageId: "inb-9d-1",
      timestamp: null,
      instance: INST_A,
      name: null,
    });

    // vinculou ao contato (e não criou conversa solta)
    const conv = await basePrisma.conversation.findFirst({ where: { contactId: c.id } });
    expect(conv).toBeTruthy();
    expect(conv?.externalNumber).toBeNull();

    // e gravou a Activity inbound — o insumo que o motor lê para "respondeu?"
    const act = await basePrisma.activity.findFirst({ where: { contactId: c.id, direcao: "in" } });
    expect(act).toBeTruthy();

    const got = await runWithTeam(TEAM_A, async () => await contacts.getById(c.id));
    expect(got.relacionamentoStatus).toBe("ja_conversou");
  });

  it("casa o contato no sentido inverso (cadastro sem 9, inbound com 9)", async () => {
    const c = await runWithTeam(TEAM_A, async () =>
      await contacts.create({ nome: "Inverso", telefone: "+556632221111", tags: [] }),
    );

    await receiveInbound({
      from: "+5566932221111",
      fromMe: false,
      text: "oi",
      providerMessageId: "inb-9d-2",
      timestamp: null,
      instance: INST_A,
      name: null,
    });

    const act = await basePrisma.activity.findFirst({ where: { contactId: c.id, direcao: "in" } });
    expect(act).toBeTruthy();
  });

  it("idempotente por providerMessageId", async () => {
    await receiveInbound({
      from: "+5511999990003",
      fromMe: false,
      text: "dup",
      providerMessageId: "inb-dup",
      timestamp: null,
      instance: INST_A,
      name: null,
    });
    await receiveInbound({
      from: "+5511999990003",
      fromMe: false,
      text: "dup",
      providerMessageId: "inb-dup",
      timestamp: null,
      instance: INST_A,
      name: null,
    });
    const msgs = await basePrisma.message.findMany({ where: { teamId: TEAM_A, providerMessageId: "inb-dup" } });
    expect(msgs).toHaveLength(1);
  });

  it("fromMe (enviada fora da plataforma) grava como SAÍDA — não descarta", async () => {
    await receiveInbound({
      from: "+5511999990010",
      fromMe: true,
      text: "mensagem enviada pelo celular",
      providerMessageId: "out-ext-1",
      timestamp: null,
      instance: INST_A,
      name: null,
    });
    const m = await basePrisma.message.findFirst({ where: { teamId: TEAM_A, providerMessageId: "out-ext-1" } });
    expect(m).toBeTruthy();
    expect(m?.direcao).toBe("out");
    expect(m?.status).toBe("sent");
  });

  it("fromMe NÃO muda relacionamentoStatus (só o contato respondendo faz isso)", async () => {
    const c = await runWithTeam(TEAM_A, async () =>
      await contacts.create({ nome: "Só Saída", telefone: "+5511999990011", tags: [] }),
    );
    expect(c.relacionamentoStatus).toBe("novo");
    await receiveInbound({
      from: "+5511999990011",
      fromMe: true,
      text: "oi, tudo bem?",
      providerMessageId: "out-ext-2",
      timestamp: null,
      instance: INST_A,
      name: null,
    });
    const got = await runWithTeam(TEAM_A, async () => await contacts.getById(c.id));
    expect(got.relacionamentoStatus).toBe("novo");
    // e a mensagem saiu como "out" na conversa do contato
    const act = await basePrisma.activity.findFirst({
      where: { contactId: c.id, tipo: "whatsapp", direcao: "out" },
    });
    expect(act).toBeTruthy();
  });

  it("eco fromMe do envio da plataforma NÃO duplica (dedup por providerMessageId)", async () => {
    await receiveInbound({
      from: "+5511999990012",
      fromMe: true,
      text: "enviada pela plataforma",
      providerMessageId: "out-echo-1",
      timestamp: null,
      instance: INST_A,
      name: null,
    });
    // eco do mesmo providerMessageId (a Evolution reemite o messages.upsert)
    await receiveInbound({
      from: "+5511999990012",
      fromMe: true,
      text: "enviada pela plataforma",
      providerMessageId: "out-echo-1",
      timestamp: null,
      instance: INST_A,
      name: null,
    });
    const msgs = await basePrisma.message.findMany({ where: { teamId: TEAM_A, providerMessageId: "out-echo-1" } });
    expect(msgs).toHaveLength(1);
  });
});

