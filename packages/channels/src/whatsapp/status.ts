import { z } from "zod";

/**
 * Normaliza o evento `messages.update` da Evolution — recibo de entrega/leitura
 * e, principalmente, o CÓDIGO DE ERRO devolvido pelo servidor no ack.
 *
 * Por que importa: sem este evento toda mensagem enviada fica parada em "sent"
 * e não existe sinal nenhum de saúde do número. É aqui que chega o 463
 * (NackCallerReachoutTimelocked) — a trava do WhatsApp para envio a contato
 * frio, hoje a ÚNICA fonte real (vinda do servidor, não estimada) de que a
 * conta está sendo limitada.
 *
 * O Baileys emite `messages.update` com `status: ERROR` e o código em
 * `messageStubParameters` (ver messages-recv.js, tratamento de `attrs.error`).
 * A Evolution repassa esse shape com pequenas variações entre versões, então
 * lemos de forma tolerante e sem quebrar quando o formato mudar.
 */

/** Status normalizado, independente de provider. */
export type MessageStatusUpdate = {
  providerMessageId: string;
  /** null quando o provider mandou algo que não sabemos mapear. */
  status: "sent" | "delivered" | "read" | "failed" | null;
  /** Código de erro do servidor (ex.: "463"), quando houver. */
  errorCode: string | null;
  instance: string | null;
};

// A Evolution varia MUITO o shape entre versões: `data` ora é objeto, ora é
// array (o Baileys emite messages.update como array); o status vem em
// `data.status` ou aninhado em `data.update.status`; o id em `data.key.id` ou
// `data.keyId`. Lemos tudo de forma tolerante.
const updateItemSchema = z
  .object({
    key: z.object({ id: z.string().optional() }).passthrough().optional(),
    keyId: z.string().optional(),
    status: z.union([z.string(), z.number()]).optional(),
    update: z
      .object({ status: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .optional(),
    messageStubParameters: z.array(z.union([z.string(), z.number()])).optional(),
    error: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const updateSchema = z
  .object({
    event: z.string().optional(),
    instance: z.string().optional(),
    data: z.union([updateItemSchema, z.array(updateItemSchema)]),
  })
  .passthrough();

/**
 * Mapa de status. A Evolution manda ora string ("DELIVERY_ACK"), ora o número
 * do enum do protobuf do Baileys — cobrimos os dois.
 *
 * proto.WebMessageInfo.Status: 0 ERROR, 1 PENDING, 2 SERVER_ACK,
 * 3 DELIVERY_ACK, 4 READ, 5 PLAYED
 */
const STATUS_MAP: Record<string, MessageStatusUpdate["status"]> = {
  ERROR: "failed",
  PENDING: "sent",
  SERVER_ACK: "sent",
  DELIVERY_ACK: "delivered",
  READ: "read",
  PLAYED: "read",
  "0": "failed",
  "1": "sent",
  "2": "sent",
  "3": "delivered",
  "4": "read",
  "5": "read",
};

export function parseEvolutionStatusUpdate(body: unknown): MessageStatusUpdate | null {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return null;

  // Só nos interessa o evento de atualização — upsert é tratado noutro caminho.
  const ev = (parsed.data.event ?? "").toLowerCase().replace(/_/g, ".");
  if (ev && !ev.includes("messages.update")) return null;

  // `data` pode vir como array (Baileys) — pegamos o primeiro item com id.
  const items = Array.isArray(parsed.data.data) ? parsed.data.data : [parsed.data.data];
  const d = items.find((it) => it.key?.id ?? it.keyId) ?? items[0];
  if (!d) return null;
  const providerMessageId = d.key?.id ?? d.keyId ?? null;
  if (!providerMessageId) return null;

  // status em data.status OU aninhado em data.update.status.
  const rawStatusVal = d.status ?? d.update?.status;
  const rawStatus = rawStatusVal === undefined ? null : String(rawStatusVal).toUpperCase();
  const status = rawStatus ? (STATUS_MAP[rawStatus] ?? null) : null;

  // O código do erro vem em messageStubParameters (padrão Baileys) ou solto.
  const stub = d.messageStubParameters?.find((p) => /^\d{3}$/.test(String(p)));
  const errorCode = stub !== undefined ? String(stub) : d.error !== undefined ? String(d.error) : null;

  return {
    providerMessageId,
    // Código de erro presente implica falha, mesmo se o status vier ausente.
    status: errorCode ? "failed" : status,
    errorCode,
    instance: parsed.data.instance ?? null,
  };
}

/**
 * Significado dos códigos de ack conhecidos.
 *
 * Só o 463 tem origem confirmada (fonte: investigação do Baileys #2441 —
 * `NackCallerReachoutTimelocked` no WAWebCallCollection.NackErrorCode). Os
 * demais aparecem em relatos sem documentação oficial; ficam como "desconhecido"
 * de propósito, para não inventarmos significado.
 */
export const ACK_ERROR_MEANING: Record<string, { label: string; grave: boolean; explicacao: string }> = {
  "463": {
    label: "Trava de alcance a frio",
    grave: true,
    explicacao:
      "O WhatsApp recusou o envio por 'reach-out time-lock': o destinatário nunca interagiu com este número, então não há token de contato confiável. Reincidência indica conta restrita: reduza o volume e priorize quem já respondeu.",
  },
};

export function describeAckError(code: string | null) {
  if (!code) return null;
  return (
    ACK_ERROR_MEANING[code] ?? {
      label: `Erro ${code}`,
      grave: false,
      explicacao: "Código devolvido pelo servidor do WhatsApp sem significado documentado publicamente.",
    }
  );
}
