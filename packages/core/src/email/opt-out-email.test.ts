import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { basePrisma, encryptCredentials } from "@crmagro/db";

/**
 * Opt-out por e-mail (N12): a regra do WhatsApp sobre a 1ª linha escrita pelo
 * contato — nunca sobre a nossa mensagem citada. IMAP FALSO (mock do
 * `imapflow`, como em leitura-imap.test.ts): nenhuma conexão de verdade, nada
 * é enviado.
 */

type Msg = { uid: number; from: string; subject: string; messageId: string; date: Date; body: string };
const caixa = { uidValidity: 100n, msgs: [] as Msg[] };

function rfc822(m: Msg): string {
  return [
    `From: ${m.from}`,
    "To: vendas@crmagro.test",
    `Subject: ${m.subject}`,
    `Message-ID: ${m.messageId}`,
    `Date: ${m.date.toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.body,
  ].join("\r\n");
}

// O `imapflow` é dependência do @crmagro/channels: o mock aponta para o MESMO módulo que ele resolve.
vi.mock("../../../channels/node_modules/imapflow", () => ({
  ImapFlow: class {
    mailbox: { uidValidity: bigint; uidNext: number; exists: number } | false = false;
    on() {
      return this;
    }
    async connect() {}
    async getMailboxLock() {
      const maior = caixa.msgs.reduce((a, m) => Math.max(a, m.uid), 0);
      this.mailbox = { uidValidity: caixa.uidValidity, uidNext: maior + 1, exists: caixa.msgs.length };
      return { path: "INBOX", release() {} };
    }
    async search(q: { uid?: string; since?: Date }) {
      if (q.since) return caixa.msgs.filter((m) => m.date >= q.since!).map((m) => m.uid);
      const inicio = Number(q.uid!.split(":")[0]);
      const achados = caixa.msgs.filter((m) => m.uid >= inicio).map((m) => m.uid);
      if (achados.length === 0 && caixa.msgs.length) return [caixa.msgs[caixa.msgs.length - 1]!.uid];
      return achados;
    }
    async *fetch(uids: number[], q: { source?: unknown }) {
      for (const m of caixa.msgs.filter((x) => uids.includes(x.uid))) {
        if (q.source) {
          yield { uid: m.uid, source: Buffer.from(rfc822(m)) };
        } else {
          const i = m.from.indexOf("<");
          const endereco = i >= 0 ? m.from.slice(i + 1, m.from.indexOf(">")) : m.from;
          yield {
            uid: m.uid,
            size: m.body.length,
            internalDate: m.date,
            headers: Buffer.from(""),
            envelope: { from: [{ name: undefined, address: endereco }], subject: m.subject, messageId: m.messageId, inReplyTo: "", date: m.date },
          };
        }
      }
    }
    async logout() {}
  },
}));
vi.mock("../events/redis-bus", () => ({ publishRealtime: vi.fn() }));
vi.mock("../flows/aguardando", () => ({ acordarQuemEsperaResposta: vi.fn(async () => 0) }));

const { pollAllEmailInboxes } = await import("./leitura-imap");
const { primeiraLinhaUtil, textoParaOptOut } = await import("./opt-out-email");
const { redisEstado } = await import("../shared/redis-cache");
const { TAG_PEDIU_PARA_SAIR } = await import("../conversations/opt-out");

const TEAM = "00000000-0000-0000-0000-0000000002b4";
const OUTRO = "00000000-0000-0000-0000-0000000002b5";
const LEAD = "produtor@fazenda.test";

// ─── Textos reais de resposta ───────────────────────────────────────────────

const NOSSA_MENSAGEM = [
  "Bom dia! Temos semente de soja para a safra 26.",
  "Se não quiser mais receber nossos e-mails, responda SAIR.",
];
const gmail = (resposta: string) =>
  [
    resposta,
    "",
    "Em sex., 26 de set. de 2026 às 10:00, Vendas CRM Agro <vendas@crmagro.test>",
    "escreveu:",
    "",
    ...NOSSA_MENSAGEM.map((l) => `> ${l}`),
  ].join("\n");
const outlook = (resposta: string) =>
  [
    resposta,
    "",
    "________________________________",
    "De: Vendas CRM Agro <vendas@crmagro.test>",
    "Enviado: sexta-feira, 26 de setembro de 2026 10:00",
    "Para: produtor@fazenda.test",
    "Assunto: Semente de soja",
    "",
    ...NOSSA_MENSAGEM,
  ].join("\n");
const iphone = (resposta: string) =>
  [resposta, "", "Enviado do meu iPhone", "", "> Em 26 de set. de 2026, à(s) 10:00, Vendas CRM Agro <vendas@crmagro.test> escreveu:", "> ", ...NOSSA_MENSAGEM.map((l) => `> ${l}`)].join(
    "\n",
  );

describe("primeira linha útil do e-mail", () => {
  it.each([
    ["Gmail", gmail("Descadastrar"), "Descadastrar"],
    ["Outlook", outlook("Por favor, me remova da lista."), "Por favor, me remova da lista."],
    ["iPhone", iphone("Pare de me mandar e-mail"), "Pare de me mandar e-mail"],
    ["cumprimento antes", "Olá, Fulano\n\nSair\n\n-- \nJoão da Fazenda", "Sair"],
    ["só assinatura", "-- \nJoão da Fazenda\nFazenda Boa Vista", null],
    ["só citação", "> Se não quiser mais receber, responda SAIR.", null],
    ["Mensagem original", "-----Mensagem original-----\nDe: vendas@crmagro.test\n\nresponda SAIR", null],
  ])("%s", (_nome, corpo, esperado) => {
    expect(primeiraLinhaUtil(corpo)).toBe(esperado);
  });

  it("sem linha útil: vale o assunto, mas nunca o de resposta (que é o NOSSO assunto)", () => {
    expect(textoParaOptOut({ text: "", subject: "Descadastrar" })).toBe("Descadastrar");
    expect(textoParaOptOut({ text: "", subject: "Re: Pare de perder dinheiro com adubo caro" })).toBeNull();
    expect(textoParaOptOut({ text: "> citação", subject: "RES: Semente" })).toBeNull();
  });
});

// ─── Pelo caminho real (poll IMAP) ──────────────────────────────────────────

let uid = 0;
function chega(body: string, subject = "Re: Semente de soja") {
  uid++;
  caixa.msgs.push({ uid, from: `Produtor <${LEAD}>`, subject, messageId: `<opt${uid}.${Date.now()}@fazenda.test>`, date: new Date(Date.now() - 30 * 60_000), body });
}

const contas: Record<string, string> = {};
const contatos: Record<string, string> = {};

async function limpar() {
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.enrollment.deleteMany({ where: w });
  await basePrisma.flowNode.deleteMany({ where: w });
  await basePrisma.flow.deleteMany({ where: w });
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}

beforeAll(async () => {
  for (const id of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `Opt-out e-mail (${id.slice(-3)})` } });
  }
});

beforeEach(async () => {
  await limpar();
  Object.assign(caixa, { uidValidity: 100n, msgs: [] });
  uid = 0;
  // Os dois times têm conta de e-mail e um contato com o MESMO endereço.
  for (const teamId of [TEAM, OUTRO]) {
    const c = await basePrisma.channelAccount.create({
      data: {
        teamId,
        canal: "email",
        provider: "smtp",
        label: "E-mail comercial",
        status: "connected",
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        credentials: encryptCredentials({ host: "smtp.crmagro.test", port: 587, user: "vendas@crmagro.test", pass: "x", imapHost: "imap.crmagro.test", imapPort: 993 }) as unknown as Prisma.InputJsonValue,
      },
    });
    contas[teamId] = c.id;
    await redisEstado().del(`email:poll:${c.id}`);
    const contato = await basePrisma.contact.create({ data: { teamId, nome: "Produtor" } });
    contatos[teamId] = contato.id;
    await basePrisma.channelIdentifier.create({ data: { teamId, contactId: contato.id, canal: "email", valor: LEAD } });
    const fluxo = await basePrisma.flow.create({ data: { teamId, nome: "Cadência e-mail", triggerType: "manual", status: "active" } });
    await basePrisma.flowNode.create({ data: { id: `n-${fluxo.id}`, teamId, flowId: fluxo.id, tipo: "wait" as never, config: {} as never } });
    await basePrisma.enrollment.create({
      data: { teamId, flowId: fluxo.id, contactId: contato.id, currentNodeId: `n-${fluxo.id}`, currentRound: 1, status: "active", nextRunAt: new Date() },
    });
  }
});

afterAll(limpar);

const poll = () => pollAllEmailInboxes({ agora: new Date(), teamIds: [TEAM] });
const estado = async (teamId: string) => {
  const c = await basePrisma.contact.findUniqueOrThrow({ where: { id: contatos[teamId]! } });
  return {
    status: c.relacionamentoStatus,
    tag: (c.tags ?? []).includes(TAG_PEDIU_PARA_SAIR),
    notas: await basePrisma.activity.count({ where: { contactId: c.id, tipo: "note", meta: { path: ["optOut"], equals: true } } }),
    inscricoesAtivas: await basePrisma.enrollment.count({ where: { contactId: c.id, status: { in: ["active", "waiting"] } } }),
    emails: await basePrisma.message.count({ where: { teamId, direcao: "in" } }),
  };
};

describe("opt-out pelo e-mail recebido", () => {
  it('"Descadastrar" respondendo o nosso e-mail (Gmail, com citação) → opt-out, e a mensagem é gravada', async () => {
    chega(gmail("Descadastrar"));
    await poll();
    expect(await estado(TEAM)).toEqual({ status: "opt_out", tag: true, notas: 1, inscricoesAtivas: 0, emails: 1 });
  });

  it("resposta de interesse citando o nosso 'responda SAIR' NÃO vira opt-out", async () => {
    chega(gmail("Tenho interesse, me manda a tabela de preço"));
    chega(outlook("Bom dia\n\nPode ligar amanhã cedo"));
    await poll();
    expect(await estado(TEAM)).toMatchObject({ status: "novo", tag: false, notas: 0, inscricoesAtivas: 1, emails: 2 });
  });

  it("adiamento por e-mail não é opt-out; pedido pelo Outlook é", async () => {
    chega(outlook("Não quero agora, me procure na próxima safra"));
    await poll();
    expect((await estado(TEAM)).status).toBe("novo");
    chega(outlook("Por favor, me remova da lista."));
    await poll();
    expect(await estado(TEAM)).toMatchObject({ status: "opt_out", notas: 1, inscricoesAtivas: 0 });
  });

  it("releitura da caixa (cursor zerado) não duplica o opt-out nem a mensagem", async () => {
    chega(iphone("Pare de me mandar e-mail"));
    await poll();
    await basePrisma.channelAccount.update({ where: { id: contas[TEAM]! }, data: { meta: {} } });
    await redisEstado().del(`email:poll:${contas[TEAM]}`);
    await poll();
    expect(await estado(TEAM)).toEqual({ status: "opt_out", tag: true, notas: 1, inscricoesAtivas: 0, emails: 1 });
  });

  it("dois times: o time B, com o mesmo endereço e sem ler a caixa, fica intocado", async () => {
    chega(gmail("Descadastrar"));
    await poll();
    expect((await estado(TEAM)).status).toBe("opt_out");
    expect(await estado(OUTRO)).toEqual({ status: "novo", tag: false, notas: 0, inscricoesAtivas: 1, emails: 0 });
  });
});
