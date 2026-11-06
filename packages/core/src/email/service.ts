import type { Prisma } from "@prisma/client";
import { env } from "@crmagro/config";
import { db, basePrisma, runAsSystem, tenantData, encryptCredentials, decryptCredentials } from "@crmagro/db";
import { ChannelSendFailed, EmailProvider, GmailSemAutorizacao, getChannelProvider, verifyImapDetailed, type SmtpConfig } from "@crmagro/channels";
import { emailParaEnvio } from "../contacts/identifiers";
import { GoogleAutorizacaoInvalida } from "../agenda/google/cliente";
import { accessTokenDaConexao, ConexaoGoogleInativa } from "../agenda/google/conexao";
import { PROVEDOR_GMAIL_API } from "../agenda/google/gmail-envio";
import { classificarAbertura, type AberturaDoPixel } from "./pixel";
import { getActor, requireCan } from "../auth/authz";
import { OwnedNotFound } from "../tenancy/assert-owned";
import { escopoCanal, escopoConversa } from "../conversations/escopo";
import { escopoDoContato } from "../contacts/escopo";
import { previewDaMensagem, touchConversation } from "../conversations/ultima-mensagem";
import { metaImapAoReconectar } from "./leitura-imap";
import { adotarAssinaturasSemCaixa, assinaturaDoEnvio } from "./signatures";

import { donoPadrao } from "../tenancy/escopo";
/**
 * Texto puro → HTML mínimo para o corpo do e-mail.
 *
 * Preserva a ESTRUTURA que o usuário digitou (quebras de linha, linhas em
 * branco, indentação e espaços múltiplos). O bug anterior usava só `\n → <br>`
 * dentro de um `<div>` comum — e o HTML colapsa espaços/indentação, então um
 * e-mail "montado estruturado" chegava desestruturado. A correção:
 *   - `white-space:pre-wrap` mantém espaços/indentação e quebras exatamente
 *     como digitadas (com wrap para não estourar a largura);
 *   - normaliza CRLF/CR para `\n` (mantidos literais, sem `<br>` que dobraria
 *     as quebras sob pre-wrap).
 */
function textToHtml(text: string): string {
  const esc = text
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word">${esc}</div>`;
}

/**
 * Monta o cabeçalho From no formato `"Nome" <email@dominio>` usando o NOME
 * (label) configurado na ChannelAccount de e-mail. Sem isso, o cliente de
 * e-mail exibe só o local-part do endereço (ex.: "marcos.lima") como remetente.
 * Se o endereço já vier com display name (contém `<`), respeita o que está lá.
 */
function formatFromHeader(label: string | null | undefined, address: string): string {
  const addr = address.trim();
  if (addr.includes("<")) return addr; // já tem display name embutido
  const nome = (label ?? "").trim();
  if (!nome) return addr;
  // Escapa aspas do nome e sempre entre aspas (nomes com vírgula/acento são seguros).
  const nomeSeguro = `"${nome.replace(/"/g, '\\"')}"`;
  return `${nomeSeguro} <${addr}>`;
}

/**
 * Canal de E-mail (SMTP). A conta é uma `ChannelAccount` (canal=email,
 * provider=smtp) com as credenciais SMTP CIFRADAS (a senha nunca fica em claro
 * no banco). O envio resolve a conta, decifra, monta o provider (factory) e
 * dispara — e registra uma Activity `email` no histórico do contato (a espinha).
 * Tudo tenant-scoped (db() eager).
 */

export type ConnectEmailInput = {
  // Em edição, `id` aponta a conta existente; sem ele, cria/atualiza a única de e-mail.
  id?: string;
  label: string;
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  // Em edição, vazio = manter a senha atual (nunca é devolvida à UI).
  pass: string;
  from?: string;
  // IMAP (recebimento). Opcional: sem ele, só envia (não recebe respostas).
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  // Assinatura (texto) anexada no corpo ao escrever/responder.
  signature?: string;
};

/** Blob completo guardado cifrado nas credenciais (SMTP + IMAP). */
type EmailCredentials = SmtpConfig & {
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  signature?: string;
};

