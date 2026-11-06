import { z } from "zod";
import { normalizePhone } from "../phone";
import type { InboundMessage } from "../types";

/**
 * Normaliza o payload do webhook da Evolution API (evento messages.upsert) num
 * InboundMessage provider-agnostic. zod com passthrough — só extrai o que
 * importa, ignora o resto.
 *
 * INT-17: antes, vários tipos viravam "vazio" e sumiam em silêncio — documento
 * com legenda mandado pelo celular, mensagem temporária, visualização única,
 * localização, cartão de contato, figurinha. A resposta do lead não aparecia e
 * o "respondeu?" do fluxo ficava falso. Agora os envelopes são desembrulhados
 * e os tipos sem texto viram um texto curto ("[localização] …").
 */
const messageSchema = z
  .object({
    conversation: z.string().optional(),
    extendedTextMessage: z.object({ text: z.string().optional() }).passthrough().optional(),
    imageMessage: z.object({ caption: z.string().optional(), mimetype: z.string().optional() }).passthrough().optional(),
    videoMessage: z.object({ caption: z.string().optional(), mimetype: z.string().optional() }).passthrough().optional(),
    // Vídeo "bolinha" (recado de vídeo): mesma estrutura do videoMessage.
    ptvMessage: z.object({ mimetype: z.string().optional() }).passthrough().optional(),
    audioMessage: z.object({ mimetype: z.string().optional() }).passthrough().optional(),
    documentMessage: z
      .object({ caption: z.string().optional(), mimetype: z.string().optional(), fileName: z.string().optional() })
      .passthrough()
      .optional(),
    locationMessage: z
      .object({
        degreesLatitude: z.number().optional(),
        degreesLongitude: z.number().optional(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
    liveLocationMessage: z
      .object({ degreesLatitude: z.number().optional(), degreesLongitude: z.number().optional() })
      .passthrough()
      .optional(),
    contactMessage: z.object({ displayName: z.string().optional() }).passthrough().optional(),
    contactsArrayMessage: z
      .object({ contacts: z.array(z.object({ displayName: z.string().optional() }).passthrough()).optional() })
      .passthrough()
      .optional(),
    stickerMessage: z.object({}).passthrough().optional(),
    buttonsResponseMessage: z.object({ selectedDisplayText: z.string().optional() }).passthrough().optional(),
    listResponseMessage: z.object({ title: z.string().optional() }).passthrough().optional(),
    templateButtonReplyMessage: z.object({ selectedDisplayText: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

/** Envelopes do WhatsApp que carregam a mensagem de verdade em `.message`. */
const ENVELOPES = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
] as const;

/** Tira os envelopes (até 4 níveis) e devolve a mensagem de dentro. */
export function desembrulharMensagem(m: unknown): unknown {
  let atual = m;
  for (let nivel = 0; nivel < 4; nivel++) {
    if (!atual || typeof atual !== "object") return atual;
    const obj = atual as Record<string, unknown>;
    const env = ENVELOPES.map((k) => obj[k]).find((v) => v && typeof v === "object") as
      | { message?: unknown }
      | undefined;
    if (!env?.message) return atual;
    const interno = env.message as Record<string, unknown>;
    // Edição: o texto novo vem em protocolMessage.editedMessage.
    const editado = (interno.protocolMessage as { editedMessage?: unknown } | undefined)?.editedMessage;
    atual = editado ?? interno;
  }
  return atual;
}

/** Nome do tipo principal da mensagem (para log de descarte). */
export function tipoDaMensagemEvolution(body: unknown): string {
  const data = (body as { data?: { message?: unknown } } | null)?.data;
  const m = desembrulharMensagem(data?.message);
  if (!m || typeof m !== "object") return "sem_message";
  const chaves = Object.keys(m).filter((k) => k !== "messageContextInfo");
  return chaves[0] ?? "vazio";
}

const payloadSchema = z
  .object({
    event: z.string().optional(),
    instance: z.string().optional(),
    data: z
      .object({
        key: z
          .object({
            remoteJid: z.string().optional(),
            // @lid (id anônimo do WhatsApp): o número real vem num destes.
            remoteJidAlt: z.string().optional(),
            senderPn: z.string().optional(),
            fromMe: z.boolean().optional(),
            id: z.string().optional(),
          })
          .passthrough(),
        message: z.unknown().optional(),
        // Segundos, texto ou Long do protobuf ({ low, high }) conforme a versão.
        // `unknown` de propósito: um formato estranho aqui não pode derrubar a
        // mensagem inteira — vira hora de chegada (ver segundosDoTimestamp).
        messageTimestamp: z.unknown().optional(),
        pushName: z.string().nullable().optional(),
        senderPn: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Número que chega como número, texto ou o Long do protobuf (`{ low, high }`,
 * quando a versão da Evolution não converte). Inválido → null.
 */
function numeroDoProtobuf(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v);
  else if (v && typeof v === "object" && typeof (v as { low?: unknown }).low === "number") {
    const { low, high } = v as { low: number; high?: number };
    n = (typeof high === "number" ? high : 0) * 2 ** 32 + (low >>> 0);
  } else return null;
  return Number.isFinite(n) ? n : null;
}

/** Antes disto (set/2001) não é hora de mensagem do WhatsApp: é lixo. */
const TS_MINIMO_S = 1_000_000_000;

/**
 * `messageTimestamp` da Evolution → SEGUNDOS desde 1970 (INT-16). Aceita número,
 * texto numérico e o Long do protobuf. Valor em MILISSEGUNDOS (> 10¹²) é
 * convertido. Inválido → null.
 */
export function segundosDoTimestamp(v: unknown): number | null {
  let n = numeroDoProtobuf(v);
  if (n === null) return null;
  if (n > 1e12) n = n / 1000; // veio em ms
  n = Math.floor(n);
  return n >= TS_MINIMO_S ? n : null;
}

/**
 * `fileLength` da mídia → bytes (mesmos formatos do timestamp). Desconhecido →
 * null (o download ainda tem o teto, lendo a resposta em pedaços — INT-14).
 */
export function bytesDoArquivo(v: unknown): number | null {
  const n = numeroDoProtobuf(v);
  return n !== null && n >= 0 ? Math.floor(n) : null;
}

/** Por que um webhook de mensagem não virou InboundMessage (log de descarte). */
export type MotivoDescarteEvolution =
  | "payload_invalido"
  | "sem_jid"
  | "grupo"
  | "nao_conversa"
  | "lid_sem_numero"
  | "numero_invalido";

function numeroDoJid(jid: string | undefined): string | null {
  if (!jid) return null;
  return normalizePhone(jid.replace(/@.+$/, "").replace(/:\d+$/, ""));
}

export function parseEvolutionInbound(body: unknown): InboundMessage | null {
  const r = analisarEvolutionInbound(body);
  return r.ok ? r.msg : null;
}

/**
 * Igual ao `parseEvolutionInbound`, mas diz POR QUE descartou — o webhook
 * registra o motivo (INT-17: nada some sem rastro).
 */
export function analisarEvolutionInbound(
  body: unknown,
  opts: { preservarLidHistorico?: boolean } = {},
): { ok: true; msg: InboundMessage } | { ok: false; motivo: MotivoDescarteEvolution } {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) return { ok: false, motivo: "payload_invalido" };

  const d = parsed.data.data;
  const jid = d.key?.remoteJid;
  if (!jid) return { ok: false, motivo: "sem_jid" };
  if (jid.endsWith("@g.us")) return { ok: false, motivo: "grupo" }; // grupos: ignorar por ora (Fase 3+)
  // Status (stories), listas de transmissão e canais não são conversa com um
  // número — e o id de um canal pode "parecer" telefone para o normalizePhone.
  if (/@(broadcast|newsletter)$/.test(jid)) return { ok: false, motivo: "nao_conversa" };

  // @lid não é telefone: usa o alternativo (remoteJidAlt / senderPn). Sem ele,
  // descarta — normalizar o id anônimo como número criaria um contato fantasma.
  const lid = jid.endsWith("@lid");
  const from = lid
    ? numeroDoJid(d.key.remoteJidAlt ?? d.key.senderPn ?? d.senderPn)
      ?? (opts.preservarLidHistorico && /^\d+@lid$/.test(jid) ? jid : null)
    : numeroDoJid(jid);
  if (!from) return { ok: false, motivo: lid ? "lid_sem_numero" : "numero_invalido" };

  const mm = messageSchema.safeParse(desembrulharMensagem(d.message) ?? {});
  const m = mm.success ? mm.data : undefined;

  const loc = m?.locationMessage ?? m?.liveLocationMessage;
  const localizacao =
    loc && loc.degreesLatitude !== undefined && loc.degreesLongitude !== undefined
      ? `[localização] ${loc.degreesLatitude},${loc.degreesLongitude}${
          m?.locationMessage?.name ? ` (${m.locationMessage.name})` : ""
        }`
      : null;
  const contatos = m?.contactsArrayMessage?.contacts?.map((c) => c.displayName).filter(Boolean) ?? [];
  const contato = m?.contactMessage
    ? `[contato] ${m.contactMessage.displayName ?? "sem nome"}`
    : contatos.length
      ? `[contatos] ${contatos.join(", ")}`
      : null;

  const text =
    m?.conversation ??
    m?.extendedTextMessage?.text ??
    m?.imageMessage?.caption ??
    m?.videoMessage?.caption ??
    m?.documentMessage?.caption ??
    m?.buttonsResponseMessage?.selectedDisplayText ??
    m?.listResponseMessage?.title ??
    m?.templateButtonReplyMessage?.selectedDisplayText ??
    localizacao ??
    contato ??
    (m?.stickerMessage ? "[figurinha]" : null) ??
    null;

  // Mídia: os bytes NÃO vêm no webhook — só os metadados. O download é feito
  // depois, no worker (baixarMidiaEvolution), usando o providerMessageId; o
  // `fileLength` decide antes se vale baixar (INT-14).
  // Vídeo não tem tipo próprio no schema; entra como "doc" (baixável).
  const im = m?.imageMessage;
  const am = m?.audioMessage;
  const dm = m?.documentMessage;
  const vm = m?.videoMessage ?? m?.ptvMessage;
  const media: InboundMessage["media"] = im
    ? { kind: "image", mime: im.mimetype ?? "image/jpeg", fileName: null, size: bytesDoArquivo(im.fileLength) }
    : am
      ? { kind: "audio", mime: am.mimetype ?? "audio/ogg", fileName: null, size: bytesDoArquivo(am.fileLength) }
      : dm
        ? {
            kind: "doc",
            mime: dm.mimetype ?? "application/octet-stream",
            fileName: dm.fileName ?? null,
            size: bytesDoArquivo(dm.fileLength),
          }
        : vm
          ? { kind: "doc", mime: vm.mimetype ?? "video/mp4", fileName: null, size: bytesDoArquivo(vm.fileLength) }
          : null;

  const fromMe = d.key?.fromMe === true;
  return {
    ok: true,
    msg: {
      from,
      fromMe,
      text,
      media,
      providerMessageId: d.key?.id ?? null,
      remoteJid: jid,
      timestamp: segundosDoTimestamp(d.messageTimestamp),
      // Na mensagem ENVIADA (fromMe) o pushName é o do PRÓPRIO dono da conta
      // (ou "Você"), nunca o da outra pessoa — gravá-lo punha o nome do dono em
      // todas as conversas que ele puxou pelo celular (bug de 28/09).
      name: fromMe ? null : (d.pushName ?? null),
      instance: parsed.data.instance ?? null,
    },
  };
}
