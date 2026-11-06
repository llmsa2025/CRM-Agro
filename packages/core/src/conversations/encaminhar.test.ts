import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { basePrisma, encryptCredentials } from "@crmagro/db";
import { runWithTeam } from "../test-support/identidade";

/**
 * "Compartilhar" (encaminhar) mensagem das Conversas.
 *
 * TUDO FALSO: a Evolution e o SMTP são mocks (nada vai à rede), o Storage é um
 * mock que devolve bytes inventados. Cobre o que o servidor precisa garantir
 * sozinho, sem confiar na tela: canal diferente recusado, outro time recusado,
 * sem permissão recusado, mídia reenviada a partir do arquivo guardado, falha
 * parcial dita por destino, e as travas de controle de ritmo (cota, pausa, "já
 * conversou?", opt-out, limites de 5 destinos e 10 mensagens).
 */
vi.mock("../flows/queue", () => ({ scheduleStep: vi.fn(), getFlowQueue: () => ({}) }));

const fake = vi.hoisted(() => {
  let n = 0;
  return {
    send: vi.fn(async (_ref: unknown, _entrada: unknown) => ({ providerMessageId: `FAKE-T-${Date.now()}-${n++}` })),
    sendMedia: vi.fn(async (_ref: unknown, _entrada: unknown) => ({ providerMessageId: `FAKE-M-${Date.now()}-${n++}` })),
    smtp: vi.fn(async (_ref: unknown, _entrada: unknown) => ({ providerMessageId: `<fake-${Date.now()}-${n++}@teste>` })),
    baixar: vi.fn(async (caminho: string) => new TextEncoder().encode(`bytes-de-${caminho}`)),
  };
});
vi.mock("@crmagro/channels", async (original) => ({
  ...(await original<typeof import("@crmagro/channels")>()),
  getChannelProvider: (ref: { canal: string }) =>
    ref.canal === "email"
      ? { send: (i: unknown) => fake.smtp(ref, i) }
      : { send: (i: unknown) => fake.send(ref, i), sendMedia: (i: unknown) => fake.sendMedia(ref, i) },
}));
vi.mock("../storage/service", async (original) => ({
  ...(await original<typeof import("../storage/service")>()),
  storageEnabled: () => true,
  baixarArquivo: (caminho: string) => fake.baixar(caminho),
}));

const {
  encaminharMensagens,
  listarDestinosDeEncaminhamento,
  recusaDoDestino,
  assuntoEncaminhado,
  montarCorpoEncaminhado,
  EncaminhamentoInvalido,
} = await import("./encaminhar");

const TEAM = "00000000-0000-0000-0000-0000000e1c01";
const TEAM_B = "00000000-0000-0000-0000-0000000e1c02";
const sufixo = Math.random().toString(36).slice(2, 8);
const EU = { userId: "user-eu", role: "member" } as const;
const T0 = new Date("2026-09-01T12:00:00Z").getTime();

type Fx = Awaited<ReturnType<typeof montar>>;
let fx: Fx;

const sem = { espacoMs: 0 };
const doTime = <T>(fn: () => T | Promise<T>) => runWithTeam(TEAM, fn);
const comoMembro = <T>(fn: () => T | Promise<T>) => runWithTeam(TEAM, fn, EU);
const encaminhar = (messageIds: string[], destinoIds: string[], opts = sem) =>
  doTime(() => encaminharMensagens({ messageIds, destinoIds }, opts));

async function limpar() {
  for (const teamId of [TEAM, TEAM_B]) {
    const w = { teamId };
    await basePrisma.activity.deleteMany({ where: w });
    await basePrisma.message.deleteMany({ where: w });
    await basePrisma.conversation.deleteMany({ where: w });
    await basePrisma.channelAccountUsage.deleteMany({ where: w });
    await basePrisma.channelIdentifier.deleteMany({ where: w });
    await basePrisma.contact.deleteMany({ where: w });
    await basePrisma.channelAccount.deleteMany({ where: w });
  }
}

/** Conta de WhatsApp (Evolution) ou de e-mail (SMTP) com as credenciais no formato de cada uma. */
async function conta(teamId: string, canal: "whatsapp" | "email", label: string, extra: Partial<Prisma.ChannelAccountUncheckedCreateInput> = {}) {
  const credentials =
    canal === "email"
      ? (encryptCredentials({ host: "smtp.crmagro.test", port: 465, secure: true, user: `u-${sufixo}`, pass: "x", from: "vendas@crmagro.test" }) as unknown as Prisma.InputJsonValue)
      : ({ instance: `${label}-${sufixo}` } as Prisma.InputJsonValue);
  const c = await basePrisma.channelAccount.create({
    data: {
      teamId,
      canal,
      label,
      provider: canal === "email" ? "smtp" : "evolution",
      status: "connected",
      credentials,
      ...(canal === "whatsapp" ? { externalId: `${label}-${teamId.slice(-2)}-${sufixo}` } : {}),
      ...extra,
    },
  });
  return c.id;
}