function cfgFrom(input: ConnectEmailInput): EmailCredentials {
  return {
    host: input.host.trim(),
    port: Number(input.port),
    secure: input.secure ?? false,
    user: input.user.trim(),
    pass: input.pass,
    from: (input.from || input.user).trim(),
    signature: (input.signature ?? "").trim(),
    ...(input.imapHost?.trim() ? { imapHost: input.imapHost.trim() } : {}),
    ...(input.imapPort ? { imapPort: Number(input.imapPort) } : {}),
    imapSecure: input.imapSecure ?? true,
  };
}

/** A caixa não é de quem está conectando (F3): outra pessoa da equipe já a conectou. */
export class CaixaDeOutraPessoa extends Error {
  constructor() {
    super("Esta caixa de e-mail já foi conectada por outra pessoa da equipe. Peça ao administrador para transferi-la.");
    this.name = "CaixaDeOutraPessoa";
  }
}

/** A caixa já envia pelo Gmail sem senha (`gmail_api`): não se regrava senha de app em cima dela. */
export class CaixaJaConectadaPeloGmail extends Error {
  constructor() {
    super("Esta caixa já envia pelo Gmail sem senha. Desligue o envio pelo Gmail antes de conectar com senha de app.");
    this.name = "CaixaJaConectadaPeloGmail";
  }
}

/**
 * "Conectar" sem id (F3, revisão do #153): a mesma caixa (endereço) não vira
 * duas contas — cada e-mail recebido cairia numa delas e cada pessoa veria uma
 * caixa incompleta. Mesmo endereço no escopo = atualiza; fora do escopo = recusa.
 */
async function caixaDoMesmoEndereco(user: string | undefined) {
  const prisma = db();
  const alvo = (user ?? "").trim().toLowerCase();
  if (!alvo) return null;
  // `gmail_api` entra na busca: o mesmo endereço não vira duas caixas (com senha e sem senha).
  const caixas = await prisma.channelAccount.findMany({
    where: { canal: "email", provider: { in: ["smtp", "gmail", PROVEDOR_GMAIL_API] } },
    select: { id: true, provider: true, credentials: true },
  });
  const mesma = caixas.find(
    (c) => ((decryptCredentials(c.credentials) as Partial<EmailCredentials> | null)?.user ?? "").trim().toLowerCase() === alvo,
  );
  if (!mesma) return null;
  const minha = await prisma.channelAccount.findFirst({ where: { AND: [{ id: mesma.id }, escopoCanal({ escrita: true })] } });
  if (!minha) throw new CaixaDeOutraPessoa();
  // Hoje ela seria ATUALIZADA com as credenciais SMTP: a caixa do Gmail não é de senha.
  if (mesma.provider === PROVEDOR_GMAIL_API) throw new CaixaJaConectadaPeloGmail();
  return minha;
}

/** Conecta/atualiza a conta de e-mail (verifica SMTP, cifra, upsert). */
export async function connectEmailAccount(input: ConnectEmailInput): Promise<{ connected: boolean; error?: string }> {
  requireCan("integrations.manage");
  const prisma = db();
  const existing = input.id
    ? await prisma.channelAccount.findFirst({ where: { AND: [{ id: input.id, canal: "email" }, escopoCanal({ escrita: true })] } })
    : await caixaDoMesmoEndereco(input.user);
  // Editar pelo id uma caixa do Gmail regravaria credencial SMTP nela.
  if (existing?.provider === PROVEDOR_GMAIL_API) throw new CaixaJaConectadaPeloGmail();

  // Senha: em edição, vazia = manter a atual (nunca é devolvida à UI).
  let pass = input.pass;
  if (!pass && existing) {
    const cur = decryptCredentials(existing.credentials) as Partial<EmailCredentials> | null;
    pass = cur?.pass ?? "";
  }
  if (!pass) throw new Error("senha obrigatória");

  const cfg = cfgFrom({ ...input, pass });
  const smtp = await new EmailProvider(cfg).verifyDetailed();
  const credentials = encryptCredentials(cfg) as unknown as Prisma.InputJsonValue;
  const status = smtp.ok ? "connected" : "error";

  if (existing) {
    // Reconectar zera as falhas do IMAP (item 2.8) e volta a ler; o cursor só
    // vale se a caixa (host IMAP + usuário) é a mesma.
    const antes = decryptCredentials(existing.credentials) as Partial<EmailCredentials> | null;
    const meta = metaImapAoReconectar(existing.meta, antes?.imapHost === cfg.imapHost && antes?.user === cfg.user);
    await prisma.channelAccount.update({
      where: { id: existing.id },
      data: { label: input.label.trim() || cfg.user, credentials, status, ...(meta !== undefined ? { meta } : {}) },
    });
  } else {
    const nova = await prisma.channelAccount.create({
      data: tenantData<Prisma.ChannelAccountUncheckedCreateInput>({
        canal: "email",
        provider: "smtp",
        ownerId: donoPadrao(), // F3: quem conectou (vê as conversas; + master/admin/"ver tudo")
        label: input.label.trim() || cfg.user,
        credentials,
        status,
      }),
      select: { id: true },
    });
    // Assinaturas antigas de quando o time não tinha caixa passam para esta.
    await adotarAssinaturasSemCaixa(nova.id);
  }
  return { connected: smtp.ok, error: smtp.error };
}

