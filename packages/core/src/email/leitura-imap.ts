import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { basePrisma, db, decryptCredentials, getCurrentTeamId, runAsSystem, tenantData } from "@crmagro/db";
import { ondeIdentificadorExato, valorDe } from "../contacts/identificadores-cifra";
import {
  isImapAuthError,
  lerEmailsNovos,
  remetenteDeAviso,
  type FetchedEmail,
  type ImapCursor,
  type ImapEnvelope,
} from "@crmagro/channels";
import { isUniqueViolation } from "../contacts/errors";
import { acordarQuemEsperaResposta } from "../flows/aguardando";
import { previewDaMensagem, touchConversation } from "../conversations/ultima-mensagem";
import { publishRealtime } from "../events/redis-bus";
import { logger } from "../logger/index";
import { redisEstado } from "../shared/redis-cache";
import { optOutDoEmailRecebido } from "./opt-out-email";

/**
 * Leitura das caixas de e-mail (IMAP) — item 2.8 (DP-18/INT-05, INT-20).
 *
 * Por conta, a cada poll do worker:
 * - trava `email:poll:<accountId>` (SET NX EX 600): um poll lento não se
 *   sobrepõe ao seguinte (antes o mesmo e-mail podia entrar 2×);
 * - cursor `ChannelAccount.meta.imap = { uidValidity, lastUid }`: lê só UIDs
 *   novos, em ordem, qualquer que seja o estado de lido da caixa. Antes, caixa
 *   com 50+ não lidos relia sempre os mesmos 50 e a resposta nova nunca entrava;
 * - envelope primeiro; corpo só de remetente conhecido ou bounce;
 * - 3 falhas de AUTENTICAÇÃO seguidas → conta `status="error"` + aviso
 *   (`channel:disconnected`) e para de ler até reconectar. Antes: login errado
 *   a cada 2 min, em silêncio, até o provedor bloquear o IP do VPS;
 * - erro de rede → espera exponencial por conta (2, 4, 8... até 60 min);
 * - e-mail sem Message-ID deduplica por hash (remetente + data + assunto).
 *
 * O cursor é `meta` e não `credentials` porque não é segredo e muda a cada poll:
 * dentro das credenciais cifradas, cada poll decifraria e recifraria a senha, e
 * uma edição da conta feita no meio de um poll seria sobrescrita.
 */

export const EMAIL_POLL_TRAVA_S = 600;
/** Contas lidas em paralelo por rodada (o resto espera na fila da rodada). */
const CONCORRENCIA = 4;
export const MAX_FALHAS_AUTH = 3;
/** Sem cursor: começa na data da conexão da conta, no máximo 7 dias atrás. */
const JANELA_INICIAL_MS = 7 * 86_400_000;
const ESPERA_BASE_MS = 2 * 60_000;
const ESPERA_MAX_MS = 60 * 60_000;

/** Estado da leitura IMAP guardado em `ChannelAccount.meta.imap`. */
export type ImapMeta = {
  uidValidity?: string;
  lastUid?: number;
  falhasAuth?: number;
  falhasRede?: number;
  proximaTentativaEm?: string | null;
  ultimoErro?: string | null;
};

type Meta = { imap?: ImapMeta } & Record<string, unknown>;

function lerMeta(meta: Prisma.JsonValue | null): Meta {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Meta) : {};
}

function cursorDe(m: ImapMeta | undefined): ImapCursor | null {
  return m?.uidValidity && typeof m.lastUid === "number" ? { uidValidity: m.uidValidity, lastUid: m.lastUid } : null;
}

/**
 * Meta ao reconectar/editar a conta: zera as falhas (a conta volta a ser lida).
 * Mesma caixa (host IMAP + usuário) mantém o cursor; caixa trocada recomeça.
 * `undefined` = nada a mudar.
 */
export function metaImapAoReconectar(
  meta: Prisma.JsonValue | null,
  mesmaCaixa: boolean,
): Prisma.InputJsonValue | undefined {
  const atual = lerMeta(meta);
  if (!atual.imap) return undefined;
  const { imap, ...resto } = atual;
  const cursor = cursorDe(imap);
  return (mesmaCaixa && cursor ? { ...resto, imap: cursor } : resto) as Prisma.InputJsonValue;
}

