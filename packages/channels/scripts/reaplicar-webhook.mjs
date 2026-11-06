#!/usr/bin/env node
/**
 * Reaplica o webhook da Evolution em TODAS as instâncias (item 1.6): as
 * instâncias criadas antes assinam só MESSAGES_UPSERT/MESSAGES_UPDATE e não
 * avisam quando caem (CONNECTION_UPDATE) nem mandam QR novo (QRCODE_UPDATED).
 *
 * Item 3.7 (S18): o token sai da URL e vai no header `x-webhook-token`, um por
 * instância — HMAC-SHA256(WHATSAPP_WEBHOOK_TOKEN, "wa-webhook:" + instância),
 * a MESMA fórmula de `tokenDoWebhookDaInstancia` (core/integrations/
 * whatsapp-webhook-token.ts). Rodar DEPOIS do deploy da rota nova; conferido o
 * inbound, desligar o formato antigo com WHATSAPP_WEBHOOK_LEGADO=off.
 *
 * Uso (produção):
 *   cd /srv/crmagro
 *   pnpm exec dotenv -e .env -- node packages/channels/scripts/reaplicar-webhook.mjs            # só lista
 *   pnpm exec dotenv -e .env -- node packages/channels/scripts/reaplicar-webhook.mjs --aplicar  # reaplica
 *
 * Usa EVOLUTION_API_URL, EVOLUTION_API_KEY, APP_PUBLIC_URL e WHATSAPP_WEBHOOK_TOKEN.
 */
import { createHmac } from "node:crypto";

const aplicar = process.argv.includes("--aplicar");
const api = (process.env.EVOLUTION_API_URL ?? "").replace(/\/$/, "");
const key = process.env.EVOLUTION_API_KEY ?? "";
const publico = (process.env.APP_PUBLIC_URL ?? "").replace(/\/$/, "");
const token = process.env.WHATSAPP_WEBHOOK_TOKEN ?? "";
if (!api || !key || !publico) {
  console.error("Faltam EVOLUTION_API_URL, EVOLUTION_API_KEY ou APP_PUBLIC_URL no ambiente.");
  process.exit(1);
}
// Sem token na URL: ela aparece nos logs do Caddy e na config de cada instância.
const url = `${publico}/api/webhooks/whatsapp`;
const tokenDaInstancia = (nome) => createHmac("sha256", token).update(`wa-webhook:${nome}`).digest("hex");
if (!token) console.warn("Sem WHATSAPP_WEBHOOK_TOKEN: o webhook vai sem token (só serve em dev).");
const EVENTS = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"];

const res = await fetch(`${api}/instance/fetchInstances`, { headers: { apikey: key }, signal: AbortSignal.timeout(15000) });
if (!res.ok) {
  console.error(`fetchInstances ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const lista = await res.json();
const nomes = (Array.isArray(lista) ? lista : [])
  .map((i) => i?.name ?? i?.instance?.instanceName ?? i?.instanceName)
  .filter(Boolean);
console.log(`${nomes.length} instância(s): ${nomes.join(", ")}`);
if (!aplicar) {
  console.log("Só listei. Rode com --aplicar para reaplicar o webhook com:", EVENTS.join(", "));
  process.exit(0);
}
for (const nome of nomes) {
  const r = await fetch(`${api}/webhook/set/${encodeURIComponent(nome)}`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url,
        ...(token ? { headers: { "x-webhook-token": tokenDaInstancia(nome) } } : {}),
        webhookByEvents: false,
        base64: false,
        events: EVENTS,
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  console.log(`${nome}: ${r.ok ? "ok" : `falhou ${r.status} ${await r.text()}`}`);
}