export type TestEmailResult = {
  smtp: { ok: boolean; error?: string };
  imap?: { ok: boolean; error?: string };
};

/**
 * Testa a conexão SMTP (e IMAP, se informado) SEM salvar — devolve o motivo da
 * falha para exibir no pop-up. Em edição (id) com senha vazia, usa a atual.
 */
export async function testEmailConnection(input: ConnectEmailInput): Promise<TestEmailResult> {
  requireCan("integrations.manage");
  const prisma = db();
  let pass = input.pass;
  if (!pass && input.id) {
    const existing = await prisma.channelAccount.findFirst({ where: { AND: [{ id: input.id, canal: "email" }, escopoCanal({ escrita: true })] } });
    if (existing) {
      const cur = decryptCredentials(existing.credentials) as Partial<EmailCredentials> | null;
      pass = cur?.pass ?? "";
    }
  }
  if (!pass) return { smtp: { ok: false, error: "Informe a senha (senha de app, no caso do Gmail)." } };

  const cfg = cfgFrom({ ...input, pass });
  const smtp = await new EmailProvider(cfg).verifyDetailed();
  let imap: { ok: boolean; error?: string } | undefined;
  if (cfg.imapHost) {
    imap = await verifyImapDetailed({
      host: cfg.imapHost,
      port: cfg.imapPort ?? 993,
      secure: cfg.imapSecure ?? true,
      user: cfg.user,
      pass: cfg.pass,
    });
  }
  return { smtp, imap };
}

export type EmailAccountDTO = {
  id: string;
  label: string;
  status: string;
  connected: boolean;
  from: string | null;
  host: string | null;
};