/**
 * Chave de deduplicação do e-mail recebido: o Message-ID; sem ele, um hash de
 * remetente + data + assunto (antes, e-mail sem Message-ID era gravado de novo a
 * cada poll). Vai em `Message.providerMessageId` (único por time).
 */
export function chaveDedupEmail(e: {
  messageId: string | null;
  from: string | null;
  date: Date | null;
  subject: string | null;
}): string {
  if (e.messageId) return e.messageId;
  const base = `${e.from ?? ""}|${e.date?.toISOString() ?? ""}|${e.subject ?? ""}`;
  return `sem-id:${createHash("sha256").update(base).digest("hex").slice(0, 40)}`;
}

/** Refs de thread de um e-mail (In-Reply-To + References), sem repetição. */
function refsDe(e: { inReplyTo: string | null; references: string[] }): string[] {
  return [...new Set([e.inReplyTo, ...e.references].filter((x): x is string => !!x))];
}

/**
 * Quais e-mails do lote valem o corpo (roda no time da conta): bounce sempre;
 * resposta ainda não gravada de remetente cadastrado OU que responde a um
 * e-mail NOSSO (In-Reply-To/References — assistente, alias; item 3.4). O resto
 * fica só no envelope — nada de baixar a newsletter com anexo de quem não é contato.
 */
async function selecionarParaBaixar(envelopes: ImapEnvelope[]): Promise<Set<number>> {
  const prisma = db();
  const respostas = envelopes.filter((e) => !e.isBounce);
  const froms = [...new Set(respostas.filter((e) => e.from).map((e) => e.from!))];
  const chaves = respostas.map(chaveDedupEmail);
  const refs = [...new Set(respostas.flatMap(refsDe))];
  const [conhecidos, jaGravados, nossos] = await Promise.all([
    froms.length
      ? prisma.channelIdentifier.findMany({
          where: ondeIdentificadorExato(getCurrentTeamId() ?? "", "email", froms),
          select: { valor: true, valorCifrado: true },
        })
      : [],
    chaves.length
      ? prisma.message.findMany({ where: { providerMessageId: { in: chaves } }, select: { providerMessageId: true } })
      : [],
    refs.length
      ? prisma.message.findMany({
          where: { direcao: "out", providerMessageId: { in: refs } },
          select: { providerMessageId: true },
        })
      : [],
  ]);
  const conhecido = new Set(conhecidos.flatMap((c) => valorDe(c)?.toLowerCase() ?? []));
  const gravado = new Set(jaGravados.map((m) => m.providerMessageId));
  const enviadoPorNos = new Set(nossos.map((m) => m.providerMessageId));
  return new Set(
    envelopes
      .filter(
        (e) =>
          e.isBounce ||
          (!gravado.has(chaveDedupEmail(e)) &&
            ((e.from && conhecido.has(e.from)) || refsDe(e).some((r) => enviadoPorNos.has(r)))),
      )
      .map((e) => e.uid),
  );
}

/**
 * Bounce (item 3.4, INT-21): casa o e-mail ORIGINAL pelo Message-ID de dentro do
 * aviso (DSN) ou pelo In-Reply-To/References e marca "bounced" (laranja). Falha
 * PERMANENTE marca o endereço como inválido — o `send_email` passa a pular.
 * Aviso temporário (4.x.x, "delayed") não mexe em nada: o provedor ainda tenta.
 */