/** Contato com telefone (WhatsApp) ou e-mail, e a conversa dele na conta. Sem `mensagens`: conversa sem histórico. */
async function conversa(opts: {
  teamId?: string;
  contaId: string;
  canal?: "whatsapp" | "email";
  nome: string;
  identificador: string;
  status?: "novo" | "ja_conversou" | "cliente" | "opt_out";
  mensagens?: number;
}) {
  const teamId = opts.teamId ?? TEAM;
  const canal = opts.canal ?? "whatsapp";
  const contato = await basePrisma.contact.create({
    data: { teamId, nome: opts.nome, ...(opts.status ? { relacionamentoStatus: opts.status } : {}) },
  });
  await basePrisma.channelIdentifier.create({ data: { teamId, contactId: contato.id, canal, valor: opts.identificador, isPrimary: true } });
  const conv = await basePrisma.conversation.create({
    data: {
      teamId,
      contactId: contato.id,
      canal,
      channelAccountId: opts.contaId,
      status: "open",
      ...(opts.mensagens ? { lastMessageAt: new Date(T0) } : {}),
    },
  });
  for (let i = 0; i < (opts.mensagens ?? 0); i++) {
    await basePrisma.message.create({
      data: { teamId, conversationId: conv.id, direcao: "in", tipo: "text", conteudo: `oi ${i}`, status: "delivered", createdAt: new Date(T0 + i) },
    });
  }
  return conv.id;
}

type MsgIn = {
  conversationId: string;
  ordem: number;
  tipo?: "text" | "image" | "audio" | "doc";
  conteudo?: string | null;
  mediaPath?: string | null;
  mediaMime?: string | null;
  direcao?: "in" | "out";
  meta?: Prisma.InputJsonValue;
  teamId?: string;
};
async function mensagem(m: MsgIn) {
  const r = await basePrisma.message.create({
    data: {
      teamId: m.teamId ?? TEAM,
      conversationId: m.conversationId,
      direcao: m.direcao ?? "out",
      tipo: m.tipo ?? "text",
      conteudo: m.conteudo ?? null,
      mediaPath: m.mediaPath ?? null,
      mediaMime: m.mediaMime ?? null,
      status: "sent",
      createdAt: new Date(T0 + 60_000 + m.ordem * 1000),
      ...(m.meta ? { meta: m.meta } : {}),
    },
  });
  return r.id;
}

async function montar() {
  // Contas do time: a minha (WA1) e duas de colegas (outro número e outra pessoa).
  const wa1 = await conta(TEAM, "whatsapp", "Comercial", { ownerId: "user-eu" });
  const wa2 = await conta(TEAM, "whatsapp", "Suporte", { ownerId: "user-outro" });
  const em = await conta(TEAM, "email", "Caixa", { ownerId: "user-eu" });
  const waB = await conta(TEAM_B, "whatsapp", "Comercial", { ownerId: "user-b" });

  const origem = await conversa({ contaId: wa1, nome: "Ana", identificador: "5565911110001", status: "ja_conversou", mensagens: 1 });
  const bruno = await conversa({ contaId: wa1, nome: "Bruno", identificador: "5565911110002", status: "ja_conversou", mensagens: 2 });
  const eva = await conversa({ contaId: wa2, nome: "Eva", identificador: "5565911110005", status: "ja_conversou", mensagens: 1 });
  const ze = await conversa({ contaId: wa2, nome: "Zé", identificador: "5565911110006", status: "cliente", mensagens: 1 });
  const carla = await conversa({ contaId: wa1, nome: "Carla", identificador: "5565911110003", status: "opt_out", mensagens: 1 });
  const dora = await conversa({ contaId: wa1, nome: "Dora", identificador: "5565911110004", status: "novo" });
  // Contato "ja_conversou" (o celular já tinha histórico) que nunca trocou mensagem aqui: pode receber.
  const gil = await conversa({ contaId: wa1, nome: "Gil", identificador: "5565911110007", status: "ja_conversou" });
  const fabio = await conversa({ contaId: em, canal: "email", nome: "Fábio", identificador: "fabio@cliente.test", status: "ja_conversou", mensagens: 1 });
  const gabi = await conversa({ contaId: em, canal: "email", nome: "Gabi", identificador: "gabi@cliente.test", status: "ja_conversou", mensagens: 1 });
  const convB = await conversa({ teamId: TEAM_B, contaId: waB, nome: "Outro time", identificador: "5511900000001", status: "ja_conversou", mensagens: 1 });

  const m = {
    texto: await mensagem({ conversationId: origem, ordem: 1, conteudo: "Olá, segue a proposta" }),
    imagem: await mensagem({ conversationId: origem, ordem: 2, tipo: "image", conteudo: "Foto da obra", mediaPath: `${origem}/img.png`, mediaMime: "image/png" }),
    audio: await mensagem({ conversationId: origem, ordem: 3, tipo: "audio", direcao: "in", mediaPath: `${origem}/voz.ogg`, mediaMime: "audio/ogg; codecs=opus" }),
    doc: await mensagem({ conversationId: origem, ordem: 4, tipo: "doc", mediaPath: `${origem}/proposta.pdf`, mediaMime: "application/pdf" }),
    semArquivo: await mensagem({ conversationId: origem, ordem: 5, tipo: "image", mediaPath: null, mediaMime: "image/png" }),
    bloqueado: await mensagem({ conversationId: origem, ordem: 6, tipo: "doc", mediaPath: `${origem}/programa.exe`, mediaMime: "application/x-msdownload" }),
    vazio: await mensagem({ conversationId: origem, ordem: 7, conteudo: "   " }),
    email: await mensagem({
      conversationId: fabio,
      ordem: 1,
      direcao: "in",
      conteudo: "Segue o orçamento",
      meta: { subject: "Orçamento", from: "fabio@cliente.test", to: "vendas@crmagro.test" },
    }),
    deOutroTime: await mensagem({ teamId: TEAM_B, conversationId: convB, ordem: 1, conteudo: "segredo do outro time" }),
  };
  return { wa1, wa2, em, waB, origem, bruno, eva, ze, carla, dora, gil, fabio, gabi, convB, m };
}

