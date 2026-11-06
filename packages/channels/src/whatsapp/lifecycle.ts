import { z } from "zod";
import { evolutionHeaders, describeFetchError, EVOLUTION_TIMEOUT_MS } from "./http";

/** Timeout de cada chamada de onboarding (INT-15): Evolution travada não segura a tela. */
const timeout = () => AbortSignal.timeout(EVOLUTION_TIMEOUT_MS.lifecycle);

/**
 * Ciclo de vida de instância Evolution (onboarding de WhatsApp).
 * - createEvolutionInstance: POST /instance/create
 * - getEvolutionQR: GET /instance/connect/{instance} → QR base64
 *
 * O fluxo "Nova conexão" cria a instância, busca o QR pro usuário escanear, e
 * quando o estado vira "open" (verifyEvolutionInstance) a conta é salva.
 */

export type EvolutionCreateResult = { ok: boolean; error?: string };

export async function createEvolutionInstance(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
}): Promise<EvolutionCreateResult> {
  const url = `${input.apiUrl.replace(/\/$/, "")}/instance/create`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: evolutionHeaders(input.apiKey, { "Content-Type": "application/json" }),
      // syncFullHistory: puxa histórico completo do aparelho ao conectar (fica
      // no Postgres da Evolution, não no CRM Agro) — habilita o check de "já
      // conversou fora da plataforma" pegar conversas antigas, não só recentes.
      body: JSON.stringify({
        instanceName: input.instance,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
        syncFullHistory: true,
      }),
      cache: "no-store",
      signal: timeout(),
    });
    // 409 = instância já existe (tudo bem pra reusar no fluxo de QR).
    if (res.status === 409) return { ok: true };
    if (!res.ok) {
      return { ok: false, error: `Evolution create ${res.status}: ${await res.text()}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeFetchError(e, input.apiUrl) };
  }
}

/**
 * Configura o webhook de entrada da instância (Evolution → app). Sem isso, as
 * mensagens recebidas nunca chegam no /conversas. Chamado ao criar a conexão.
 * `url` deve ser pública e SEM SSO (ex.: alias aberta do Vercel).
 */
export async function setEvolutionWebhook(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
  url: string;
  /** Headers que a Evolution manda em cada POST (token da instância — item 3.7, S18). */
  headers?: Record<string, string>;
}): Promise<{ ok: boolean; error?: string }> {
  const endpoint = `${input.apiUrl.replace(/\/$/, "")}/webhook/set/${encodeURIComponent(input.instance)}`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: evolutionHeaders(input.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: input.url,
          ...(input.headers ? { headers: input.headers } : {}),
          webhookByEvents: false,
          base64: false,
          // MESSAGES_UPSERT: mensagem nova (inbound).
          // MESSAGES_UPDATE: recibo de entrega/leitura E o código de erro do ack.
          //   Sem ele toda mensagem enviada fica parada em "sent" e o erro 463
          //   (NackCallerReachoutTimelocked — trava de alcance a frio) nunca
          //   chega até nós. É a única fonte real de saúde do número.
          // CONNECTION_UPDATE: a instância caiu/voltou (logout no celular,
          //   sessão do Baileys morta) — antes era invisível e cada envio falhava
          //   (item 1.6, INT-04). QRCODE_UPDATED: QR novo durante a (re)conexão,
          //   para a tela não ficar num QR vencido (INT-19).
          events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
        },
      }),
      cache: "no-store",
      signal: timeout(),
    });
    if (!res.ok) return { ok: false, error: `Evolution webhook set ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeFetchError(e, input.apiUrl) };
  }
}

/**
 * Remove uma instância da Evolution (limpeza de onboarding abandonado — o
 * usuário gerou o QR mas fechou sem escanear). Best-effort: faz logout antes
 * (instância conectada exige deslogar; a abandonada normalmente não está
 * conectada, então o logout pode falhar — toleramos). Trata 404 como sucesso
 * (já não existe).
 */
export async function deleteEvolutionInstance(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
}): Promise<{ ok: boolean; error?: string }> {
  const base = input.apiUrl.replace(/\/$/, "");
  const inst = encodeURIComponent(input.instance);
  try {
    await fetch(`${base}/instance/logout/${inst}`, {
      method: "DELETE",
      headers: evolutionHeaders(input.apiKey),
      cache: "no-store",
      signal: timeout(),
    }).catch(() => null);
    const res = await fetch(`${base}/instance/delete/${inst}`, {
      method: "DELETE",
      headers: evolutionHeaders(input.apiKey),
      cache: "no-store",
      signal: timeout(),
    });
    if (res.ok || res.status === 404) return { ok: true };
    return { ok: false, error: `Evolution delete ${res.status}: ${await res.text()}` };
  } catch (e) {
    return { ok: false, error: describeFetchError(e, input.apiUrl) };
  }
}

const connectSchema = z
  .object({
    base64: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    instance: z.string().nullable().optional(),
  })
  .passthrough();

export type EvolutionQRResult = {
  ok: boolean;
  qrBase64: string | null; // data URI pronta pra <img>
  state: string | null;
  error?: string;
};

export async function getEvolutionQR(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
}): Promise<EvolutionQRResult> {
  const url = `${input.apiUrl.replace(/\/$/, "")}/instance/connect/${encodeURIComponent(input.instance)}`;
  try {
    const res = await fetch(url, { headers: evolutionHeaders(input.apiKey), cache: "no-store", signal: timeout() });
    if (!res.ok) {
      return { ok: false, qrBase64: null, state: null, error: `Evolution connect ${res.status}: ${await res.text()}` };
    }
    const parsed = connectSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { ok: false, qrBase64: null, state: null, error: "payload do connect inválido" };
    }
    const b64 = parsed.data.base64 ?? null;
    const qrBase64 = b64 ? (b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`) : null;
    const state = parsed.data.state ?? parsed.data.status ?? null;
    // state "open" = já conectado (sem QR); "close"/"connecting" = aguardando scan.
    return { ok: true, qrBase64, state };
  } catch (e) {
    return { ok: false, qrBase64: null, state: null, error: describeFetchError(e, input.apiUrl) };
  }
}
