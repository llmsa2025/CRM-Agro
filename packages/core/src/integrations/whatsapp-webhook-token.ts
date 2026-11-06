import crypto from "node:crypto";
import { env } from "@crmagro/config";

/**
 * Autenticação do webhook da Evolution (item 3.7, S18).
 *
 * Antes: UM segredo para todas as instâncias, em `?token=` — ia parar nos
 * access logs do Caddy e na config de cada instância; quem vazasse forjava
 * inbound e recibos (✓✓) de qualquer time, bastando saber o nome da instância.
 *
 * Agora:
 *  - token POR INSTÂNCIA, derivado do segredo global: HMAC-SHA256(segredo,
 *    "wa-webhook:" + instância) em hex. Não precisa guardar nada no banco, e o
 *    token de uma instância não serve para outra;
 *  - vai no HEADER `x-webhook-token` (Evolution `webhook.headers`), nunca na URL;
 *  - a rota confere contra a instância do PRÓPRIO payload.
 * Transição: a Evolution de produção ainda manda o segredo global na query.
 * Enquanto `WHATSAPP_WEBHOOK_LEGADO` não for "off", o segredo global (query ou
 * header) continua aceito. Depois de reaplicar o webhook em todas as instâncias
 * (`packages/channels/scripts/reaplicar-webhook.mjs --aplicar`), desligar.
 */

export const WEBHOOK_TOKEN_HEADER = "x-webhook-token";

/** Token do webhook de UMA instância (o script de reaplicar usa a mesma fórmula). */
export function tokenDoWebhookDaInstancia(instance: string, segredo: string): string {
  return crypto.createHmac("sha256", segredo).update(`wa-webhook:${instance}`).digest("hex");
}

function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export type AutenticacaoWebhook =
  | { ok: true; via: "instancia" | "legado" | "sem_token_dev" }
  | { ok: false; motivo: "sem_segredo_em_producao" | "token_invalido" };

export type EntradaWebhook = {
  /** `instance` do corpo do webhook (a Evolution sempre manda). */
  instance: string | null;
  /** Valor do header `x-webhook-token`. */
  header: string | null;
  /** `?token=` da URL (legado). */
  query: string | null;
};

/**
 * Decide se o POST veio da Evolution. `opts` só existe para o teste; em
 * produção vale o env (segredo, NODE_ENV e o interruptor do legado).
 */
export function autenticarWebhookWhatsApp(
  e: EntradaWebhook,
  opts: { segredo?: string | null; producao?: boolean; aceitarLegado?: boolean } = {},
): AutenticacaoWebhook {
  const segredo = opts.segredo !== undefined ? opts.segredo : env.WHATSAPP_WEBHOOK_TOKEN;
  const producao = opts.producao ?? env.NODE_ENV === "production";
  const aceitarLegado = opts.aceitarLegado ?? env.WHATSAPP_WEBHOOK_LEGADO !== "off";

  if (!segredo) {
    // Produção sem segredo: fail-closed (senão qualquer POST vira mensagem).
    return producao ? { ok: false, motivo: "sem_segredo_em_producao" } : { ok: true, via: "sem_token_dev" };
  }
  if (e.header && e.instance && iguais(e.header, tokenDoWebhookDaInstancia(e.instance, segredo))) {
    return { ok: true, via: "instancia" };
  }
  if (aceitarLegado && ((e.query && iguais(e.query, segredo)) || (e.header && iguais(e.header, segredo)))) {
    return { ok: true, via: "legado" };
  }
  return { ok: false, motivo: "token_invalido" };
}