const linhasDe = (conversationId: string) =>
  basePrisma.message.findMany({ where: { conversationId, direcao: "out", providerMessageId: { not: null } }, orderBy: { createdAt: "asc" } });
const usoDaConta = async (contaId: string) => (await basePrisma.channelAccountUsage.findFirst({ where: { channelAccountId: contaId } }))?.sent ?? 0;
const instanciaDe = (ref: unknown) => (ref as { credentials?: { instance?: string } }).credentials?.instance;

beforeAll(async () => {
  await basePrisma.team.upsert({ where: { id: TEAM }, update: {}, create: { id: TEAM, name: "Encaminhar (e1c01)" } });
  await basePrisma.team.upsert({ where: { id: TEAM_B }, update: {}, create: { id: TEAM_B, name: "Encaminhar outro time (e1c02)" } });
});

beforeEach(async () => {
  fake.send.mockClear();
  fake.sendMedia.mockClear();
  fake.smtp.mockClear();
  fake.baixar.mockClear();
  await limpar();
  fx = await montar();
});

afterAll(async () => {
  await limpar();
});

describe("regras puras", () => {
  const base = { lastMessageAt: new Date(), contactId: "c1", externalNumber: null, contact: { relacionamentoStatus: "ja_conversou" } };
  it("recusa quem pediu para sair, mesmo com histórico", () => {
    expect(recusaDoDestino({ ...base, contact: { relacionamentoStatus: "opt_out" } }, "whatsapp")).toMatch(/pediu para sair/);
  });
  it("já conversou = tem mensagem OU o contato já não é novo", () => {
    expect(recusaDoDestino(base, "whatsapp")).toBeNull();
    expect(recusaDoDestino({ ...base, lastMessageAt: null }, "whatsapp")).toBeNull(); // ja_conversou pelo celular
    expect(recusaDoDestino({ ...base, lastMessageAt: null, contact: { relacionamentoStatus: "cliente" } }, "whatsapp")).toBeNull();
    expect(recusaDoDestino({ ...base, lastMessageAt: null, contact: { relacionamentoStatus: "novo" } }, "whatsapp")).toMatch(/Ainda não houve conversa/);
    expect(recusaDoDestino({ ...base, lastMessageAt: null, contactId: null, contact: null, externalNumber: "5565900000000" }, "whatsapp")).toMatch(/Ainda não houve conversa/);
    expect(recusaDoDestino({ ...base, contact: { relacionamentoStatus: "novo" } }, "whatsapp")).toBeNull(); // novo, mas já tem mensagem
  });
  it("conversa antiga sem telefone (@lid) não recebe", () => {
    expect(recusaDoDestino({ ...base, contactId: null, contact: null, externalNumber: "123@lid" }, "whatsapp")).toMatch(/não tem telefone/);
  });
  it("assunto: Fwd sem empilhar", () => {
    expect(assuntoEncaminhado("Orçamento")).toBe("Fwd: Orçamento");
    expect(assuntoEncaminhado("Fwd: Orçamento")).toBe("Fwd: Orçamento");
    expect(assuntoEncaminhado("FW: Enc: Orçamento")).toBe("Fwd: Orçamento");
    expect(assuntoEncaminhado("")).toBe("Fwd: (sem assunto)");
    expect(assuntoEncaminhado(null)).toBe("Fwd: (sem assunto)");
  });
  it("corpo do e-mail: cabeçalho do original e o texto, sem travessão", () => {
    const corpo = montarCorpoEncaminhado(
      [{ de: "a@x.test", para: "b@x.test", assunto: "Oi", data: new Date("2026-09-30T17:05:00Z"), corpo: "Texto" }],
      "America/Sao_Paulo",
    );
    expect(corpo).toBe("Mensagem encaminhada\n\nDe: a@x.test\nPara: b@x.test\nData: 30/09/2026 14:05\nAssunto: Oi\n\nTexto");
    expect(corpo).not.toMatch(/[—–]/);
  });
});

