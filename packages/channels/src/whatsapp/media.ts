import { env } from "@crmagro/config";
import { evolutionHeaders, EVOLUTION_TIMEOUT_MS } from "./http";

/**
 * Teto da mídia RECEBIDA que baixamos e guardamos (INT-14). Acima disso a
 * mensagem entra sem o arquivo, com o aviso "veja no celular": um vídeo de
 * 300 MB mandado pelo lead virava ~400 MB de base64 + cópias na memória e
 * derrubava o processo.
 */
export const MAX_MIDIA_RECEBIDA_BYTES = 16 * 1024 * 1024; // 16 MB

/**
 * Downloads de mídia ao mesmo tempo por processo (o inbound roda com 4).
 *
 * Conta de memória (refazer antes de subir este número): um download no teto
 * de 16 MB junta ~21 MB de resposta em pedaços, a string do `toString("utf8")`,
 * o objeto do `JSON.parse` (outra string de ~21 MB) e os 16 MB decodificados —
 * ~80–100 MB de pico cada. Com 2, ~200 MB além do normal do worker, abaixo do
 * `max_memory_restart` de 600 MB do pm2 (`ecosystem.config.cjs`).
 */
const DOWNLOADS_SIMULTANEOS = 2;
let emAndamento = 0;
const esperando: Array<() => void> = [];

/** Limita os downloads simultâneos: uma rajada de vídeos não soma memória. */
async function comVaga<T>(fn: () => Promise<T>): Promise<T> {
  if (emAndamento < DOWNLOADS_SIMULTANEOS) emAndamento++;
  else await new Promise<void>((r) => esperando.push(r)); // a vaga vem direto de quem sai
  try {
    return await fn();
  } finally {
    const proximo = esperando.shift();
    if (proximo) proximo();
    else emAndamento--;
  }
}

/** O que `lerCorpoComLimite` precisa de quem lê: `Response` e `Request` servem. */
export type CorpoLegivel = { headers: Headers; body: ReadableStream<Uint8Array> | null };

/**
 * Lê o corpo em pedaços e PARA ao passar de `maxBytes` (não confia no
 * `content-length`, que pode faltar). `null` = passou do teto.
 */
export async function lerCorpoComLimite(res: CorpoLegivel, maxBytes: number): Promise<Buffer | null> {
  const declarado = Number(res.headers.get("content-length"));
  if (Number.isFinite(declarado) && declarado > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const leitor = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    partes.push(value);
  }
  return Buffer.concat(partes, total);
}

export type MidiaBaixada =
  | { ok: true; bytes: Buffer; mime: string }
  // grande: passou do teto · tempo: estourou o prazo (arquivo pesado ou
  // Evolution lenta) · falha: o resto (erro HTTP, Evolution fora, JSON ruim).
  | { ok: false; motivo: "grande" | "tempo" | "falha" };

/**
 * Baixa uma mídia recebida via Evolution API. O webhook de entrada só traz
 * metadados (tipo, mimetype, tamanho), não os bytes — eles vêm por
 * POST /chat/getBase64FromMediaMessage/{instance} com a chave da mensagem.
 *
 * Com teto (INT-14): a resposta é lida em pedaços e abandonada ao passar do
 * tamanho do base64 de `maxBytes`; timeout de 30 s (INT-15) cobrindo também a
 * leitura do corpo; no máximo 2 downloads por processo. Devolve o `Buffer`
 * direto (antes: base64 → Buffer → cópia em Uint8Array). Best-effort: nunca
 * lança — o inbound grava a mensagem como mídia sem arquivo.
 *
 * A chave vai como veio no webhook (`remoteJid` original, inclusive `@lid`, e
 * `fromMe`). A Evolution 2.3.x acha a mensagem só pelo `id` na base dela e usa
 * a chave GRAVADA lá para baixar, então a chave montada antes (número +
 * `fromMe: false`) funcionava; mandar a verdadeira evita depender disso.
 */
export async function baixarMidiaEvolution(
  input: {
    providerMessageId: string;
    from: string; // E.164 do remetente
    instance?: string | null;
    /** jid original do webhook (ex.: `…@lid`); sem ele, monta pelo número. */
    remoteJid?: string | null;
    /** Mensagem enviada pela própria conta (eco do celular). */
    fromMe?: boolean;
  },
  maxBytes = MAX_MIDIA_RECEBIDA_BYTES,
  timeoutMs: number = EVOLUTION_TIMEOUT_MS.media,
): Promise<MidiaBaixada> {
  const instance = input.instance || env.EVOLUTION_INSTANCE;
  const remoteJid = input.remoteJid || `${input.from.replace(/^\+/, "")}@s.whatsapp.net`;
  // base64 ocupa 4/3 do arquivo; a folga cobre o resto do JSON.
  const maxResposta = Math.ceil((maxBytes * 4) / 3) + 64 * 1024;
  return comVaga(async () => {
    // Prazo próprio (e não o do evolutionFetch) para saber, no catch, se o que
    // estourou foi o TEMPO — antes dos cabeçalhos ou no meio do corpo.
    const prazo = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(`${env.EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instance}`, {
        method: "POST",
        headers: evolutionHeaders(env.EVOLUTION_API_KEY, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          message: { key: { id: input.providerMessageId, remoteJid, fromMe: input.fromMe === true } },
          convertToMp4: false,
        }),
        signal: prazo,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, motivo: "falha" };
      }
      const corpo = await lerCorpoComLimite(res, maxResposta);
      if (!corpo) return { ok: false, motivo: "grande" };
      const data = JSON.parse(corpo.toString("utf8")) as { base64?: string; mimetype?: string };
      if (!data.base64) return { ok: false, motivo: "falha" };
      const bytes = Buffer.from(data.base64, "base64");
      if (bytes.length > maxBytes) return { ok: false, motivo: "grande" };
      return { ok: true, bytes, mime: data.mimetype || "application/octet-stream" };
    } catch {
      return { ok: false, motivo: prazo.aborted ? "tempo" : "falha" };
    }
  });
}