async function processarBounce(e: FetchedEmail): Promise<boolean> {
  const prisma = db();
  const info = e.bounce;
  const refs = [info?.messageIdOriginal, e.inReplyTo, ...e.references].filter((x): x is string => !!x);
  const orig = refs.length
    ? await prisma.message.findFirst({
        where: { direcao: "out", providerMessageId: { in: refs } },
        select: { id: true, status: true, meta: true },
      })
    : null;

  const destinatarios = info?.destinatarios ?? [];
  const soTemporario = destinatarios.length > 0 && destinatarios.every((d) => !d.permanente);
  if (soTemporario) return false;

  // Só vale aviso sobre e-mail NOSSO, e só o destinatário DELE é marcado
  // (auditoria do 3.4). Antes, um e-mail qualquer com `X-Failed-Recipients:
  // cliente@x` invalidava o endereço de um cliente bom — sabotagem silenciosa.
  if (!orig) {
    logger.info({ from: e.from, destinatarios: destinatarios.length }, "[email] aviso de não entrega que não casa nenhum e-mail nosso — ignorado");
    return false;
  }
  const para = /([^\s<>;"]+@[^\s<>;"]+)/.exec((orig.meta as { to?: string } | null)?.to ?? "")?.[1]?.toLowerCase() ?? null;
  const invalidos = new Map<string, string>();
  for (const d of destinatarios.filter((x) => x.permanente && x.email === para)) {
    invalidos.set(d.email, [d.status, d.diagnostico].filter(Boolean).join(": ") || "bounce permanente");
  }
  // Sem DSN legível: só com remetente de SISTEMA dizendo que o endereço não existe.
  if (invalidos.size === 0 && destinatarios.length === 0 && info?.permanenteSemDestinatario && para && remetenteDeAviso(e.from)) {
    invalidos.set(para, "bounce: endereço não existe");
  }
  if (invalidos.size === 0) {
    logger.info({ messageId: orig.id }, "[email] aviso de não entrega sem falha permanente do nosso destinatário — nada marcado");
    return false;
  }

  let mudou = false;
  if (orig.status !== "read" && orig.status !== "bounced") {
    await prisma.message.update({ where: { id: orig.id }, data: { status: "bounced", statusAt: new Date() } });
    mudou = true;
  }
  for (const [email, motivo] of invalidos) {
    const r = await prisma.channelIdentifier.updateMany({
      where: { canal: "email", valor: email, invalido: false },
      data: { invalido: true, invalidoMotivo: motivo.slice(0, 200) },
    });
    if (r.count > 0) {
      mudou = true;
      logger.info({ email, motivo }, "[email] endereço marcado inválido por bounce");
    }
  }
  return mudou;
}

/**
 * Processa UM e-mail recebido (dentro de runAsSystem). Bounce → `processarBounce`.
 * Resposta → cria Message (in) + Activity na conversa de e-mail do contato — o
 * contato vem do remetente ou, se o remetente não é cadastrado, do e-mail NOSSO
 * que ele responde. Sem nenhum dos dois: ignora. Idempotente pela chave de dedup
 * (Message-ID ou hash).
 *
 * Também usada pelo encaminhamento (`entrada-encaminhada.ts`).
 */