describe("limites do pedido (nada é enviado)", () => {
  it("sem mensagem, sem destino, mais de 10 mensagens, mais de 5 destinos", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    await expect(encaminhar([], [fx.bruno])).rejects.toThrow("Escolha ao menos uma mensagem.");
    await expect(encaminhar([fx.m.texto], [])).rejects.toThrow("Escolha ao menos uma conversa.");
    await expect(encaminhar(ids(11), [fx.bruno])).rejects.toThrow("Encaminhe até 10 mensagens por vez.");
    await expect(encaminhar([fx.m.texto], ids(6))).rejects.toThrow("Escolha até 5 conversas por vez.");
    await expect(encaminhar([fx.m.texto], ids(6))).rejects.toBeInstanceOf(EncaminhamentoInvalido);
    expect(fake.send).not.toHaveBeenCalled();
  });
  it("no limite (10 e 5) passa; ids repetidos contam uma vez", async () => {
    const r = await encaminhar([fx.m.texto, fx.m.texto], [fx.bruno, fx.bruno]);
    expect(r.destinos).toHaveLength(1);
    expect(fake.send).toHaveBeenCalledTimes(1);
  });
});

describe("texto", () => {
  it("sai como texto para cada destino, pela conta DE CADA destino (inclusive outro número do time)", async () => {
    const r = await encaminhar([fx.m.texto], [fx.bruno, fx.eva]);
    expect(r).toMatchObject({ ok: 2, falhas: 0 });
    expect(r.destinos.map((d) => [d.nome, d.enviadas, d.total, d.erro])).toEqual([
      ["Bruno", 1, 1, null],
      ["Eva", 1, 1, null],
    ]);
    expect(fake.send).toHaveBeenCalledTimes(2);
    const [[ref1, in1], [ref2, in2]] = fake.send.mock.calls as unknown as [[unknown, { to: string; content: { text: string } }], [unknown, { to: string; content: { text: string } }]];
    expect(instanciaDe(ref1)).toBe(`Comercial-${sufixo}`);
    expect(in1).toMatchObject({ to: "5565911110002", content: { text: "Olá, segue a proposta" } });
    expect(instanciaDe(ref2)).toBe(`Suporte-${sufixo}`);
    expect(in2).toMatchObject({ to: "5565911110005", content: { text: "Olá, segue a proposta" } });
    expect((await linhasDe(fx.bruno)).map((l) => [l.tipo, l.conteudo])).toEqual([["text", "Olá, segue a proposta"]]);
    expect((await linhasDe(fx.eva)).map((l) => [l.tipo, l.conteudo])).toEqual([["text", "Olá, segue a proposta"]]);
  });

  it("várias mensagens saem na ordem em que aconteceram, mesmo pedidas fora de ordem", async () => {
    const outra = await mensagem({ conversationId: fx.origem, ordem: 0, conteudo: "primeira" });
    await encaminhar([fx.m.texto, outra], [fx.bruno]);
    const textos = (fake.send.mock.calls as unknown as [unknown, { content: { text: string } }][]).map((c) => c[1].content.text);
    expect(textos).toEqual(["primeira", "Olá, segue a proposta"]);
  });

  it("contato que já conversou pelo celular, sem mensagem aqui, recebe", async () => {
    const r = await encaminhar([fx.m.texto], [fx.gil]);
    expect(r).toMatchObject({ ok: 1, falhas: 0 });
  });
});

