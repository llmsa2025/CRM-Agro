import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { basePrisma, encryptCredentials } from "@crmagro/db";

/**
 * Item 2.8 (DP-18/INT-05, INT-20) — leitura IMAP por cursor, trava por conta,
 * 3 falhas de senha desligam a conta, espera em erro de rede, dedup por hash.
 *
 * O IMAP é FALSO (mock do `imapflow`): uma caixa em memória que imita o
 * servidor — UIDVALIDITY, UIDNEXT, `SEARCH UID N:*` (inclusive a pegadinha de
 * devolver o último e-mail quando N passa do maior UID), `SEARCH SINCE` e
 * `FETCH` de envelope/corpo. Nenhuma conexão de rede de verdade.
 */

type Msg = {
  uid: number;
  from: string;
  subject: string;
  messageId: string | null;
  date: Date;
  body: string;
  seen: boolean;
  inReplyTo?: string;
  references?: string[];
  /** Fonte crua pronta (bounce/DSN); sem ela, monta um e-mail simples. */
  raw?: string;
  /** INTERNALDATE (chegada à caixa, relógio do servidor); padrão = `date`. */
  internalDate?: Date;
};

const caixa = {
  uidValidity: 100n,
  msgs: [] as Msg[],
  falhaAuth: false,
  falhaRede: false,
  atrasoMs: 0,
  conexoes: 0,
  envelopes: [] as number[],
  corpos: [] as number[],
};