export async function processIncomingEmail(accountId: string, e: FetchedEmail): Promise<boolean> {
  const prisma = db();
  if (e.isBounce) return processarBounce(e);

  const from = e.from?.toLowerCase();
  if (!from) return false;
  let contactId = (
    await prisma.contact.findFirst({
      where: { identifiers: { some: { canal: "email", valor: from } } },
      select: { id: true },
    })
  )?.id;
  if (contactId) {
    // Chegou e-mail DELE: o endereço existe — desfaz uma marca antiga de bounce.
    await prisma.channelIdentifier.updateMany({
      where: { contactId, canal: "email", valor: from, invalido: true },
      data: { invalido: false, invalidoMotivo: null },
    });
  } else {
    const refs = refsDe(e);
    const respondido = refs.length
      ? await prisma.message.findFirst({
          where: { direcao: "out", providerMessageId: { in: refs } },
          select: { conversation: { select: { contactId: true } } },
        })
      : null;
    contactId = respondido?.conversation.contactId ?? undefined;
  }
  if (!contactId) return false; // remetente não-cadastrado e fora de thread nossa: ignora
  const contact = { id: contactId };

  const chave = chaveDedupEmail(e);
  const dup = await prisma.message.findFirst({ where: { providerMessageId: chave }, select: { id: true } });
  if (dup) return false;
  // E-mail SEM Message-ID gravado antes do item 2.8 não tem a chave `sem-id:`
  // (auditoria do #73): a 1ª leitura depois do deploy relê 7 dias e o gravaria
  // de novo. Confere pelo remetente + assunto + texto no formato antigo.
  if (!e.messageId) {
    const antigo = await prisma.message.findFirst({
      where: {
        direcao: "in",
        conversation: { contactId: contact.id, canal: "email" },
        conteudo: (e.text ?? "").slice(0, 10000),
        AND: [{ meta: { path: ["from"], equals: e.from ?? "" } }, { meta: { path: ["subject"], equals: e.subject ?? "" } }],
      },
      select: { id: true },
    });
    if (antigo) return false;
  }
  // Pedido de saída por e-mail (opt-out, N12): a mesma regra do WhatsApp, só
  // sobre a 1ª linha escrita pelo contato (sem a nossa mensagem citada). ANTES
  // de gravar: se cair no meio, a releitura grava e reaplica (idempotente).
  await optOutDoEmailRecebido({ contactId: contact.id, text: e.text, subject: e.subject });
  // Hora em que o e-mail CHEGOU à caixa (INTERNALDATE, relógio do SERVIDOR),
  // limitada a agora: relido depois do deploy, não conta como resposta NOVA no
  // "respondeu?". NÃO o cabeçalho `Date:` — ele é do relógio de quem enviou
  // (auditoria do #88): com o PC do lead 5 min atrasado, a resposta ficava
  // "antes" do nosso envio e o fluxo mandava o follow-up para quem respondeu.
  const agora = new Date();
  const chegada = e.recebidoEm && !Number.isNaN(e.recebidoEm.getTime()) ? e.recebidoEm : agora;
  const quando = chegada.getTime() <= agora.getTime() ? chegada : agora;

  const whereConv = { contactId: contact.id, canal: "email" as const, channelAccountId: accountId };
  let conv = await prisma.conversation.findFirst({ where: whereConv });
  if (!conv) {
    try {
      conv = await prisma.conversation.create({
        data: tenantData<Prisma.ConversationUncheckedCreateInput>({
          contactId: contact.id, canal: "email", channelAccountId: accountId, status: "open",
        }),
      });
    } catch (err) {
      // Poll concorrente criou primeiro (índice único conta+contato — item 0.8).
      if (!isUniqueViolation(err)) throw err;
      conv = await prisma.conversation.findFirst({ where: whereConv });
      if (!conv) throw err;
    }
  }

  try {
    await prisma.message.create({
      data: tenantData<Prisma.MessageUncheckedCreateInput>({
        conversationId: conv.id,
        direcao: "in",
        tipo: "text",
        conteudo: (e.text ?? "").slice(0, 10000),
        providerMessageId: chave,
        status: "read",
        createdAt: quando,
        meta: {
          subject: e.subject,
          from: e.from,
          // Thread (item 3.4): a resposta a este e-mail herda a cadeia.
          ...(e.references.length ? { references: e.references.slice(-10) } : {}),
          ...(e.inReplyTo ? { inReplyTo: e.inReplyTo } : {}),
        } as Prisma.InputJsonValue,
      }),
    });
  } catch (err) {
    // Mesma chave gravada por outro poll (índice único teamId+providerMessageId).
    if (isUniqueViolation(err)) return false;
    throw err;
  }
  await prisma.activity.create({
    data: tenantData<Prisma.ActivityUncheckedCreateInput>({
      contactId: contact.id,
      tipo: "email",
      direcao: "in",
      conteudo: `E-mail recebido: ${e.subject ?? "(sem assunto)"}`,
      meta: { subject: e.subject, from: e.from, messageId: e.messageId },
      createdAt: quando,
    }),
  });
  // lastMessageAt + prévia + não-lida na mesma escrita (item 2.2); e-mail
  // antigo não faz a conversa "andar para trás".
  await touchConversation(conv.id, {
    preview: previewDaMensagem(e.text),
    direcao: "in",
    subject: e.subject ?? null,
    naoLidas: 1,
    quando,
  });
  // Resposta por e-mail também acorda a condição "respondeu?" (item 1.1).
  await acordarQuemEsperaResposta(contact.id);
  return true;
}