describe("mídia reenviada a partir do arquivo guardado", () => {
  it("imagem, áudio e documento: o servidor lê o arquivo do Storage, reenvia os mesmos bytes e a nova mensagem aponta para o mesmo arquivo", async () => {
    const r = await encaminhar([fx.m.doc, fx.m.audio, fx.m.imagem], [fx.bruno]);
    expect(r).toMatchObject({ ok: 1, falhas: 0 });

    // Ordem cronológica: imagem, áudio, documento.
    const chamadas = fake.sendMedia.mock.calls as unknown as [unknown, { to: string; type: string; mime: string; base64: string; caption?: string }][];
    expect(chamadas.map((c) => c[1].type)).toEqual(["image", "audio", "doc"]);
    expect(chamadas[0]![1]).toMatchObject({
      to: "5565911110002",
      mime: "image/png",
      caption: "Foto da obra",
      base64: Buffer.from(`bytes-de-${fx.origem}/img.png`).toString("base64"),
    });
    expect(chamadas[1]![1]).toMatchObject({ mime: "audio/ogg; codecs=opus", base64: Buffer.from(`bytes-de-${fx.origem}/voz.ogg`).toString("base64") });
    expect(chamadas[2]![1]).toMatchObject({ mime: "application/pdf" });
    expect(fake.send).not.toHaveBeenCalled(); // mídia nunca sai como texto

    const linhas = await linhasDe(fx.bruno);
    expect(linhas.map((l) => [l.tipo, l.mediaPath, l.mediaMime])).toEqual([
      ["image", `${fx.origem}/img.png`, "image/png"],
      ["audio", `${fx.origem}/voz.ogg`, "audio/ogg; codecs=opus"],
      ["doc", `${fx.origem}/proposta.pdf`, "application/pdf"],
    ]);
  });

  it("a mesma mídia para dois destinos é lida do Storage uma vez só", async () => {
    await encaminhar([fx.m.imagem], [fx.bruno, fx.eva]);
    expect(fake.baixar).toHaveBeenCalledTimes(1);
    expect(fake.sendMedia).toHaveBeenCalledTimes(2);
  });

  it("mídia sem arquivo guardado, de tipo não aceito ou texto vazio: pedido inválido, nada sai", async () => {
    await expect(encaminhar([fx.m.semArquivo], [fx.bruno])).rejects.toThrow("Uma das mídias não está disponível para reenviar.");
    await expect(encaminhar([fx.m.bloqueado], [fx.bruno])).rejects.toThrow("Um dos arquivos é de um tipo que o CRM Agro não reenvia.");
    await expect(encaminhar([fx.m.vazio], [fx.bruno])).rejects.toThrow("Uma das mensagens está vazia");
    // Uma ruim no meio de várias derruba o pedido inteiro antes de enviar a boa.
    await expect(encaminhar([fx.m.texto, fx.m.semArquivo], [fx.bruno])).rejects.toBeInstanceOf(EncaminhamentoInvalido);
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.sendMedia).not.toHaveBeenCalled();
  });

  it("arquivo que o Storage não entrega: todos os destinos dizem o motivo e nada sai", async () => {
    fake.baixar.mockRejectedValueOnce(new Error("Storage: download falhou (HTTP 404)"));
    const r = await encaminhar([fx.m.imagem], [fx.bruno, fx.eva]);
    expect(r.falhas).toBe(2);
    expect(r.destinos.map((d) => d.erro)).toEqual(["Não consegui ler o arquivo da mensagem para reenviar.", "Não consegui ler o arquivo da mensagem para reenviar."]);
    expect(fake.sendMedia).not.toHaveBeenCalled();
    expect(await linhasDe(fx.bruno)).toHaveLength(0);
  });

  it("o provedor recusa a mídia: destino com erro, e a cota do número é devolvida", async () => {
    fake.sendMedia.mockRejectedValueOnce(new Error("Evolution sendMedia: 400"));
    const r = await encaminhar([fx.m.imagem], [fx.bruno]);
    expect(r.destinos[0]).toMatchObject({ enviadas: 0, erro: "O WhatsApp não aceitou o envio do arquivo." });
    expect(await usoDaConta(fx.wa1)).toBe(0);
  });
});

