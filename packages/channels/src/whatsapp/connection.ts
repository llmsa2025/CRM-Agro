import { z } from "zod";

/**
 * Eventos de CONEXÃO da Evolution (item 1.6 — INT-04/INT-19):
 * - `connection.update` → `{ instance, state }` ("open" | "connecting" | "close");
 * - `qrcode.updated` → `{ instance, qrBase64 }` (QR novo durante a conexão).
 *
 * `null` quando o corpo não é um desses eventos (o webhook segue para os
 * parsers de mensagem/recibo).
 */

const conexaoSchema = z
  .object({
    event: z.string(),
    instance: z.string().optional(),
    data: z
      .object({
        instance: z.string().optional(),
        state: z.string().optional(),
        statusReason: z.union([z.number(), z.string()]).optional(),
        qrcode: z.object({ base64: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const normalizarEvento = (e: string) => e.toLowerCase().replace(/_/g, ".");

export type EventoDeConexao =
  | { tipo: "conexao"; instance: string; state: string; motivo: string | null }
  | { tipo: "qr"; instance: string; qrBase64: string };

export function parseEvolutionConnectionEvent(body: unknown): EventoDeConexao | null {
  const r = conexaoSchema.safeParse(body);
  if (!r.success) return null;
  const evento = normalizarEvento(r.data.event);
  const instance = r.data.instance ?? r.data.data?.instance;
  if (!instance) return null;
  if (evento === "connection.update" && r.data.data?.state) {
    const motivo = r.data.data.statusReason;
    return { tipo: "conexao", instance, state: r.data.data.state, motivo: motivo === undefined ? null : String(motivo) };
  }
  if (evento === "qrcode.updated" && r.data.data?.qrcode?.base64) {
    const b64 = r.data.data.qrcode.base64;
    return { tipo: "qr", instance, qrBase64: b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}` };
  }
  return null;
}