function rfc822(m: Msg): string {
  if (m.raw) return m.raw;
  return [
    `From: ${m.from}`,
    "To: vendas@crmagro.test",
    `Subject: ${m.subject}`,
    ...(m.messageId ? [`Message-ID: ${m.messageId}`] : []),
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references?.length ? [`References: ${m.references.join(" ")}`] : []),
    `Date: ${m.date.toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.body,
  ].join("\r\n");
}

// O `imapflow` é dependência do @crmagro/channels (não do core): o mock aponta
// para o MESMO módulo que o channels resolve, senão o vitest não o intercepta.
vi.mock("../../../channels/node_modules/imapflow", () => ({
  ImapFlow: class {
    mailbox: { uidValidity: bigint; uidNext: number; exists: number } | false = false;
    on() {
      return this;
    }
    async connect() {
      caixa.conexoes++;
      if (caixa.atrasoMs) await new Promise((ok) => setTimeout(ok, caixa.atrasoMs));
      if (caixa.falhaRede) throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      if (caixa.falhaAuth) {
        throw Object.assign(new Error("Command failed"), {
          authenticationFailed: true,
          serverResponseCode: "AUTHENTICATIONFAILED",
          response: "NO [AUTHENTICATIONFAILED] Invalid credentials",
        });
      }
    }
    async getMailboxLock() {
      const maior = caixa.msgs.reduce((a, m) => Math.max(a, m.uid), 0);
      this.mailbox = { uidValidity: caixa.uidValidity, uidNext: maior + 1, exists: caixa.msgs.length };
      return { path: "INBOX", release() {} };
    }
    async search(q: { uid?: string; since?: Date; seen?: boolean }) {
      if (q.since) return caixa.msgs.filter((m) => m.date >= q.since!).map((m) => m.uid);
      if (q.seen === false) return caixa.msgs.filter((m) => !m.seen).map((m) => m.uid);
      const inicio = Number(q.uid!.split(":")[0]);
      const achados = caixa.msgs.filter((m) => m.uid >= inicio).map((m) => m.uid);
      // IMAP: "N:*" com N acima do maior UID devolve o último e-mail.
      if (achados.length === 0 && caixa.msgs.length) return [caixa.msgs[caixa.msgs.length - 1]!.uid];
      return achados;
    }
    async *fetch(uids: number[], q: { source?: unknown; envelope?: boolean }) {
      for (const m of caixa.msgs.filter((x) => uids.includes(x.uid))) {
        if (q.source) {
          caixa.corpos.push(m.uid);
          yield { uid: m.uid, source: Buffer.from(rfc822(m)) };
        } else {
          caixa.envelopes.push(m.uid);
          const i = m.from.indexOf("<");
          const nome = i >= 0 ? m.from.slice(0, i).trim() : undefined;
          const endereco = i >= 0 ? m.from.slice(i + 1, m.from.indexOf(">")) : m.from;
          yield {
            uid: m.uid,
            size: m.body.length,
            internalDate: m.internalDate ?? m.date,
            headers: Buffer.from(m.references?.length ? `References: ${m.references.join(" ")}\r\n` : ""),
            envelope: {
              from: [{ name: nome, address: endereco }],
              subject: m.subject,
              messageId: m.messageId ?? "",
              inReplyTo: m.inReplyTo ?? "",
              date: m.date,
            },
          };
        }
      }
    }
    async logout() {}
  },
}));
vi.mock("../events/redis-bus", () => ({ publishRealtime: vi.fn() }));
vi.mock("../flows/aguardando", () => ({ acordarQuemEsperaResposta: vi.fn(async () => 0) }));

const { pollAllEmailInboxes, metaImapAoReconectar, chaveDedupEmail, EMAIL_POLL_TRAVA_S } = await import(
  "./leitura-imap"
);
const { publishRealtime } = await import("../events/redis-bus");
const { redisEstado } = await import("../shared/redis-cache");
const { hasInboundOnChannelSince } = await import("../contacts/service");
const { runWithTeam } = await import("../test-support/identidade");

const TEAM = "00000000-0000-0000-0000-0000000003a4";
const OUTRO = "00000000-0000-0000-0000-0000000003a5";
const LEAD = "lead@cliente.test";
const agora = () => new Date();
const poll = (quando = agora()) => pollAllEmailInboxes({ agora: quando, teamIds: [TEAM] });

let contaId = "";
let uid = 0;

function chega(p: Partial<Msg> & { from: string }): Msg {
  const m: Msg = {
    uid: ++uid,
    subject: `Assunto ${uid}`,
    messageId: `<m${uid}.${Date.now()}@teste>`,
    date: new Date(Date.now() - 60 * 60_000),
    body: `corpo ${uid}`,
    seen: false,
    ...p,
  };
  caixa.msgs.push(m);
  return m;
}

async function conta() {
  return basePrisma.channelAccount.findUniqueOrThrow({ where: { id: contaId } });
}
const metaImap = async () => ((await conta()).meta as { imap?: Record<string, unknown> } | null)?.imap ?? {};
const recebidas = () =>
  basePrisma.message.count({ where: { teamId: TEAM, direcao: "in", conversation: { channelAccountId: contaId } } });

async function limpar() {
  const w = { teamId: { in: [TEAM, OUTRO] } };
  await basePrisma.activity.deleteMany({ where: w });
  await basePrisma.message.deleteMany({ where: w });
  await basePrisma.conversation.deleteMany({ where: w });
  await basePrisma.channelIdentifier.deleteMany({ where: w });
  await basePrisma.contact.deleteMany({ where: w });
  await basePrisma.channelAccount.deleteMany({ where: w });
}

beforeAll(async () => {
  for (const id of [TEAM, OUTRO]) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name: `IMAP 2.8 (${id.slice(-3)})` } });
  }
});

beforeEach(async () => {
  await limpar();
  Object.assign(caixa, { uidValidity: 100n, msgs: [], falhaAuth: false, falhaRede: false, atrasoMs: 0, conexoes: 0, envelopes: [], corpos: [] });
  uid = 0;
  const c = await basePrisma.channelAccount.create({
    data: {
      teamId: TEAM,
      canal: "email",
      provider: "smtp",
      label: "E-mail comercial",
      status: "connected",
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      credentials: encryptCredentials({
        host: "smtp.crmagro.test",
        port: 587,
        user: "vendas@crmagro.test",
        pass: "segredo",
        imapHost: "imap.crmagro.test",
        imapPort: 993,
      }) as unknown as Prisma.InputJsonValue,
    },
  });
  contaId = c.id;
  const contato = await basePrisma.contact.create({ data: { teamId: TEAM, nome: "Lead" } });
  await basePrisma.channelIdentifier.create({ data: { teamId: TEAM, contactId: contato.id, canal: "email", valor: LEAD } });
  await redisEstado().del(`email:poll:${contaId}`);
  vi.mocked(publishRealtime).mockClear();
});

afterAll(async () => {
  await limpar();
});

describe("IMAP — cursor por UID (INT-05)", () => {
  it("caixa com mais de 50 não lidas recebe a resposta nova (antes nunca entrava)", async () => {
    // 120 newsletters não lidas de quem não é contato, um bounce e, por último, a resposta do lead.
    for (let i = 0; i < 120; i++) chega({ from: `news${i}@loja.test` });
    const bounce = chega({ from: "MAILER-DAEMON@mx.test", subject: "Undeliverable: proposta" });
    const resposta = chega({ from: `Lead <${LEAD}>`, subject: "Re: proposta", body: "Tenho interesse" });

    const r = await poll();
    expect(r.porResultado.lida).toBe(1);
    expect(r.processed).toBe(1);
    const msgs = await basePrisma.message.findMany({ where: { teamId: TEAM, direcao: "in" } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.conteudo).toContain("Tenho interesse");
    // Envelope de todos; corpo só do lead e do bounce (nada das newsletters).
    expect(caixa.envelopes).toHaveLength(122);
    expect(caixa.corpos.sort((a, b) => a - b)).toEqual([bounce.uid, resposta.uid]);
    expect(await metaImap()).toMatchObject({ uidValidity: "100", lastUid: resposta.uid, falhasAuth: 0, falhasRede: 0 });
  });

  it("lastUid avança: o próximo poll lê só o que chegou depois", async () => {
    chega({ from: LEAD });
    await poll();
    expect(await metaImap()).toMatchObject({ lastUid: 1 });

    const nova = chega({ from: LEAD, body: "segunda resposta" });
    caixa.envelopes = [];
    caixa.corpos = [];
    await poll();
    expect(caixa.envelopes).toEqual([nova.uid]);
    expect(caixa.corpos).toEqual([nova.uid]);
    expect(await metaImap()).toMatchObject({ lastUid: nova.uid });
    expect(await recebidas()).toBe(2);

    // Nada novo: o "UID 3:*" do servidor devolve o último (2) — é descartado.
    caixa.envelopes = [];
    await poll();
    expect(caixa.envelopes).toEqual([]);
    expect(await metaImap()).toMatchObject({ lastUid: nova.uid });
    expect(await recebidas()).toBe(2);
  });

  it("UIDVALIDITY trocado recomeça pela data sem duplicar o que já entrou", async () => {
    chega({ from: LEAD, messageId: "<a@teste>" });
    await poll();
    expect(await recebidas()).toBe(1);

    // Servidor renumerou a caixa: UIDs novos, mesma mensagem antiga + uma nova.
    caixa.uidValidity = 200n;
    caixa.msgs = caixa.msgs.map((m) => ({ ...m, uid: m.uid + 1000 }));
    uid = 1000 + uid;
    const nova = chega({ from: LEAD, messageId: "<b@teste>" });
    caixa.corpos = [];
    await poll();
    expect(await metaImap()).toMatchObject({ uidValidity: "200", lastUid: nova.uid });
    expect(await recebidas()).toBe(2);
    expect(caixa.corpos).toEqual([nova.uid]); // a antiga já gravada nem baixa o corpo
  });
});

describe("IMAP — trava por conta (INT-20)", () => {
  it("poll em andamento impede outro na mesma conta", async () => {
    chega({ from: LEAD });
    await redisEstado().set(`email:poll:${contaId}`, "outro-poll", "EX", EMAIL_POLL_TRAVA_S, "NX");
    const r = await poll();
    expect(r.porResultado.travada).toBe(1);
    expect(caixa.conexoes).toBe(0);
    expect(await recebidas()).toBe(0);

    await redisEstado().del(`email:poll:${contaId}`);
    caixa.atrasoMs = 300;
    const [a, b] = await Promise.all([poll(), poll()]);
    expect([a.porResultado.lida, b.porResultado.lida].filter(Boolean)).toEqual([1]);
    expect([a.porResultado.travada, b.porResultado.travada].filter(Boolean)).toEqual([1]);
    expect(caixa.conexoes).toBe(1);
    expect(await recebidas()).toBe(1);
    // Terminou: a trava foi solta.
    expect(await redisEstado().get(`email:poll:${contaId}`)).toBeNull();
  });
});

describe("IMAP — falhas", () => {
  it("3 falhas de senha seguidas marcam a conta com erro, avisam e param de ler", async () => {
    caixa.falhaAuth = true;
    await poll();
    await poll();
    expect((await conta()).status).toBe("connected");
    expect(await metaImap()).toMatchObject({ falhasAuth: 2 });
    expect(publishRealtime).not.toHaveBeenCalled();

    const r = await poll();
    expect(r.porResultado.desativada).toBe(1);
    expect((await conta()).status).toBe("error");
    expect(await metaImap()).toMatchObject({ falhasAuth: 3 });
    expect(publishRealtime).toHaveBeenCalledWith({
      type: "channel:disconnected",
      channelAccountId: contaId,
      label: "E-mail comercial",
    });

    // Conta com erro sai da varredura: nenhuma tentativa de login a mais.
    const antes = caixa.conexoes;
    expect((await poll()).accounts).toBe(0);
    expect(caixa.conexoes).toBe(antes);
  });

  it("login que volta a funcionar zera o contador", async () => {
    caixa.falhaAuth = true;
    await poll();
    caixa.falhaAuth = false;
    await poll();
    expect(await metaImap()).toMatchObject({ falhasAuth: 0 });
    caixa.falhaAuth = true;
    await poll();
    await poll();
    expect((await conta()).status).toBe("connected"); // 2 seguidas, não 3
  });

  it("erro de rede espera (backoff exponencial) em vez de tentar a cada poll", async () => {
    const t0 = new Date();
    caixa.falhaRede = true;
    const r = await poll(t0);
    expect(r.porResultado.falha_rede).toBe(1);
    const m1 = await metaImap();
    expect(m1).toMatchObject({ falhasRede: 1, ultimoErro: "connect ETIMEDOUT" });
    expect(new Date(m1.proximaTentativaEm as string).getTime()).toBe(t0.getTime() + 2 * 60_000);

    // Dentro da espera: nem conecta.
    const conexoes = caixa.conexoes;
    expect((await poll(new Date(t0.getTime() + 60_000))).porResultado.esperando).toBe(1);
    expect(caixa.conexoes).toBe(conexoes);

    // Passou a espera e falhou de novo: espera dobra.
    const t1 = new Date(t0.getTime() + 3 * 60_000);
    await poll(t1);
    const m2 = await metaImap();
    expect(m2).toMatchObject({ falhasRede: 2 });
    expect(new Date(m2.proximaTentativaEm as string).getTime()).toBe(t1.getTime() + 4 * 60_000);

    // Rede voltou: lê e zera.
    caixa.falhaRede = false;
    chega({ from: LEAD });
    await poll(new Date(t1.getTime() + 5 * 60_000));
    expect(await metaImap()).toMatchObject({ falhasRede: 0 });
    expect((await metaImap()).proximaTentativaEm).toBeUndefined();
    expect(await recebidas()).toBe(1);
  });
});

describe("IMAP — dedup sem Message-ID", () => {
  it("a mesma mensagem sem Message-ID em dois UIDs entra uma vez só (hash)", async () => {
    const data = new Date(Date.now() - 30 * 60_000);
    chega({ from: LEAD, messageId: null, subject: "sem id", date: data, body: "oi" });
    chega({ from: LEAD, messageId: null, subject: "sem id", date: data, body: "oi" });
    await poll();
    const msgs = await basePrisma.message.findMany({ where: { teamId: TEAM, direcao: "in" } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.providerMessageId).toBe(
      chaveDedupEmail({ messageId: null, from: LEAD, date: data, subject: "sem id" }),
    );
    expect(msgs[0]!.providerMessageId).toMatch(/^sem-id:[0-9a-f]{40}$/);

    // Recomeço (UIDVALIDITY novo) não regrava nem baixa o corpo de novo.
    caixa.uidValidity = 300n;
    caixa.corpos = [];
    await poll();
    expect(await recebidas()).toBe(1);
    expect(caixa.corpos).toEqual([]);
  });
});

describe("IMAP — auditoria do #73 (1ª leitura depois do deploy)", () => {
  it("e-mail sem Message-ID já gravado no formato ANTIGO (sem chave) não entra de novo", async () => {
    const contato = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM } });
    const conv = await basePrisma.conversation.create({
      data: { teamId: TEAM, contactId: contato.id, canal: "email", channelAccountId: contaId, status: "open" },
    });
    await basePrisma.message.create({
      data: { teamId: TEAM, conversationId: conv.id, direcao: "in", tipo: "text", conteudo: "oi antigo", status: "read", meta: { subject: "sem id antigo", from: LEAD } },
    });
    chega({ from: LEAD, messageId: null, subject: "sem id antigo", body: "oi antigo" });
    await poll();
    expect(await recebidas()).toBe(1);
  });

  it("e-mail entra com a hora de CHEGADA à caixa (relido depois não vira resposta 'nova' para o respondeu?)", async () => {
    // Dentro da janela da 1ª leitura (a conta de teste nasceu há 2 dias).
    const chegou = new Date(Date.now() - 86_400_000);
    chega({ from: LEAD, subject: "de anteontem", date: new Date(chegou.getTime() - 60_000), internalDate: chegou, body: "resposta antiga" });
    await poll();
    const msg = await basePrisma.message.findFirstOrThrow({ where: { teamId: TEAM, direcao: "in" } });
    const act = await basePrisma.activity.findFirstOrThrow({ where: { teamId: TEAM, tipo: "email", direcao: "in" } });
    expect(Math.abs(msg.createdAt.getTime() - chegou.getTime())).toBeLessThan(1000);
    expect(Math.abs(act.createdAt.getTime() - chegou.getTime())).toBeLessThan(1000);
  });

  it("auditoria do #88: relógio do lead ATRASADO (Date: antes do nosso envio) não esconde a resposta do respondeu?", async () => {
    const contato = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM } });
    const envio = new Date(Date.now() - 10 * 60_000); // nosso e-mail saiu há 10 min (lastOutboundAt)
    chega({
      from: LEAD,
      subject: "Re: proposta",
      date: new Date(envio.getTime() - 5 * 60_000), // PC do lead 5 min atrasado
      internalDate: new Date(envio.getTime() + 60_000), // chegou 1 min DEPOIS do envio
      body: "tenho interesse",
    });
    await poll();
    expect(await runWithTeam(TEAM, () => hasInboundOnChannelSince(contato.id, envio, "email"))).toBe(true);
  });
});

describe("IMAP — reconectar a conta", () => {
  it("zera as falhas; mantém o cursor só se a caixa é a mesma", () => {
    const meta = { imap: { uidValidity: "9", lastUid: 42, falhasAuth: 3, falhasRede: 1, ultimoErro: "x" }, outro: 1 };
    expect(metaImapAoReconectar(meta, true)).toEqual({ imap: { uidValidity: "9", lastUid: 42 }, outro: 1 });
    expect(metaImapAoReconectar(meta, false)).toEqual({ outro: 1 });
    expect(metaImapAoReconectar(null, true)).toBeUndefined();
  });
});

describe("IMAP — bounce e resposta por thread (item 3.4)", () => {
  async function enviadoPorNos(messageId: string, to: string) {
    const contato = await basePrisma.contact.findFirstOrThrow({ where: { teamId: TEAM } });
    const conv = await basePrisma.conversation.create({
      data: { teamId: TEAM, contactId: contato.id, canal: "email", channelAccountId: contaId, status: "open" },
    });
    return basePrisma.message.create({
      data: {
        teamId: TEAM,
        conversationId: conv.id,
        direcao: "out",
        tipo: "text",
        conteudo: "proposta",
        providerMessageId: messageId,
        status: "sent",
        meta: { subject: "Proposta", to },
      },
    });
  }
  const dsn = (destinatario: string, status: string, original: string) =>
    [
      "From: MAILER-DAEMON@mx.provedor.test",
      "Subject: Undelivered Mail Returned to Sender",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
      "Message-ID: <aviso@mx.provedor.test>",
      "",
      "--B",
      "Content-Type: message/delivery-status",
      "",
      `Final-Recipient: rfc822; ${destinatario}`,
      `Action: ${status.startsWith("5") ? "failed" : "delayed"}`,
      `Status: ${status}`,
      "Diagnostic-Code: smtp; 550 User unknown",
      "",
      "--B",
      "Content-Type: text/rfc822-headers",
      "",
      `Message-ID: ${original}`,
      "",
      "--B--",
    ].join("\r\n");

  it("bounce permanente (DSN do Postfix, sem In-Reply-To): marca o original e o endereço como inválido", async () => {
    const orig = await enviadoPorNos("<prop-1@crmagro.test>", LEAD);
    chega({ from: "MAILER-DAEMON@mx.provedor.test", subject: "Undelivered Mail Returned to Sender", raw: dsn(LEAD, "5.1.1", "<prop-1@crmagro.test>") });
    await poll();
    expect((await basePrisma.message.findUniqueOrThrow({ where: { id: orig.id } })).status).toBe("bounced");
    const ident = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: LEAD } });
    expect(ident.invalido).toBe(true);
    expect(ident.invalidoMotivo).toContain("5.1.1");
  });

  it("auditoria: lead que responde 'Pedido não entregue' / 'não existe' é RESPOSTA — entra no inbox e o e-mail dele segue válido", async () => {
    const orig = await enviadoPorNos("<prop-a1@crmagro.test>", LEAD);
    chega({
      from: LEAD,
      subject: "Pedido não entregue",
      body: "Esse produto não existe mais na loja, podem mandar outro?",
      inReplyTo: "<prop-a1@crmagro.test>",
      references: ["<prop-a1@crmagro.test>"],
    });
    await poll();
    const recebida = await basePrisma.message.findFirstOrThrow({ where: { teamId: TEAM, direcao: "in" } });
    expect(recebida.conteudo).toContain("não existe mais");
    expect((await basePrisma.message.findUniqueOrThrow({ where: { id: orig.id } })).status).toBe("sent");
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: LEAD } })).invalido).toBe(false);
  });

  it("auditoria: aviso que não casa e-mail nosso (bounce forjado) não marca ninguém", async () => {
    chega({ from: "MAILER-DAEMON@mx.provedor.test", subject: "Undelivered Mail", raw: dsn(LEAD, "5.1.1", "<de-outro-lugar@x.test>") });
    await poll();
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: LEAD } })).invalido).toBe(false);
  });

  it("auditoria: aviso do nosso e-mail mas sobre OUTRO destinatário não marca o lead nem o original", async () => {
    const orig = await enviadoPorNos("<prop-a3@crmagro.test>", LEAD);
    chega({ from: "MAILER-DAEMON@mx.provedor.test", subject: "Undelivered Mail", raw: dsn("outro@cliente.test", "5.1.1", "<prop-a3@crmagro.test>") });
    await poll();
    expect((await basePrisma.message.findUniqueOrThrow({ where: { id: orig.id } })).status).toBe("sent");
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: LEAD } })).invalido).toBe(false);
  });

  it("aviso de atraso (4.x.x) não mexe em nada", async () => {
    const orig = await enviadoPorNos("<prop-2@crmagro.test>", LEAD);
    chega({ from: "MAILER-DAEMON@mx.provedor.test", subject: "Delayed Mail", raw: dsn(LEAD, "4.4.1", "<prop-2@crmagro.test>") });
    await poll();
    expect((await basePrisma.message.findUniqueOrThrow({ where: { id: orig.id } })).status).toBe("sent");
    expect((await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: LEAD } })).invalido).toBe(false);
  });

  it("resposta de OUTRO endereço (assistente) que responde a um e-mail nosso entra na conversa do contato", async () => {
    await enviadoPorNos("<prop-3@crmagro.test>", LEAD);
    chega({
      from: "Assistente <assistente@cliente.test>",
      subject: "Re: Proposta",
      body: "Ele pediu para marcar uma call",
      inReplyTo: "<prop-3@crmagro.test>",
      references: ["<prop-3@crmagro.test>"],
    });
    const r = await poll();
    expect(r.processed).toBe(1);
    const recebida = await basePrisma.message.findFirstOrThrow({ where: { teamId: TEAM, direcao: "in" } });
    expect(recebida.conteudo).toContain("marcar uma call");
    // A cadeia fica guardada para a resposta sair na mesma thread.
    expect(recebida.meta).toMatchObject({ references: ["<prop-3@crmagro.test>"], inReplyTo: "<prop-3@crmagro.test>" });
  });

  it("e-mail recebido do endereço prova que ele existe: desfaz a marca de bounce", async () => {
    await basePrisma.channelIdentifier.updateMany({
      where: { teamId: TEAM, valor: LEAD },
      data: { invalido: true, invalidoMotivo: "5.1.1 antigo" },
    });
    chega({ from: LEAD, body: "voltei" });
    await poll();
    const ident = await basePrisma.channelIdentifier.findFirstOrThrow({ where: { teamId: TEAM, valor: LEAD } });
    expect(ident).toMatchObject({ invalido: false, invalidoMotivo: null });
  });
});