type Conta = {
  id: string;
  teamId: string;
  label: string;
  credentials: Prisma.JsonValue | null;
  meta: Prisma.JsonValue | null;
  createdAt: Date;
};

type CredenciaisImap = { user: string; pass: string; imapHost?: string; imapPort?: number; imapSecure?: boolean };

export type ResultadoConta = "lida" | "sem_imap" | "esperando" | "travada" | "falha_auth" | "desativada" | "falha_rede";

const chaveTrava = (accountId: string) => `email:poll:${accountId}`;

/** Solta a trava só se ainda for nossa (expirou e outro poll pegou → não mexe). */
const SOLTAR_SE_MINHA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

async function gravarMeta(conta: Conta, imap: ImapMeta, extra: Prisma.ChannelAccountUpdateInput = {}) {
  const meta = { ...lerMeta(conta.meta), imap } as Prisma.InputJsonValue;
  await runAsSystem(conta.teamId, () =>
    db().channelAccount.update({ where: { id: conta.id }, data: { ...extra, meta } }),
  );
}

/** Lê uma conta (com a trava já adquirida) e aplica o resultado no meta/status. */
async function lerConta(conta: Conta, cfg: CredenciaisImap & { imapHost: string }, agora: Date) {
  const m = lerMeta(conta.meta).imap ?? {};
  const cursor = cursorDe(m);
  const desde = new Date(Math.max(conta.createdAt.getTime(), agora.getTime() - JANELA_INICIAL_MS));
  try {
    const leitura = await lerEmailsNovos(
      { host: cfg.imapHost, port: cfg.imapPort ?? 993, secure: cfg.imapSecure ?? true, user: cfg.user, pass: cfg.pass },
      cursor,
      { desde, selecionar: (envs) => runAsSystem(conta.teamId, () => selecionarParaBaixar(envs)) },
    );
    if (leitura.recomecou && cursor) {
      logger.warn(
        { channelAccountId: conta.id, antes: cursor.uidValidity, agora: leitura.cursor.uidValidity },
        "[email] UIDVALIDITY da caixa mudou — leitura recomeça por data",
      );
    }

    let processados = 0;
    const falharam: number[] = [];
    await runAsSystem(conta.teamId, async () => {
      for (const e of leitura.emails) {
        try {
          if (await processIncomingEmail(conta.id, e)) processados++;
        } catch (err) {
          falharam.push(e.uid);
          logger.error(
            { channelAccountId: conta.id, uid: e.uid, err: err instanceof Error ? err.message : String(err) },
            "[email] falha ao gravar e-mail recebido",
          );
        }
      }
    });
    // Um e-mail que falhou ao gravar não é pulado: o cursor para antes dele e o
    // próximo poll relê (os que entraram são ignorados pela dedup).
    const lastUid = falharam.length ? Math.min(leitura.cursor.lastUid, ...falharam.map((u) => u - 1)) : leitura.cursor.lastUid;
    await gravarMeta(conta, { uidValidity: leitura.cursor.uidValidity, lastUid, falhasAuth: 0, falhasRede: 0 });
    return { resultado: "lida" as const, processados };
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    if (isImapAuthError(err)) {
      const falhasAuth = (m.falhasAuth ?? 0) + 1;
      const desativar = falhasAuth >= MAX_FALHAS_AUTH;
      await gravarMeta(conta, { ...m, falhasAuth, ultimoErro: motivo }, desativar ? { status: "error" } : {});
      if (desativar) {
        await runAsSystem(conta.teamId, async () =>
          publishRealtime({ type: "channel:disconnected", channelAccountId: conta.id, label: conta.label }),
        );
        logger.warn(
          { channelAccountId: conta.id, falhasAuth, motivo },
          "[email] IMAP recusou a senha 3× seguidas — conta marcada com erro, leitura parada até reconectar",
        );
        return { resultado: "desativada" as const, processados: 0 };
      }
      logger.warn({ channelAccountId: conta.id, falhasAuth, motivo }, "[email] IMAP recusou a senha");
      return { resultado: "falha_auth" as const, processados: 0 };
    }
    const falhasRede = (m.falhasRede ?? 0) + 1;
    const espera = Math.min(ESPERA_BASE_MS * 2 ** (falhasRede - 1), ESPERA_MAX_MS);
    const proximaTentativaEm = new Date(agora.getTime() + espera).toISOString();
    await gravarMeta(conta, { ...m, falhasRede, proximaTentativaEm, ultimoErro: motivo });
    logger.warn({ channelAccountId: conta.id, falhasRede, proximaTentativaEm, motivo }, "[email] falha ao ler a caixa");
    return { resultado: "falha_rede" as const, processados: 0 };
  }
}

