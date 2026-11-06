import { z } from "zod";
import { evolutionHeaders, describeFetchError, evolutionFetch } from "./http";

/**
 * Verifica se uma instância da Evolution API existe e está conectada (QR lido),
 * chamando `GET {apiUrl}/instance/connectionState/{instance}` → resposta leve
 * `{ instance: { instanceName, state } }`. (Antes usávamos `fetchInstances`, que
 * retorna TODAS as instâncias num formato flat e nunca casava o estado — bug do
 * "Aguardando scan…" eterno.)
 *
 * Usado no polling do "Conectar conta" (detecta o "open") e no confirm (valida
 * antes de salvar a ChannelAccount). Não envia mensagem; só lê.
 */
export type EvolutionVerifyResult = {
  ok: boolean;
  state: string | null; // "open" | "close" | "connecting" | ...
  number: string | null; // JID conectado, se disponível
  error?: string;
};

const instanceSchema = z
  .object({
    instance: z
      .object({
        instanceName: z.string().optional(),
        state: z.string().optional(),
        // alguns payloads trazem o número conectado aqui
        wuid: z.string().optional(),
        number: z.string().optional(),
      })
      .passthrough()
      .optional(),
    // variantes de versão da Evolution
    status: z.string().optional(),
    connectionStatus: z.string().optional(),
  })
  .passthrough();

export async function verifyEvolutionInstance(input: {
  apiUrl: string;
  apiKey: string;
  instance: string;
}): Promise<EvolutionVerifyResult> {
  const { apiUrl, apiKey, instance } = input;
  const url = `${apiUrl.replace(/\/$/, "")}/instance/connectionState/${encodeURIComponent(instance)}`;
  try {
    // Timeout (INT-15): o health check e a verificação periódica chamam isto.
    const res = await evolutionFetch(
      url,
      {
        headers: evolutionHeaders(apiKey),
        // cache: false — sempre valida ao vivo
        cache: "no-store",
      },
      8_000,
      "Evolution connectionState",
    );
    if (res.status === 404) {
      return { ok: false, state: null, number: null, error: "instância não encontrada na Evolution API" };
    }
    if (!res.ok) {
      return { ok: false, state: null, number: null, error: `Evolution API ${res.status}: ${await res.text()}` };
    }
    const body = (await res.json()) as unknown;
    const arr = Array.isArray(body) ? body : [body];
    const parsed = arr
      .map((x) => instanceSchema.safeParse(x))
      .map((r) => (r.success ? r.data : null))
      .find((d) => d?.instance?.instanceName === instance || arr.length === 1);

    if (!parsed) {
      return { ok: false, state: null, number: null, error: "instância não encontrada no retorno da Evolution" };
    }
    const state = parsed.instance?.state ?? parsed.status ?? parsed.connectionStatus ?? null;
    const number = parsed.instance?.wuid ?? parsed.instance?.number ?? null;
    return { ok: state === "open", state, number };
  } catch (e) {
    return { ok: false, state: null, number: null, error: describeFetchError(e, apiUrl) };
  }
}
