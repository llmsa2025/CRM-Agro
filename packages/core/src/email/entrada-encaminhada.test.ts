import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { env } from "@crmagro/config";
import { emailDoMime } from "@crmagro/channels";
import { basePrisma, decryptCredentials, encryptCredentials, estaCifrado, runWithTeam } from "@crmagro/db";
import { Prisma } from "@prisma/client";

// Mocks isolados e içados (valem para o arquivo todo). Sem o do redis-bus, o `touchConversation`
// publicaria no Redis de TESTE; sem o do rate limit, o teto dependeria do relógio.
vi.mock("../events/redis-bus", () => ({ publishRealtime: vi.fn() }));
vi.mock("../flows/aguardando", () => ({ acordarQuemEsperaResposta: vi.fn(async () => 0) }));
const rl = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ allowed: true, remaining: 1, retryAfterMs: 0 })));
vi.mock("../rate-limit/service", async (orig) => ({ ...(await orig<typeof import("../rate-limit/service")>()), rateLimit: rl }));

import { acordarQuemEsperaResposta } from "../flows/aguardando";
import { gerarEncaminhamento } from "./encaminhamento";
import { processIncomingEmail } from "./leitura-imap";
import {
  REMETENTE_CONFIRMACAO_GMAIL,
  envelopeDaCaixa,
  linkDeConfirmacaoDoGmail,
  processarEmailEncaminhado,
  resumoDoEnvelopeRecusado,
  type EmailEncaminhadoJob,
} from "./entrada-encaminhada";

/**
 * Processar o e-mail encaminhado (ficha E3). Dois times (A e B); no A, duas caixas
 * (Ana e Bia), cada uma com o seu endereço de encaminhamento, e um contato "Cliente".
 */
const A = "00000000-0000-0000-0000-0000000e3a01";
const B = "00000000-0000-0000-0000-0000000e3a02";
const ANA = "usuaria-ana";
const BIA = "usuaria-bia";
const CLIENTE = "cliente@lead.com.br";
const ENV_ANA = "ana+caf_=r+x=in.crmagro.example@gmail.com";
const ENV_BIA = "bia+caf_=r+x=in.crmagro.example@empresa.com.br";
const VF = "https://mail-settings.google.com/mail/vf-%5BABC%5D-xyz";
const UF = "https://mail-settings.google.com/mail/uf-%5BABC%5D-xyz";
const envAntes = { dominio: env.EMAIL_ENTRADA_DOMINIO, segredo: env.EMAIL_ENTRADA_SEGREDO };

let caixaAna = "", caixaBia = "", contatoId = "";
let encAna = "", encBia = "";
let seq = 0;

const comoAna = <T>(fn: () => Promise<T>) => runWithTeam(A, fn, { userId: ANA, role: "member" });
const comoBia = <T>(fn: () => Promise<T>) => runWithTeam(A, fn, { userId: BIA, role: "member" });
const dominioA = <T>(fn: () => Promise<T>) => runWithTeam(A, fn, { userId: "sistema", role: "owner" });