/** Lista as contas de e-mail (mascarado — nunca a senha). */
export async function listEmailAccounts(): Promise<EmailAccountDTO[]> {
  const prisma = db();
  const rows = await prisma.channelAccount.findMany({
    where: { AND: [{ canal: "email" }, escopoCanal()] }, // F3: as caixas que a pessoa vê
    select: { id: true, label: true, status: true, credentials: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => {
    const cfg = decryptCredentials(r.credentials) as Partial<SmtpConfig> | null;
    return {
      id: r.id,
      label: r.label,
      status: r.status,
      connected: r.status === "connected",
      from: cfg?.from ?? cfg?.user ?? null,
      host: cfg?.host ?? null,
    };
  });
}

/** Config editável de uma conta de e-mail (SMTP + IMAP), SEM a senha. */
export type EmailAccountConfigDTO = {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  signature: string;
  hasPass: boolean;
};

/** Devolve a config de uma conta de e-mail para pré-preencher a edição (nunca a senha). */
export async function getEmailAccountConfig(id: string): Promise<EmailAccountConfigDTO | null> {
  const prisma = db();
  const row = await prisma.channelAccount.findFirst({
    where: { AND: [{ id, canal: "email" }, escopoCanal()] },
    select: { id: true, label: true, credentials: true },
  });
  if (!row) return null;
  const cfg = decryptCredentials(row.credentials) as Partial<EmailCredentials> | null;
  return {
    id: row.id,
    label: row.label,
    host: cfg?.host ?? "",
    port: cfg?.port ?? 587,
    secure: cfg?.secure ?? false,
    user: cfg?.user ?? "",
    from: cfg?.from ?? cfg?.user ?? "",
    imapHost: cfg?.imapHost ?? "",
    imapPort: cfg?.imapPort ?? 993,
    imapSecure: cfg?.imapSecure ?? true,
    signature: cfg?.signature ?? "",
    hasPass: Boolean(cfg?.pass),
  };
}

/** Remove uma conta de e-mail. */
export async function deleteEmailAccount(id: string): Promise<void> {
  requireCan("integrations.manage");
  const prisma = db();
  await prisma.channelAccount.deleteMany({ where: { AND: [{ id, canal: "email" }, escopoCanal({ escrita: true })] } });
}

/**
 * "Desligar o envio pelo Gmail": apaga a caixa `gmail_api`. Pode o dono da caixa (que é
 * membro, sem `integrations.manage`) ou o administrador. As conversas ficam (FK
 * `SetNull`); a Agenda continua conectada e NÃO há revogação no Google (a permissão de
 * enviar e-mail segue na conexão, mas sem caixa nada envia; desconectar a Agenda revoga tudo).
 */
export async function desligarEnvioPeloGmail(id: string): Promise<void> {
  const ator = requireCan("conexao.propria");
  const prisma = db();
  const caixa = await prisma.channelAccount.findFirst({
    where: { AND: [{ id, canal: "email", provider: PROVEDOR_GMAIL_API }, escopoCanal({ escrita: true })] },
    select: { id: true, ownerId: true },
  });
  if (!caixa) throw new OwnedNotFound("channelAccount", [id]);
  if (caixa.ownerId !== ator.userId) requireCan("integrations.manage");
  await prisma.channelAccount.deleteMany({ where: { id: caixa.id } });
}

/** Resolve o provider de e-mail de uma conta (decifra as credenciais). */
/**
 * Qual conta de e-mail vai enviar (a do nó ou a primeira conectada) — o motor
 * precisa do id ANTES do envio para a cota, o aquecimento e o espaçamento
 * (item 1.7). `null` = nenhuma conta de e-mail.
 */
export async function resolverContaDeEmail(channelAccountId?: string): Promise<string | null> {
  const prisma = db();
  // F3: pessoa só envia pela caixa que pode usar ("Ver e editar"; o motor, sistema, usa todas).
  const acc = channelAccountId
    ? await prisma.channelAccount.findFirst({ where: { AND: [{ id: channelAccountId }, escopoCanal({ escrita: true })] }, select: { id: true, canal: true } })
    : await prisma.channelAccount.findFirst({
        where: { AND: [{ canal: "email", status: "connected" }, escopoCanal({ escrita: true })] },
        orderBy: { createdAt: "asc" },
        select: { id: true, canal: true },
      });
  return acc && acc.canal === "email" ? acc.id : null;
}

/**
 * `doTime`: NOTIFICAÇÃO do time (convite de agenda, convite de equipe, reset,
 * alerta) — sem conta informada, usa a caixa da pessoa e, se ela não tiver,
 * a primeira caixa conectada do time (antes, com as caixas todas do master, o
 * convite da agenda de um vendedor deixava de sair em silêncio). Prospecção
 * (`sendEmail`) nunca usa isto: pessoa só envia pela caixa que vê.
 */
async function resolveEmailProvider(channelAccountId?: string, opts: { doTime?: boolean } = {}) {
  const prisma = db();
  const ator = getActor();
  const conectada: Prisma.ChannelAccountWhereInput = { canal: "email", status: "connected" };
  // Notificação do time NUNCA sai pelo Gmail pessoal de outra pessoa: na escolha automática, uma
  // caixa `gmail_api` só vale se for da própria pessoa; e no fallback do time, nunca.
  const doTimeSoDaPessoa: Prisma.ChannelAccountWhereInput[] = opts.doTime
    ? [{ OR: [{ provider: { not: PROVEDOR_GMAIL_API } }, { ownerId: ator && !ator.system ? ator.userId : "-" }] }]
    : [];
  const acc = channelAccountId
    ? await prisma.channelAccount.findFirst({ where: { AND: [{ id: channelAccountId }, escopoCanal({ escrita: true })] } })
    : ((await prisma.channelAccount.findFirst({ where: { AND: [conectada, escopoCanal({ escrita: true }), ...doTimeSoDaPessoa] }, orderBy: { createdAt: "asc" } })) ??
      (opts.doTime ? await prisma.channelAccount.findFirst({ where: { ...conectada, provider: { not: PROVEDOR_GMAIL_API } }, orderBy: { createdAt: "asc" } }) : null));
  if (!acc || acc.canal !== "email") return null;
  if (acc.provider === PROVEDOR_GMAIL_API) return resolverGmailApi(acc);
  const cfg = decryptCredentials(acc.credentials) as EmailCredentials;
  // Usa o NOME (label) da conta como display name do remetente (From).
  const fromAddress = (cfg.from || cfg.user || "").trim();
  cfg.from = formatFromHeader(acc.label, fromAddress);
  const provider = getChannelProvider({ canal: "email", provider: acc.provider, credentials: cfg });
  return provider ? { provider, accountId: acc.id } : null;
}

/**
 * Caixa `gmail_api` (envio pelo Gmail, E7a): as credenciais só apontam para a conexão OAuth
 * da Agenda Google da pessoa; o access token vem dela, renovado sob demanda. Conexão que
 * sumiu ou que não está `connected`: a caixa é marcada `disconnected` e o envio falha SEM
 * repetir (`GmailSemAutorizacao`: a pessoa precisa reconectar). Google que recusa a
 * renovação (`invalid_grant`): a `marcarReautorizacao` já pôs a conexão em `reauth_required`
 * e a caixa em `error`.
 */
async function resolverGmailApi(acc: { id: string; label: string; credentials: unknown }) {
  const prisma = db();
  const cred = decryptCredentials(acc.credentials) as { oauthConnectionId?: string; from?: string; user?: string } | null;
  const conexao = cred?.oauthConnectionId
    ? await prisma.oAuthConnection.findFirst({
        where: { id: cred.oauthConnectionId },
        select: { id: true, teamId: true, userId: true, status: true, credentials: true, accessTokenExpiraEm: true },
      })
    : null;
  if (!conexao || conexao.status !== "connected") {
    await prisma.channelAccount.updateMany({ where: { id: acc.id }, data: { status: "disconnected" } });
    throw new GmailSemAutorizacao("Gmail desconectado: reconecte em Integrações");
  }
  let accessToken: string;
  try {
    accessToken = await accessTokenDaConexao(conexao);
  } catch (e) {
    if (e instanceof GoogleAutorizacaoInvalida || e instanceof ConexaoGoogleInativa) {
      throw new GmailSemAutorizacao("Gmail sem autorização: reconecte em Integrações");
    }
    throw e;
  }
  const from = formatFromHeader(acc.label, (cred?.from || cred?.user || "").trim());
  const provider = getChannelProvider({ canal: "email", provider: PROVEDOR_GMAIL_API, credentials: { accessToken, from } });
  return provider ? { provider, accountId: acc.id } : null;
}

/**
 * Envia um convite de calendário (.ics) para um e-mail avulso (ex.: convidado de
 * um compromisso). Não registra Activity — é uma notificação, não prospecção.
 * Usa a primeira conta de e-mail conectada (ou a informada).
 */
export async function sendCalendarInvite(input: {
  to: string;
  subject: string;
  text: string;
  ics: string;
  channelAccountId?: string;
}): Promise<void> {
  const resolved = await resolveEmailProvider(input.channelAccountId, { doTime: true });
  if (!resolved) throw new Error("nenhuma conta de e-mail conectada para enviar o convite");
  await resolved.provider.send({
    to: input.to,
    content: { text: input.text, subject: input.subject, icsEvent: input.ics },
  });
}

/**
 * Envia um e-mail TRANSACIONAL (reset de senha, convite) para um endereço avulso,
 * reusando o SMTP dos canais já conectados (memória "CRM Agro — Canal de e-mail").
 * NÃO cria Activity nem toca no inbox — é notificação de sistema, não prospecção.
 *
 * LEGADO (S-05): os e-mails de conta passam por `enviarEmailDoSistema`
 * (./sistema.ts), que usa o remetente da PLATAFORMA quando configurado e só
 * cai aqui sem ele. Não chame direto para e-mail novo de sistema.
 *
 * Tenant-scoped: resolve a conta de e-mail do time no contexto atual (`db()`),
 * então DEVE rodar dentro de `runWithTeam(teamId, ...)`. Retorna `false` (fail-soft)
 * quando o time não tem nenhuma conta de e-mail conectada — o chamador decide se
 * isso é erro (convite) ou silêncio (reset, para não revelar estado da conta).
 */
export async function sendTransactionalEmail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  channelAccountId?: string;
}): Promise<boolean> {
  const resolved = await resolveEmailProvider(input.channelAccountId, { doTime: true });
  if (!resolved) return false;
  await resolved.provider.send({
    to: input.to,
    content: { text: input.text, subject: input.subject, ...(input.html ? { html: input.html } : {}) },
  });
  return true;
}