describe("canal diferente é recusado no servidor", () => {
  it("mensagem de WhatsApp para conversa de e-mail: recusa e nada sai por nenhum canal", async () => {
    const r = await encaminhar([fx.m.texto], [fx.gabi]);
    expect(r.destinos[0]!.erro).toMatch(/mesmo canal \(esta conversa é de e-mail\)/);
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.smtp).not.toHaveBeenCalled();
    expect(await basePrisma.message.count({ where: { conversationId: fx.gabi, direcao: "out" } })).toBe(0);
  });

  it("e-mail para conversa de WhatsApp: recusa", async () => {
    const r = await encaminhar([fx.m.email], [fx.bruno]);
    expect(r.destinos[0]!.erro).toMatch(/mesmo canal \(esta conversa é de WhatsApp\)/);
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.smtp).not.toHaveBeenCalled();
  });

  it("misturado: o destino do canal certo recebe, o do canal errado é recusado (falha por destino)", async () => {
    const r = await encaminhar([fx.m.texto], [fx.bruno, fx.gabi]);
    expect(r).toMatchObject({ ok: 1, falhas: 1 });
    expect(r.destinos[0]).toMatchObject({ nome: "Bruno", erro: null });
    expect(r.destinos[1]!.erro).toMatch(/mesmo canal/);
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.smtp).not.toHaveBeenCalled();
  });

  it("mensagens de canais diferentes no mesmo pedido: pedido inválido", async () => {
    await expect(encaminhar([fx.m.texto, fx.m.email], [fx.bruno])).rejects.toThrow("As mensagens escolhidas são de canais diferentes.");
  });

  it("a lista de destinos só oferece o canal da conversa de origem", async () => {
    const dosZap = await doTime(() => listarDestinosDeEncaminhamento(fx.origem));
    expect(dosZap.some((d) => d.id === fx.gabi)).toBe(false);
    const dosEmails = await doTime(() => listarDestinosDeEncaminhamento(fx.fabio));
    expect(dosEmails.map((d) => d.id)).toEqual([fx.gabi]);
    expect(dosEmails[0]).toMatchObject({ nome: "Gabi", email: "gabi@cliente.test", numero: null, conta: "Caixa" });
  });
});