/** Uma conta: config, espera, trava, leitura. Nunca lança. */
async function pollConta(conta: Conta, agora: Date): Promise<{ resultado: ResultadoConta; processados: number }> {
  const cfg = decryptCredentials(conta.credentials) as CredenciaisImap | null;
  if (!cfg?.imapHost) return { resultado: "sem_imap", processados: 0 }; // sem IMAP → só envia
  const proxima = lerMeta(conta.meta).imap?.proximaTentativaEm;
  if (proxima && new Date(proxima) > agora) return { resultado: "esperando", processados: 0 };

  const token = randomUUID();
  let travou = false;
  try {
    travou = (await redisEstado().set(chaveTrava(conta.id), token, "EX", EMAIL_POLL_TRAVA_S, "NX")) === "OK";
  } catch (err) {
    // Sem Redis não há como garantir que outro poll não está nesta conta: pula.
    logger.warn({ channelAccountId: conta.id, err: err instanceof Error ? err.message : String(err) }, "[email] trava indisponível");
  }
  if (!travou) return { resultado: "travada", processados: 0 };

  try {
    return await lerConta(conta, { ...cfg, imapHost: cfg.imapHost }, agora);
  } catch (err) {
    logger.error({ channelAccountId: conta.id, err: err instanceof Error ? err.message : String(err) }, "[email] falha no poll da conta");
    return { resultado: "falha_rede", processados: 0 };
  } finally {
    await redisEstado()
      .eval(SOLTAR_SE_MINHA, 1, chaveTrava(conta.id), token)
      .catch(() => {}); // expira sozinha em 10 min
  }
}

/**
 * Varre a INBOX de TODAS as contas de e-mail conectadas (cross-team via
 * basePrisma) e grava respostas e bounces. Chamado periodicamente pelo worker
 * primário. Best-effort: uma conta que falha não derruba as outras.
 */
export async function pollAllEmailInboxes(opts: { agora?: Date; teamIds?: string[] } = {}): Promise<{
  accounts: number;
  processed: number;
  porResultado: Partial<Record<ResultadoConta, number>>;
}> {
  const agora = opts.agora ?? new Date();
  const filtroDeTime = opts.teamIds ? { in: opts.teamIds } : {};
  const contas = await basePrisma.channelAccount.findMany({
    // `teamIds`: limita a varredura (testes na base compartilhada, operação pontual).
    // `gmail_api` (envio pelo Gmail) nunca cai no IMAP: não tem senha nem servidor IMAP.
    // `not`, e não uma lista, para não tirar da leitura nenhum provedor antigo.
    where: { canal: "email", status: "connected", provider: { not: "gmail_api" }, ...(Object.keys(filtroDeTime).length ? { teamId: filtroDeTime } : {}) },
    select: { id: true, teamId: true, label: true, credentials: true, meta: true, createdAt: true },
  });
  let processed = 0;
  const porResultado: Partial<Record<ResultadoConta, number>> = {};
  const fila = [...contas];
  await Promise.all(
    Array.from({ length: Math.min(CONCORRENCIA, fila.length) }, async () => {
      for (let conta = fila.shift(); conta; conta = fila.shift()) {
        const r = await pollConta(conta, agora);
        processed += r.processados;
        porResultado[r.resultado] = (porResultado[r.resultado] ?? 0) + 1;
      }
    }),
  );
  return { accounts: contas.length, processed, porResultado };
}