function rfc822(m: { from: string; subject?: string; messageId?: string; body?: string; inReplyTo?: string; references?: string[] }): string {
  return [
    `From: ${m.from}`,
    "To: r@in.crmagro.example",
    `Subject: ${m.subject ?? "Assunto"}`,
    `Message-ID: ${m.messageId ?? `<m${++seq}.${Date.now()}@teste>`}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references?.length ? [`References: ${m.references.join(" ")}`] : []),
    `Date: ${new Date(Date.now() - 60 * 60_000).toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.body ?? "Corpo da mensagem",
  ].join("\r\n");
}

const job = (encaminhamentoId: string, raw: string, sobra: Partial<EmailEncaminhadoJob> = {}): EmailEncaminhadoJob => ({
  encaminhamentoId,
  teamId: A,
  envelopeDe: ENV_ANA,
  rawB64: Buffer.from(raw).toString("base64"),
  chegadaEm: Date.now(),
  ...sobra,
});

const linha = (id: string) => basePrisma.emailEncaminhamento.findUniqueOrThrow({ where: { id } });
const mensagens = (teamId = A) => basePrisma.message.findMany({ where: { teamId }, include: { conversation: true } });
const totais = async (teamId: string) => ({
  mensagens: await basePrisma.message.count({ where: { teamId } }),
  atividades: await basePrisma.activity.count({ where: { teamId } }),
  contatos: await basePrisma.contact.count({ where: { teamId } }),
  conversas: await basePrisma.conversation.count({ where: { teamId } }),
});

async function limpar() {
  for (const teamId of [A, B]) {
    await basePrisma.activity.deleteMany({ where: { teamId } });
    await basePrisma.message.deleteMany({ where: { teamId } });
    await basePrisma.conversation.deleteMany({ where: { teamId } });
    await basePrisma.channelIdentifier.deleteMany({ where: { teamId } });
    await basePrisma.contact.deleteMany({ where: { teamId } });
    await basePrisma.emailEncaminhamento.deleteMany({ where: { teamId } });
    await basePrisma.channelAccount.deleteMany({ where: { teamId } });
  }
}

const cred = (user: string, from: string) =>
  encryptCredentials({ host: "smtp.teste.invalid", port: 465, user, pass: "x", from }) as unknown as Prisma.InputJsonValue;

beforeAll(async () => {
  Object.assign(env, { EMAIL_ENTRADA_DOMINIO: "in.crmagro.example", EMAIL_ENTRADA_SEGREDO: "s".repeat(40) });
  for (const [id, name] of [[A, "Entrada encaminhada A (test)"], [B, "Entrada encaminhada B (test)"]] as const) {
    await basePrisma.team.upsert({ where: { id }, update: {}, create: { id, name } });
  }
  await limpar();
  caixaAna = (
    await basePrisma.channelAccount.create({
      data: { teamId: A, canal: "email", label: "Caixa da Ana", provider: "smtp", ownerId: ANA, credentials: cred("a.na@gmail.com", "Ana <a.na@gmail.com>") },
    })
  ).id;
  caixaBia = (
    await basePrisma.channelAccount.create({
      data: { teamId: A, canal: "email", label: "Caixa da Bia", provider: "smtp", ownerId: BIA, credentials: cred("bia@empresa.com.br", "bia@empresa.com.br") },
    })
  ).id;
  contatoId = (await basePrisma.contact.create({ data: { teamId: A, nome: "Cliente" } })).id;
  await basePrisma.channelIdentifier.create({ data: { teamId: A, contactId: contatoId, canal: "email", valor: CLIENTE } });
  encAna = await comoAna(async () => {
    await gerarEncaminhamento(caixaAna);
    return (await basePrisma.emailEncaminhamento.findUniqueOrThrow({ where: { channelAccountId: caixaAna } })).id;
  });
  encBia = await comoBia(async () => {
    await gerarEncaminhamento(caixaBia);
    return (await basePrisma.emailEncaminhamento.findUniqueOrThrow({ where: { channelAccountId: caixaBia } })).id;
  });
});

beforeEach(async () => {
  await basePrisma.activity.deleteMany({ where: { teamId: { in: [A, B] } } });
  await basePrisma.message.deleteMany({ where: { teamId: { in: [A, B] } } });
  await basePrisma.conversation.deleteMany({ where: { teamId: { in: [A, B] } } });
  await basePrisma.emailEncaminhamento.updateMany({
    where: { id: { in: [encAna, encBia] } },
    data: { confirmacaoLink: Prisma.DbNull, confirmacaoEm: null, confirmadoEm: null, ultimoRecebidoEm: null, recusados: 0, ultimoRecusadoEm: null },
  });
  rl.mockClear();
  vi.mocked(acordarQuemEsperaResposta).mockClear();
});

afterAll(async () => {
  Object.assign(env, { EMAIL_ENTRADA_DOMINIO: envAntes.dominio, EMAIL_ENTRADA_SEGREDO: envAntes.segredo });
  await limpar();
});

describe("1. e-mail de um contato", () => {
  it("vira mensagem na conversa da caixa, com atividade, datas e a espera de resposta acordada", async () => {
    const raw = rfc822({ from: `Cliente <${CLIENTE}>`, subject: "Quero a proposta", messageId: "<caso1@lead.com.br>", body: "Pode me mandar?" });
    expect(await processarEmailEncaminhado(job(encAna, raw))).toBe("gravado");

    const msgs = await mensagens();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direcao: "in", providerMessageId: "<caso1@lead.com.br>", conteudo: "Pode me mandar?" });
    expect(msgs[0]!.conversation).toMatchObject({ canal: "email", channelAccountId: caixaAna, contactId: contatoId });
    expect(await basePrisma.activity.count({ where: { teamId: A, contactId: contatoId, tipo: "email", direcao: "in" } })).toBe(1);

    const enc = await linha(encAna);
    expect(enc.confirmadoEm).not.toBeNull();
    expect(enc.ultimoRecebidoEm).not.toBeNull();
    expect(enc.recusados).toBe(0);
    expect(acordarQuemEsperaResposta).toHaveBeenCalledWith(contatoId);
  });
});