/**
 * Envia um e-mail para um contato e registra no histórico (Activity `email`).
 * `body` é texto; `html` opcional. Retorna o id da mensagem no provider.
 */
export async function sendEmail(
  contactId: string,
  input: {
    subject: string;
    body: string;
    html?: string;
    channelAccountId?: string;
    /** Assinatura escolhida (ou `ASSINATURA_PADRAO_DA_CAIXA`); vale só se for da caixa que envia. */
    signatureId?: string;
    /** Thread (item 3.4): Message-ID respondido e a cadeia de References. */
    inReplyTo?: string;
    references?: string[];
  },
  ganchos: {
    antesDeEnviar?: () => Promise<void>;
    depoisDeEnviar?: (providerMessageId: string) => Promise<void>;
  } = {},
  /** Resposta dentro de uma conversa já conferida (a caixa é da pessoa; o contato pode ser de outro). */
  opts: { conversaConferida?: boolean } = {},
): Promise<{ providerMessageId: string; messageId: string }> {
  requireCan("messages.send");
  const prisma = db();
  // F3: e-mail novo só para contato do escopo de escrita (o motor, sistema, vê todos).
  const contact = await prisma.contact.findFirst({
    where: opts.conversaConferida ? { id: contactId } : { AND: [{ id: contactId }, escopoDoContato({ escrita: true })] },
    select: { id: true, identifiers: true },
  });
  if (!contact) throw new Error("contato não encontrado no time");
  // Endereço marcado inválido por bounce (item 3.4) não recebe de novo: usa
  // outro e-mail válido do contato ou recusa sem enviar (determinístico).
  const destino = emailParaEnvio(contact.identifiers);
  if (destino.email === null) {
    if (destino.motivo === "contato sem e-mail") throw new Error("contato sem e-mail cadastrado");
    throw new ChannelSendFailed(destino.motivo, "not_sent", false);
  }
  const to = destino.email;

  const resolved = await resolveEmailProvider(input.channelAccountId);
  // Determinístico e pré-envio (item 1.2): o motor pula o passo em vez de
  // repetir 5× e marcar "retomada insegura".
  if (!resolved) throw new ChannelSendFailed("nenhuma conta de e-mail conectada", "not_sent", false);

  // Conversa de e-mail (canal=email) — a mesma espinha do inbox: uma conversa por
  // contato+conta. As mensagens (enviadas/recebidas) e o status ficam nela.
  let conv = await prisma.conversation.findFirst({
    where: { contactId, canal: "email", channelAccountId: resolved.accountId },
  });
  if (!conv) {
    conv = await prisma.conversation.create({
      data: tenantData<Prisma.ConversationUncheckedCreateInput>({
        contactId,
        canal: "email",
        channelAccountId: resolved.accountId,
        status: "open",
      }),
    });
  }

  // Cria a Message ANTES do envio (o id vira o tracking pixel de abertura).
  const msg = await prisma.message.create({
    data: tenantData<Prisma.MessageUncheckedCreateInput>({
      conversationId: conv.id,
      direcao: "out",
      tipo: "text",
      conteudo: input.body,
      status: "sent",
      meta: { subject: input.subject, to } as Prisma.InputJsonValue,
    }),
  });

  // Pixel de rastreamento de ABERTURA (1x1). Ao ser carregado pelo cliente de
  // e-mail, a rota /api/email/track/<id> marca a Message como "read" (✓✓ verde).
  const pixel = env.APP_PUBLIC_URL
    ? `<img src="${env.APP_PUBLIC_URL}/api/email/track/${msg.id}" width="1" height="1" alt="" style="display:none">`
    : "";
  // Assinatura (HTML) anexada ao fim do corpo: sempre da caixa QUE ENVIA — a
  // escolhida, se for desta caixa; senão a padrão desta caixa (por caixa, 28/09).
  const sig = await assinaturaDoEnvio(input.signatureId, resolved.accountId);
  const html = (input.html ?? textToHtml(input.body)) + (sig ? `<br><br>${sig}` : "") + pixel;

  let saiu = false;
  try {
    await ganchos.antesDeEnviar?.();
    const { providerMessageId } = await resolved.provider.send({
      to,
      content: {
        text: input.body,
        subject: input.subject,
        html,
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        ...(input.references?.length ? { references: input.references } : {}),
      },
    });
    saiu = true;
    await ganchos.depoisDeEnviar?.(providerMessageId);
    await prisma.message.update({
      where: { id: msg.id },
      data: { providerMessageId, statusAt: new Date() },
    });
    // lastMessageAt + prévia (o assunto) na mesma escrita — item 2.2.
    await touchConversation(conv.id, {
      preview: previewDaMensagem(input.body),
      direcao: "out",
      subject: input.subject,
    });
    await prisma.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId,
        tipo: "email",
        direcao: "out",
        conteudo: `E-mail: ${input.subject}`,
        meta: { channelAccountId: resolved.accountId, messageId: msg.id, providerMessageId, subject: input.subject, to },
      }),
    });
    return { providerMessageId, messageId: msg.id };
  } catch (e) {
    // O e-mail SAIU e o que falhou foi um registro depois: não marca "falhou"
    // (seria mentira) — o motor avança pela marca de "enviado" do passo.
    if (saiu) throw e;
    // Falha no envio → status "failed" (X). Registra a tentativa no histórico.
    const erro = e instanceof Error ? e.message : String(e);
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: "failed", errorCode: erro.slice(0, 140), statusAt: new Date() },
    });
    await prisma.activity.create({
      data: tenantData<Prisma.ActivityUncheckedCreateInput>({
        contactId,
        tipo: "email",
        direcao: "out",
        conteudo: `E-mail (falhou): ${input.subject}`,
        meta: { messageId: msg.id, subject: input.subject, to, erro: erro.slice(0, 200) },
      }),
    });
    throw e;
  }
}

