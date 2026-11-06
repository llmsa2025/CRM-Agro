import { env } from "@crmagro/config";
import type { Channel, SendInput, SendOutput, PresenceInput, SendMediaInput } from "../types";
import { evolutionHeaders, evolutionFetch, exigirOk, EVOLUTION_TIMEOUT_MS } from "./http";

/**
 * Provider WhatsApp via Evolution API (Baileys, não-oficial).
 * Implementa a interface Channel — o motor de fluxos e o service de conversas
 * chamam `send`, nunca a API da Evolution direto. Trocar pra Cloud API oficial
 * depois é escrever outro provider implementando a mesma interface.
 */
export class EvolutionProvider implements Channel {
  constructor(
    private instance: string = env.EVOLUTION_INSTANCE,
    private apiUrl: string = env.EVOLUTION_API_URL,
    private apiKey: string = env.EVOLUTION_API_KEY,
  ) {}

  async send({ to, content }: SendInput): Promise<SendOutput> {
    const number = to.replace(/^\+/, ""); // Evolution quer sem o "+"
    // Timeout + erro classificado (item 1.2): o motor sabe se a mensagem saiu.
    const res = await evolutionFetch(
      `${this.apiUrl}/message/sendText/${this.instance}`,
      {
        method: "POST",
        headers: evolutionHeaders(this.apiKey, { "Content-Type": "application/json" }),
        // Com link, pede o cartão de prévia (capa e título do vídeo) ao WhatsApp.
        body: JSON.stringify({ number, text: content.text, ...(/https?:\/\//i.test(content.text) ? { linkPreview: true } : {}) }),
      },
      EVOLUTION_TIMEOUT_MS.send,
      "Evolution sendText",
    );
    await exigirOk(res, "Evolution sendText");
    // 2xx = saiu. Corpo ilegível não pode virar "falha" (reenviaria).
    const data = (await res.json().catch(() => ({}))) as { key?: { id?: string } };
    return { providerMessageId: data.key?.id ?? "" };
  }

  /**
   * Envia mídia via Evolution: POST /message/sendMedia/{instance} com
   * { number, mediatype, mimetype, media (URL), caption, fileName }. A Evolution
   * busca a URL (usamos a assinada do Supabase Storage) — sem base64 no corpo.
   * Áudio de voz tem endpoint próprio na Evolution; aqui tratamos áudio como
   * mídia comum (suficiente pro MVP; PTT fica pra depois).
   */
  async sendMedia({ to, base64, type, mime, caption, fileName }: SendMediaInput): Promise<SendOutput> {
    const number = to.replace(/^\+/, "");

    // Áudio = nota de voz (PTT): endpoint dedicado. A Evolution transcodifica
    // pro opus/ogg do WhatsApp (webm gravado no navegador não tocaria como voz
    // se enviado por sendMedia comum).
    if (type === "audio") {
      const res = await evolutionFetch(
        `${this.apiUrl}/message/sendWhatsAppAudio/${this.instance}`,
        {
          method: "POST",
          headers: evolutionHeaders(this.apiKey, { "Content-Type": "application/json" }),
          body: JSON.stringify({ number, audio: base64 }),
        },
        EVOLUTION_TIMEOUT_MS.media,
        "Evolution sendWhatsAppAudio",
      );
      await exigirOk(res, "Evolution sendWhatsAppAudio");
      const data = (await res.json().catch(() => ({}))) as { key?: { id?: string } };
      return { providerMessageId: data.key?.id ?? "" };
    }

    const mediatype = type === "doc" ? "document" : type; // image | document
    // `media` recebe o base64 RAW direto — a Evolution não busca URL externa.
    const res = await evolutionFetch(
      `${this.apiUrl}/message/sendMedia/${this.instance}`,
      {
        method: "POST",
        headers: evolutionHeaders(this.apiKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({ number, mediatype, mimetype: mime, media: base64, caption, fileName }),
      },
      EVOLUTION_TIMEOUT_MS.media,
      "Evolution sendMedia",
    );
    await exigirOk(res, "Evolution sendMedia");
    const data = (await res.json().catch(() => ({}))) as { key?: { id?: string } };
    return { providerMessageId: data.key?.id ?? "" };
  }

  /**
   * Envia presença "digitando" via Evolution: POST /chat/sendPresence/{instance}
   * com { number, delay, presence }. `delay` (ms) é quanto a Evolution mantém a
   * presença. Best-effort: qualquer erro só é logado; nunca propaga — presença
   * não pode derrubar o envio da mensagem que vem depois.
   *
   * NOTA: o contrato exato do endpoint depende da versão da Evolution e ainda
   * não foi testado contra a instância viva (nenhum WhatsApp conectado no
   * momento). Validar ao reconectar por QR.
   */
  async sendPresence({ to, presence, durationMs }: PresenceInput): Promise<void> {
    const number = to.replace(/^\+/, "");
    // O WhatsApp expira o "digitando" sozinho em ~10s se ninguém renovar. Uma
    // única chamada de 30s fazia o indicador sumir no meio e a mensagem só
    // chegar bem depois — o oposto de parecer humano. Renovamos em blocos.
    //
    // A chamada da Evolution BLOQUEIA por `delay` ms (ela dorme no servidor),
    // então o laço já se ritma sozinho e consome o tempo real de parede — quem
    // chama não deve agendar atraso adicional (ver executor, nó `typing`).
    const BLOCO_MS = 8_000;
    let restante = Math.max(0, Math.round(durationMs));
    do {
      const delay = Math.min(BLOCO_MS, restante) || BLOCO_MS;
      try {
        const res = await evolutionFetch(
          `${this.apiUrl}/chat/sendPresence/${this.instance}`,
          {
            method: "POST",
            headers: evolutionHeaders(this.apiKey, { "Content-Type": "application/json" }),
            body: JSON.stringify({ number, delay, presence }),
          },
          delay + EVOLUTION_TIMEOUT_MS.presence, // a Evolution dorme `delay` ms antes de responder
          "Evolution sendPresence",
        );
        if (!res.ok) {
           
          console.warn(`[evolution] sendPresence ${res.status}: ${await res.text()}`);
          return; // não insiste num endpoint que está recusando
        }
      } catch (e) {
         
        console.warn("[evolution] sendPresence falhou (ignorado):", e instanceof Error ? e.message : e);
        return;
      }
      restante -= delay;
    } while (restante > 0);
  }
}