describe("2. ★ quem não é contato nem responde e-mail nosso", () => {
  it("é descartado sem gravar nada do conteúdo; só a data do último recebido muda", async () => {
    const antes = new Date(Date.now() - 24 * 3_600_000);
    await basePrisma.emailEncaminhamento.update({ where: { id: encAna }, data: { confirmadoEm: antes, ultimoRecebidoEm: antes } });
    const totaisAntes = await totais(A);
    const raw = rfc822({ from: "Loja <spam@loja.test>", subject: "Promoção imperdível", body: "Compre agora" });

    expect(await processarEmailEncaminhado(job(encAna, raw))).toBe("ignorado");

    expect(await totais(A)).toEqual(totaisAntes);
    expect(await totais(B)).toEqual({ mensagens: 0, atividades: 0, contatos: 0, conversas: 0 });
    const enc = await linha(encAna);
    expect(enc.ultimoRecebidoEm!.getTime()).toBeGreaterThan(antes.getTime());
    expect(enc.confirmadoEm!.getTime()).toBe(antes.getTime());
    expect(enc.recusados).toBe(0);
    expect(enc.confirmacaoEm).toBeNull();
    expect(enc.confirmacaoLink).toBeNull();
    expect(enc.ultimoRecusadoEm).toBeNull();
    const tudo = JSON.stringify(enc);
    for (const segredo of ["Promoção", "spam@loja.test", "Compre agora"]) expect(tudo).not.toContain(segredo);
  });
});

describe("3. dedupe com o IMAP", () => {
  const fetched = (messageId: string) => ({
    uid: 7,
    from: CLIENTE,
    fromName: "Cliente",
    subject: "Mesmo e-mail",
    text: "Corpo",
    messageId,
    inReplyTo: null,
    references: [],
    date: new Date(Date.now() - 3_600_000),
    recebidoEm: new Date(Date.now() - 3_000_000),
    isBounce: false,
    bounce: null,
  });
  const raw = (messageId: string) => rfc822({ from: `Cliente <${CLIENTE}>`, subject: "Mesmo e-mail", messageId, body: "Corpo" });

  it("IMAP primeiro, depois encaminhado: ignorado e só 1 mensagem", async () => {
    const id = "<dedupe-1@lead.com.br>";
    expect(await dominioA(() => processIncomingEmail(caixaAna, fetched(id)))).toBe(true);
    expect(await processarEmailEncaminhado(job(encAna, raw(id)))).toBe("ignorado");
    expect(await mensagens()).toHaveLength(1);
  });

  it("encaminhado primeiro, depois IMAP: o IMAP não grava de novo", async () => {
    const id = "<dedupe-2@lead.com.br>";
    expect(await processarEmailEncaminhado(job(encAna, raw(id)))).toBe("gravado");
    expect(await dominioA(() => processIncomingEmail(caixaAna, fetched(id)))).toBe(false);
    expect(await mensagens()).toHaveLength(1);
  });
});