/**
 * E-mail para onde o motor enviaria (item 3.4): o `send_email` consulta ANTES
 * do espaçamento e da cota — endereço inválido pula sem gastar nada.
 */
export async function emailDeEnvioDoContato(
  contactId: string,
): Promise<{ email: string; motivo: null } | { email: null; motivo: string }> {
  const identifiers = await db().channelIdentifier.findMany({
    where: { contactId, canal: "email" },
    select: { canal: true, valor: true, valorCifrado: true, isPrimary: true, invalido: true, invalidoMotivo: true },
  });
  return emailParaEnvio(identifiers);
}

/**
 * Registra a ABERTURA de um e-mail pelo pixel (item 3.4 — INT-21, S19). Chamado
 * pela rota do pixel, sem sessão: resolve o time cross-team (basePrisma) e abre
 * runAsSystem, igual aos webhooks.
 * - só mensagem de SAÍDA de conversa de E-MAIL (antes aceitava id de WhatsApp);
 * - hit de scanner/robô ou de menos de 60 s depois do envio não conta
 *   (`classificarAbertura`);
 * - grava a PRIMEIRA abertura (`openedAt`/`openSource`) e marca "read"; não
 *   regride status terminal (failed/bounced).
 */
export async function markEmailOpened(
  messageId: string,
  hit: { userAgent?: string | null } = {},
  agora: Date = new Date(),
): Promise<AberturaDoPixel | null> {
  const msg = await basePrisma.message.findFirst({
    where: { id: messageId, direcao: "out", conversation: { canal: "email" } },
    select: { id: true, teamId: true, status: true, createdAt: true, openedAt: true },
  });
  if (!msg) return null;
  const abertura = classificarAbertura({ userAgent: hit.userAgent, enviadoEm: msg.createdAt, agora });
  if (!abertura.conta || msg.openedAt || msg.status === "failed" || msg.status === "bounced") return abertura;
  await runAsSystem(msg.teamId, async () => {
    await db().message.updateMany({
      where: { id: messageId, openedAt: null },
      data: { status: "read", statusAt: agora, openedAt: agora, openSource: abertura.fonte },
    });
  });
  return abertura;
}