describe("outro time é recusado", () => {
  it("destino de outro time: recusado, sem vazar que existe, e nada é gravado nem enviado lá", async () => {
    const r = await encaminhar([fx.m.texto], [fx.convB]);
    expect(r.destinos[0]).toMatchObject({ nome: "Conversa", enviadas: 0, erro: "Conversa não encontrada ou sem permissão para enviar por ela." });
    expect(fake.send).not.toHaveBeenCalled();
    expect(await basePrisma.message.count({ where: { conversationId: fx.convB, direcao: "out", providerMessageId: { not: null } } })).toBe(0);
  });

  it("mensagem de outro time como origem: pedido inválido (não dá para levar o conteúdo dele para o meu)", async () => {
    await expect(encaminhar([fx.m.deOutroTime], [fx.bruno])).rejects.toThrow("Mensagem não encontrada.");
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("a lista de destinos nunca traz conversa de outro time", async () => {
    const lista = await doTime(() => listarDestinosDeEncaminhamento(fx.origem));
    expect(lista.some((d) => d.id === fx.convB)).toBe(false);
    await expect(doTime(() => listarDestinosDeEncaminhamento(fx.convB))).rejects.toThrow("Conversa não encontrada.");
  });
});

describe("sem permissão é recusado", () => {
  it("só leitura (viewer) não encaminha nem lista destinos", async () => {
    const leitor = { userId: "user-leitor", role: "viewer" };
    await expect(runWithTeam(TEAM, () => encaminharMensagens({ messageIds: [fx.m.texto], destinoIds: [fx.bruno] }, sem), leitor)).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(runWithTeam(TEAM, () => listarDestinosDeEncaminhamento(fx.origem), leitor)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("membro só encaminha por conta que é dele: número do colega é recusado, o dele passa", async () => {
    const r = await comoMembro(() => encaminharMensagens({ messageIds: [fx.m.texto], destinoIds: [fx.eva, fx.bruno] }, sem));
    expect(r.destinos[0]).toMatchObject({ nome: "Conversa", erro: "Conversa não encontrada ou sem permissão para enviar por ela." });
    expect(r.destinos[1]).toMatchObject({ nome: "Bruno", erro: null });
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(instanciaDe((fake.send.mock.calls[0] as unknown[])[0])).toBe(`Comercial-${sufixo}`);
    expect(await linhasDe(fx.eva)).toHaveLength(0);
  });

  it("a lista de destinos do membro só traz as conversas das contas dele", async () => {
    const lista = await comoMembro(() => listarDestinosDeEncaminhamento(fx.origem));
    expect(lista.map((d) => d.nome).sort()).toEqual(["Bruno", "Gil"]);
    // O dono do time vê os números de todos (Eva e Zé são do Suporte).
    const doDono = await doTime(() => listarDestinosDeEncaminhamento(fx.origem));
    expect(doDono.map((d) => d.nome).sort()).toEqual(["Bruno", "Eva", "Gil", "Zé"]);
  });

  it("origem de conversa que o membro não vê: pedido inválido", async () => {
    const deColega = await mensagem({ conversationId: fx.eva, ordem: 9, conteudo: "do colega" });
    await expect(comoMembro(() => encaminharMensagens({ messageIds: [deColega], destinoIds: [fx.bruno] }, sem))).rejects.toThrow("Mensagem não encontrada.");
  });
});

describe("já conversou? e opt-out", () => {
  it("quem pediu para sair e quem nunca conversou são recusados; os demais recebem (falha por destino)", async () => {
    const r = await encaminhar([fx.m.texto], [fx.carla, fx.dora, fx.bruno]);
    expect(r).toMatchObject({ ok: 1, falhas: 2 });
    expect(r.destinos.map((d) => [d.nome, d.erro])).toEqual([
      ["Carla", "Este contato pediu para sair e não recebe mensagens."],
      ["Dora", "Ainda não houve conversa com este contato. Envie a primeira mensagem pela própria conversa."],
      ["Bruno", null],
    ]);
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(await linhasDe(fx.carla)).toHaveLength(0);
    expect(await linhasDe(fx.dora)).toHaveLength(0);
  });

  it("a lista de destinos não oferece opt-out, sem histórico nem a própria conversa; oferece quem já conversou pelo celular", async () => {
    const nomes = (await doTime(() => listarDestinosDeEncaminhamento(fx.origem))).map((d) => d.nome);
    expect(nomes).not.toContain("Carla");
    expect(nomes).not.toContain("Dora");
    expect(nomes).not.toContain("Ana");
    expect(nomes).toContain("Gil");
  });
});

describe("controle de ritmo: cota do número e pausa entre envios", () => {
  it("cada envio gasta 1 da cota diária da conta de destino", async () => {
    await encaminhar([fx.m.texto, fx.m.imagem], [fx.bruno, fx.eva]);
    expect(await usoDaConta(fx.wa1)).toBe(2);
    expect(await usoDaConta(fx.wa2)).toBe(2);
  });

  it("cota do dia acaba no meio: o destino para com o motivo e diz até onde foi; as demais mensagens não saem fora de ordem", async () => {
    await basePrisma.channelAccount.update({ where: { id: fx.wa1 }, data: { dailyLimit: 1 } });
    const r = await encaminhar([fx.m.texto, fx.m.imagem, fx.m.doc], [fx.bruno]);
    expect(r.destinos[0]).toMatchObject({ enviadas: 1, total: 3, erro: "Enviadas 1 de 3. O número chegou ao limite de envios de hoje." });
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.sendMedia).not.toHaveBeenCalled();
  });

  it("número pausado: nada sai por ele", async () => {
    await basePrisma.channelAccount.update({ where: { id: fx.wa1 }, data: { paused: true } });
    const r = await encaminhar([fx.m.texto], [fx.bruno, fx.eva]);
    expect(r.destinos.map((d) => [d.nome, d.erro])).toEqual([
      ["Bruno", "O número está pausado."],
      ["Eva", null],
    ]);
    expect(fake.send).toHaveBeenCalledTimes(1);
  });

  it("há pausa entre um envio e o seguinte (nunca antes do primeiro)", async () => {
    const dormir = vi.fn(async () => undefined);
    await doTime(() => encaminharMensagens({ messageIds: [fx.m.texto, fx.m.imagem], destinoIds: [fx.bruno, fx.eva] }, { espacoMs: 500, dormir }));
    expect(dormir).toHaveBeenCalledTimes(3); // 4 envios, 3 pausas
    for (const [ms] of dormir.mock.calls as unknown as [number][]) {
      expect(ms).toBeGreaterThanOrEqual(500);
      expect(ms).toBeLessThan(750);
    }
  });
});

describe("falha parcial é reportada por destino", () => {
  it("um destino falha, o outro recebe; a cota do que não saiu é devolvida", async () => {
    fake.send.mockImplementation(async (ref: unknown) => {
      if (instanciaDe(ref) === `Suporte-${sufixo}`) throw new Error("Evolution sendText: instância desconectada");
      return { providerMessageId: `FAKE-OK-${Date.now()}` };
    });
    const r = await encaminhar([fx.m.texto], [fx.bruno, fx.eva]);
    expect(r).toMatchObject({ ok: 1, falhas: 1 });
    expect(r.destinos[0]).toMatchObject({ nome: "Bruno", enviadas: 1, erro: null });
    expect(r.destinos[1]).toMatchObject({ nome: "Eva", enviadas: 0, erro: "Não foi possível enviar." });
    expect(await usoDaConta(fx.wa1)).toBe(1);
    expect(await usoDaConta(fx.wa2)).toBe(0);
    expect(await linhasDe(fx.eva)).toHaveLength(0);
  });

  it("falha no meio das mensagens de um destino: as seguintes NÃO saem (a ordem da conversa não embaralha) e ele diz até onde foi", async () => {
    let n = 0;
    fake.send.mockImplementation(async () => {
      if (++n === 2) throw new Error("boom");
      return { providerMessageId: `FAKE-P-${Date.now()}-${n}` };
    });
    const extra1 = await mensagem({ conversationId: fx.origem, ordem: 10, conteudo: "segunda" });
    const extra2 = await mensagem({ conversationId: fx.origem, ordem: 11, conteudo: "terceira" });
    const r = await encaminhar([fx.m.texto, extra1, extra2], [fx.bruno]);
    expect(r.destinos[0]).toMatchObject({ enviadas: 1, total: 3, erro: "Enviadas 1 de 3. Não foi possível enviar." });
    expect(fake.send).toHaveBeenCalledTimes(2); // a terceira nem tentou
    expect(await linhasDe(fx.bruno)).toHaveLength(1);
  });

  it("um destino que falha não trava os demais nas mensagens seguintes", async () => {
    fake.send.mockImplementation(async (ref: unknown) => {
      if (instanciaDe(ref) === `Suporte-${sufixo}`) throw new Error("boom");
      return { providerMessageId: `FAKE-Q-${Date.now()}-${Math.random()}` };
    });
    const extra = await mensagem({ conversationId: fx.origem, ordem: 10, conteudo: "segunda" });
    const r = await encaminhar([fx.m.texto, extra], [fx.eva, fx.bruno]);
    expect(r.destinos[0]).toMatchObject({ nome: "Eva", enviadas: 0 });
    expect(r.destinos[1]).toMatchObject({ nome: "Bruno", enviadas: 2, erro: null });
  });
});

describe("e-mail: só entre e-mails", () => {
  it("um e-mail por destino, com Fwd:, cabeçalho do original e o texto, pela caixa do destino", async () => {
    const r = await encaminhar([fx.m.email], [fx.gabi]);
    expect(r).toMatchObject({ ok: 1, falhas: 0 });
    expect(fake.smtp).toHaveBeenCalledTimes(1);
    const [, entrada] = fake.smtp.mock.calls[0] as unknown as [unknown, { to: string; content: { subject: string; text: string } }];
    expect(entrada.to).toBe("gabi@cliente.test");
    expect(entrada.content.subject).toBe("Fwd: Orçamento");
    expect(entrada.content.text).toContain("Mensagem encaminhada");
    expect(entrada.content.text).toContain("De: fabio@cliente.test");
    expect(entrada.content.text).toContain("Assunto: Orçamento");
    expect(entrada.content.text).toContain("Segue o orçamento");
    expect(fake.send).not.toHaveBeenCalled();
    expect(await usoDaConta(fx.em)).toBe(1);
  });

  it("várias mensagens vão num único e-mail por destino", async () => {
    const outra = await mensagem({ conversationId: fx.fabio, ordem: 2, direcao: "out", conteudo: "Resposta nossa", meta: { subject: "Re: Orçamento", to: "fabio@cliente.test" } });
    const r = await encaminhar([fx.m.email, outra], [fx.gabi]);
    expect(r.destinos[0]).toMatchObject({ enviadas: 1, total: 1, erro: null });
    expect(fake.smtp).toHaveBeenCalledTimes(1);
    const [, entrada] = fake.smtp.mock.calls[0] as unknown as [unknown, { content: { text: string } }];
    expect(entrada.content.text.indexOf("Segue o orçamento")).toBeLessThan(entrada.content.text.indexOf("Resposta nossa"));
  });
});

describe("Instagram e LinkedIn ainda não encaminham", () => {
  it("origem de canal sem envio pelas Conversas: pedido inválido", async () => {
    const ig = await basePrisma.channelAccount.create({
      data: { teamId: TEAM, canal: "instagram", label: "Insta", provider: "instagram_official", status: "connected", ownerId: "user-eu" },
    });
    const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Insta" } });
    const convIg = await basePrisma.conversation.create({
      data: { teamId: TEAM, contactId: contato.id, canal: "instagram", channelAccountId: ig.id, lastMessageAt: new Date() },
    });
    const m = await mensagem({ conversationId: convIg.id, ordem: 1, conteudo: "oi do insta" });
    await expect(encaminhar([m], [fx.bruno])).rejects.toThrow("Ainda não dá para encaminhar mensagens de Instagram.");
    expect(fake.send).not.toHaveBeenCalled();
  });
});