describe("4. ★ confirmação do Google", () => {
  it("guarda só o link vf-, cifrado; não grava mensagem nem conta como e-mail recebido", async () => {
    const raw = rfc822({
      from: `Equipe do Gmail <${REMETENTE_CONFIRMACAO_GMAIL}>`,
      subject: "Confirmação de encaminhamento",
      body: `Para confirmar, clique: ${VF}\r\nPara cancelar: ${UF}`,
    });
    // O envelope da confirmação é do Google, não da caixa: não passa pelo filtro de envelope.
    expect(await processarEmailEncaminhado(job(encAna, raw, { envelopeDe: "noreply@google.com" }))).toBe("confirmacao_google");

    const enc = await linha(encAna);
    expect(estaCifrado(enc.confirmacaoLink)).toBe(true);
    expect((decryptCredentials(enc.confirmacaoLink) as { link: string }).link).toBe(VF);
    expect(JSON.stringify(enc)).not.toContain("vf-");
    expect(enc.confirmacaoEm).not.toBeNull();
    expect(enc.ultimoRecebidoEm).toBeNull();
    expect(enc.confirmadoEm).toBeNull();
    expect((await totais(A)).mensagens).toBe(0);
  });
});

describe("5. ★ confirmação falsa", () => {
  const falso = (sobra: Partial<Parameters<typeof rfc822>[0]> = {}) =>
    rfc822({ from: "Equipe <forwarding-noreply@google.com.attacker.net>", body: `Clique: ${VF}`, ...sobra });

  it("From de outro domínio não guarda link e segue como e-mail comum", async () => {
    expect(await processarEmailEncaminhado(job(encAna, falso()))).toBe("ignorado");
    const enc = await linha(encAna);
    expect(enc.confirmacaoLink).toBeNull();
    expect(enc.confirmacaoEm).toBeNull();
  });

  it("com envelope estranho é recusado", async () => {
    expect(await processarEmailEncaminhado(job(encAna, falso(), { envelopeDe: "ladrao@x.com" }))).toBe("envelope_recusado");
    expect((await linha(encAna)).confirmacaoLink).toBeNull();
  });
});

describe("6. ★ link com host falso", () => {
  it("num e-mail de From correto, host falso ou http não vira link guardado", async () => {
    const raw = rfc822({
      from: REMETENTE_CONFIRMACAO_GMAIL,
      body: "https://mail-settings.google.com.evil.io/mail/vf-x\r\nhttp://mail.google.com/mail/vf-x\r\nhttps://mail-settings.google.com@evil.io/mail/vf-x",
    });
    expect(await processarEmailEncaminhado(job(encAna, raw))).toBe("confirmacao_google");
    const enc = await linha(encAna);
    expect(enc.confirmacaoLink).toBeNull();
    expect(enc.confirmacaoEm).not.toBeNull();
  });

  it("linkDeConfirmacaoDoGmail: só vf- de host exato, com & do HTML desfeito", () => {
    expect(linkDeConfirmacaoDoGmail(`a ${VF} b`, null)).toBe(VF);
    expect(linkDeConfirmacaoDoGmail(null, `<a href="https://mail.google.com/mail/u/0/vf-%5BX%5D-y?a=1&amp;b=2">confirmar</a>`)).toBe(
      "https://mail.google.com/mail/u/0/vf-%5BX%5D-y?a=1&b=2",
    );
    // O cancelamento (uf-) nunca vale; e o vf- certo, ao lado dele, é o escolhido.
    expect(linkDeConfirmacaoDoGmail(UF, null)).toBeNull();
    expect(linkDeConfirmacaoDoGmail(`${UF} ${VF}`, null)).toBe(VF);
    for (const ruim of [
      "https://mail-settings.google.com.evil.io/mail/vf-x",
      // Hosts que terminam em google.com, mas não são os do Google: só o host EXATO vale.
      "https://evilgoogle.com/mail/vf-x",
      "https://sub.mail.google.com/mail/vf-x",
      "https://google.com/mail/vf-x",
      "https://evil.io/mail-settings.google.com/mail/vf-x",
      "https://mail-settings.google.com@evil.io/mail/vf-x",
      "https://evil.io/?u=https://mail.google.com/mail/vf-x",
      "http://mail.google.com/mail/vf-x",
      "https://mail.google.com/outro/vf-x",
      "https://mail.google.com/mail/vf",
    ]) {
      expect(linkDeConfirmacaoDoGmail(ruim, null)).toBeNull();
    }
    expect(linkDeConfirmacaoDoGmail(null, null)).toBeNull();
  });
});