export type ContactEmailDTO = {
  id: string;
  subject: string;
  to: string | null;
  body: string | null;
  direcao: string;
  status: string;
  at: string;
  /** Primeira abertura que contou (item 3.4) e a fonte: "cliente" ou "proxy_*" (provável). */
  abertoEm: string | null;
  aberturaFonte: string | null;
};

/** E-mails (enviados/recebidos) de um contato, com status — para a aba "E-mails". */
export async function listEmailsForContact(contactId: string): Promise<ContactEmailDTO[]> {
  const prisma = db();
  const acts = await prisma.activity.findMany({
    where: { contactId, tipo: "email" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const ids = acts
    .map((a) => (a.meta as { messageId?: string } | null)?.messageId)
    .filter((x): x is string => !!x);
  const msgs = ids.length
    ? await prisma.message.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, conteudo: true, openedAt: true, openSource: true },
      })
    : [];
  const byId = new Map(msgs.map((m) => [m.id, m]));
  return acts.map((a) => {
    const meta = (a.meta ?? {}) as { messageId?: string; subject?: string; to?: string; from?: string };
    const m = meta.messageId ? byId.get(meta.messageId) : null;
    const direcao = a.direcao ?? "out";
    return {
      id: a.id,
      subject: meta.subject ?? "(sem assunto)",
      // Recebido: a contraparte é o remetente; enviado: o destinatário.
      to: direcao === "in" ? meta.from ?? null : meta.to ?? null,
      body: m?.conteudo ?? null,
      direcao,
      status: m?.status ?? "sent",
      at: a.createdAt.toISOString(),
      abertoEm: m?.openedAt?.toISOString() ?? null,
      aberturaFonte: m?.openSource ?? null,
    };
  });
}