describe("7. ★ envelope estranho", () => {
  it("é recusado, contado, e não mexe em ultimoRecebidoEm nem grava mensagem", async () => {
    const raw = () => rfc822({ from: `Cliente <${CLIENTE}>` });
    expect(await processarEmailEncaminhado(job(encAna, raw(), { envelopeDe: "ladrao@x.com" }))).toBe("envelope_recusado");
    expect((await linha(encAna)).recusados).toBe(1);
    // O endereço da própria caixa, mas sem o `caf_` (não veio do encaminhamento).
    expect(await processarEmailEncaminhado(job(encAna, raw(), { envelopeDe: "a.na@gmail.com" }))).toBe("envelope_recusado");

    const enc = await linha(encAna);
    expect(enc.recusados).toBe(2);
    expect(enc.ultimoRecusadoEm).not.toBeNull();
    expect(enc.ultimoRecebidoEm).toBeNull();
    expect(enc.confirmadoEm).toBeNull();
    expect(await mensagens()).toHaveLength(0);
  });
});

describe("8. Gmail com pontos", () => {
  it("a caixa a.na@gmail.com aceita o envelope ana+caf_=…@gmail.com", async () => {
    const raw = rfc822({ from: `Cliente <${CLIENTE}>` });
    expect(await processarEmailEncaminhado(job(encAna, raw, { envelopeDe: "ana+caf_=r+x=in.crmagro.example@gmail.com" }))).toBe("gravado");
  });

  it("envelopeDaCaixa: pontos, googlemail, domínio diferente e prefixo parecido", () => {
    const caixa = ["a.na@gmail.com"];
    expect(envelopeDaCaixa("ana+caf_=x@gmail.com", caixa)).toBe(true);
    expect(envelopeDaCaixa("a.na+caf_=x@googlemail.com", caixa)).toBe(true);
    expect(envelopeDaCaixa("  ANA+CAF_=x@GMAIL.COM ", caixa)).toBe(true);
    expect(envelopeDaCaixa("ana+caf_=x@outro.com", caixa)).toBe(false);
    expect(envelopeDaCaixa("anabela+caf_=x@gmail.com", caixa)).toBe(false);
    expect(envelopeDaCaixa("ana@gmail.com", caixa)).toBe(false);
    expect(envelopeDaCaixa("semarroba", caixa)).toBe(false);
    expect(envelopeDaCaixa("ana+caf_=x@gmail.com", [])).toBe(false);
    // Fora do Gmail, ponto conta: bia.x não é bia.
    expect(envelopeDaCaixa("bia+caf_=x@empresa.com.br", ["bia@empresa.com.br"])).toBe(true);
    expect(envelopeDaCaixa("b.ia+caf_=x@empresa.com.br", ["bia@empresa.com.br"])).toBe(false);
  });
});

describe("8a. ★ envelope de servidor do Google (o que o Gmail manda de verdade, visto em produção)", () => {
  // Observado em 01/10/2026: `<10 caracteres>@mail-dl2-x0f.google.com`, sem `+caf_=`, e o e-mail foi descartado.
  const REAL = "abcdefghij@mail-dl2-x0f.google.com";

  it("o e-mail encaminhado com esse envelope é gravado e confirma o encaminhamento", async () => {
    const raw = rfc822({ from: `Cliente <${CLIENTE}>` });
    expect(await processarEmailEncaminhado(job(encAna, raw, { envelopeDe: REAL }))).toBe("gravado");
    const enc = await linha(encAna);
    expect(enc.recusados).toBe(0);
    expect(enc.ultimoRecebidoEm).not.toBeNull();
    expect(enc.confirmadoEm).not.toBeNull();
    expect(await mensagens()).toHaveLength(1);
  });

  it("só servidor do Google passa: sufixo solto, domínio que contém google.com e @gmail.com comum não", () => {
    const caixa = ["a.na@gmail.com"];
    expect(envelopeDaCaixa(REAL, caixa)).toBe(true);
    expect(envelopeDaCaixa("  ABC@MAIL-DL2-X0F.GOOGLE.COM ", caixa)).toBe(true);
    expect(envelopeDaCaixa("x@google.com", caixa)).toBe(true);
    for (const falso of ["x@evilgoogle.com", "x@google.com.evil.io", "x@mail.google.com.br", "x@notgoogle.com", "x@gmail.com", "x@googleusercontent.com", "ladrao@x.com"]) {
      expect(envelopeDaCaixa(falso, caixa), falso).toBe(false);
    }
  });
});

describe("8b. resumo do envelope recusado (para o log, sem endereço)", () => {
  it("diz o que não bateu e não leva o endereço, nem o código, para o log", () => {
    const envelope = "carlos.secreto+caf_=r+abc123=in.crmagro.example@gmail.com";
    const resumo = resumoDoEnvelopeRecusado(envelope, ["outra.pessoa@gmail.com"]);
    expect(resumo).toMatchObject({
      envelopeValido: true,
      envelopeDominio: "gmail.com",
      temCaf: true,
      mesmoDominioDaCaixa: true,
      localIgualAoDaCaixa: false,
    });
    const texto = JSON.stringify(resumo);
    for (const pedaco of ["carlos", "secreto", "abc123", "outra", "pessoa", "crmagro"]) expect(texto).not.toContain(pedaco);
  });

  it("outro domínio, sem caf e envelope sem arroba", () => {
    expect(resumoDoEnvelopeRecusado("ana+caf_=x@outro.com", ["ana@gmail.com"])).toMatchObject({
      mesmoDominioDaCaixa: false,
      localIgualAoDaCaixa: false,
      caixaDominios: ["gmail.com"],
    });
    expect(resumoDoEnvelopeRecusado("ana@gmail.com", ["ana@gmail.com"])).toMatchObject({ temCaf: false, localIgualAoDaCaixa: true });
    expect(resumoDoEnvelopeRecusado("semarroba", ["ana@gmail.com"])).toEqual({ envelopeValido: false, caixaDominios: ["gmail.com"] });
  });
});

describe("9. ★ dois times", () => {
  it("o encaminhamento da Ana com o teamId do time B é 'sem_caixa' e nada é gravado", async () => {
    const antesEnc = await linha(encAna);
    const raw = rfc822({ from: `Cliente <${CLIENTE}>` });
    expect(await processarEmailEncaminhado(job(encAna, raw, { teamId: B }))).toBe("sem_caixa");

    expect(await totais(A)).toEqual({ mensagens: 0, atividades: 0, contatos: 1, conversas: 0 });
    expect(await totais(B)).toEqual({ mensagens: 0, atividades: 0, contatos: 0, conversas: 0 });
    expect(await linha(encAna)).toEqual(antesEnc);
  });
});

describe("10. ★ duas pessoas no mesmo time", () => {
  it("o mesmo contato, pela caixa da Bia, cai na conversa da Bia e não na da Ana", async () => {
    const daAna = rfc822({ from: `Cliente <${CLIENTE}>`, messageId: "<caso10-ana@lead.com.br>" });
    const daBia = rfc822({ from: `Cliente <${CLIENTE}>`, messageId: "<caso10-bia@lead.com.br>" });
    expect(await processarEmailEncaminhado(job(encAna, daAna))).toBe("gravado");
    expect(await processarEmailEncaminhado(job(encBia, daBia, { envelopeDe: ENV_BIA }))).toBe("gravado");

    const msgs = await mensagens();
    const doId = (id: string) => msgs.find((m) => m.providerMessageId === id)!;
    expect(doId("<caso10-ana@lead.com.br>").conversation.channelAccountId).toBe(caixaAna);
    expect(doId("<caso10-bia@lead.com.br>").conversation.channelAccountId).toBe(caixaBia);
    expect(await basePrisma.conversation.count({ where: { teamId: A, contactId: contatoId } })).toBe(2);
  });

  it("o envelope da Ana na caixa da Bia é recusado", async () => {
    const raw = rfc822({ from: `Cliente <${CLIENTE}>` });
    expect(await processarEmailEncaminhado(job(encBia, raw, { envelopeDe: ENV_ANA }))).toBe("envelope_recusado");
    expect(await mensagens()).toHaveLength(0);
  });
});