// ─── Inbound (recebimento via IMAP): ver ./leitura-imap.ts ─────────────────

/**
 * Responde um e-mail dentro de uma conversa (canal=email): resolve o contato,
 * usa "Re: <último assunto>" e envia (com tracking). Usado pelo inbox de Conversas.
 */
export async function replyEmailInConversation(
  conversationId: string,
  body: string,
  subjectOverride?: string,
  signatureId?: string,
): Promise<{ providerMessageId: string; messageId: string }> {
  requireCan("messages.send");
  const prisma = db();
  const conv = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, escopoConversa({ escrita: true })] },
    select: { contactId: true, canal: true, channelAccountId: true },
  });
  if (!conv || conv.canal !== "email" || !conv.contactId) {
    throw new Error("conversa de e-mail inválida");
  }
  let subject = subjectOverride?.trim();
  if (!subject) {
    // Sem assunto informado: reaproveita o do último e-mail (Re:), senão genérico.
    const last = await prisma.activity.findFirst({
      where: { contactId: conv.contactId, tipo: "email" },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    });
    const lastSubject = (last?.meta as { subject?: string } | null)?.subject;
    subject = lastSubject
      ? lastSubject.toLowerCase().startsWith("re:")
        ? lastSubject
        : `Re: ${lastSubject}`
      : "(sem assunto)";
  }
  // Thread (item 3.4, INT-21): responde ao último e-mail RECEBIDO na conversa
  // (In-Reply-To + References), para cair na mesma conversa no cliente do lead.
  const recebida = await prisma.message.findFirst({
    where: {
      conversationId,
      direcao: "in",
      providerMessageId: { not: null },
      NOT: { providerMessageId: { startsWith: "sem-id:" } },
    },
    orderBy: { createdAt: "desc" },
    select: { providerMessageId: true, meta: true },
  });
  const thread = recebida?.providerMessageId
    ? {
        inReplyTo: recebida.providerMessageId,
        references: [
          ...((recebida.meta as { references?: string[] } | null)?.references ?? []).slice(-9),
          recebida.providerMessageId,
        ],
      }
    : {};
  return sendEmail(
    conv.contactId,
    {
      subject,
      body,
      ...(conv.channelAccountId ? { channelAccountId: conv.channelAccountId } : {}),
      ...(signatureId ? { signatureId } : {}),
      ...thread,
    },
    {},
    // A conversa (da caixa da pessoa) já foi conferida no escopo acima.
    { conversaConferida: true },
  );
}