describe("11. caixa apagada", () => {
  it("a caixa some (a E2 apaga o encaminhamento em cascata) e o job vira 'sem_caixa'", async () => {
    const caixa = (
      await basePrisma.channelAccount.create({
        data: { teamId: A, canal: "email", label: "Vai sumir", provider: "smtp", ownerId: ANA, credentials: cred("sumir@gmail.com", "sumir@gmail.com") },
      })
    ).id;
    await comoAna(() => gerarEncaminhamento(caixa));
    const enc = (await basePrisma.emailEncaminhamento.findUniqueOrThrow({ where: { channelAccountId: caixa } })).id;
    await basePrisma.channelAccount.delete({ where: { id: caixa } });

    const raw = rfc822({ from: `Cliente <${CLIENTE}>` });
    expect(await processarEmailEncaminhado(job(enc, raw, { envelopeDe: "sumir+caf_=x@gmail.com" }))).toBe("sem_caixa");
    expect(await mensagens()).toHaveLength(0);
  });
});

describe("12. teto por hora", () => {
  it("estourou: 'excesso', nada gravado, e o limite foi pedido com a chave e a janela certas", async () => {
    rl.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const raw = rfc822({ from: `Cliente <${CLIENTE}>` });
    expect(await processarEmailEncaminhado(job(encAna, raw))).toBe("excesso");

    expect(rl).toHaveBeenCalledWith(`email-entrada:${encAna}`, 300, 3_600_000);
    expect(await mensagens()).toHaveLength(0);
    const enc = await linha(encAna);
    expect(enc.ultimoRecebidoEm).toBeNull();
    expect(enc.recusados).toBe(0);
  });
});

describe("13. emailDoMime", () => {
  it("Message-ID com < >, From em minúsculas, References como lista e a data de chegada passada", async () => {
    const recebidoEm = new Date("2026-10-01T10:00:00Z");
    const raw = Buffer.from(
      rfc822({ from: "Ana Silva <ANA@Gmail.COM>", messageId: "<Abc.123@Mail.Teste>", references: ["<r1@x>", "<r2@x>"], inReplyTo: "<r2@x>", body: "Olá" }),
    );
    const { email, html } = await emailDoMime(raw, { recebidoEm });
    expect(email).toMatchObject({
      uid: 0,
      from: "ana@gmail.com",
      fromName: "Ana Silva",
      messageId: "<Abc.123@Mail.Teste>",
      inReplyTo: "<r2@x>",
      references: ["<r1@x>", "<r2@x>"],
      isBounce: false,
      bounce: null,
    });
    expect(email.recebidoEm).toBe(recebidoEm);
    expect(email.text).toContain("Olá");
    expect(html).toBeNull();
  });

  it("e-mail cortado no meio (sem o fim do multipart) não lança e devolve o texto", async () => {
    const cortado = [
      "From: ana@gmail.com",
      "Message-ID: <cortado@x>",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Texto que chegou",
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Html pela metade",
    ].join("\r\n");
    const { email, html } = await emailDoMime(Buffer.from(cortado), { recebidoEm: new Date() });
    expect(email.text).toContain("Texto que chegou");
    expect(email.messageId).toBe("<cortado@x>");
    expect(html === null || typeof html === "string").toBe(true);
  });

  it("aviso de não entrega é marcado como bounce", async () => {
    const aviso = rfc822({ from: "MAILER-DAEMON@mx.google.com", subject: "Delivery Status Notification (Failure)", body: "Falhou" });
    const { email } = await emailDoMime(Buffer.from(aviso), { recebidoEm: new Date() });
    expect(email.isBounce).toBe(true);
    expect(email.bounce).not.toBeNull();
  });
});

describe("e-mail vazio", () => {
  it("rawB64 vazio é 'invalido' e não toca o banco", async () => {
    expect(await processarEmailEncaminhado({ ...job(encAna, ""), rawB64: "" })).toBe("invalido");
    expect(rl).not.toHaveBeenCalled();
  });
});
