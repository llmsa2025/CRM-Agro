/** Interface comum de canal — §6/§7 da arquitetura. Trocar Baileys por Cloud API é trocar de provider. */
export type MessageContent = {
  text: string;
  // Campos de EMAIL (ignorados por canais de mensagem como WhatsApp). `subject`
  // é o assunto; `html` é o corpo HTML (se ausente, usa `text`).
  subject?: string;
  html?: string;
  // Convite de calendário (.ics/VEVENT). Vira um icalEvent no e-mail → cai no
  // Google/Outlook do destinatário com aceitar/recusar.
  icsEvent?: string;
  // Thread do e-mail (item 3.4): a resposta entra na mesma conversa no cliente
  // do lead. `inReplyTo` = Message-ID respondido; `references` = a cadeia.
  inReplyTo?: string;
  references?: string[];
};

export type SendInput = { to: string; content: MessageContent };

export type SendOutput = { providerMessageId: string };

/** Redes sociais via automação de navegador (não-oficial). */
export type SocialNetwork = "instagram" | "linkedin";
export type BrowserProxy = { server: string; username?: string; password?: string };

/** Tipos de mídia enviável (espelha MessageType, menos `text`). */
export type MediaType = "image" | "audio" | "doc";

/**
 * Envio de mídia. `base64` é o conteúdo do arquivo em base64 RAW (sem prefixo
 * `data:`). Enviamos os bytes direto pro provider em vez de uma URL — assim a
 * Evolution não precisa ir buscar o arquivo em outro servidor (mais rápido e um
 * ponto de falha a menos). `caption` é a legenda; `fileName` nomeia o documento.
 */
export type SendMediaInput = {
  to: string;
  base64: string;
  type: MediaType;
  mime: string;
  caption?: string;
  fileName?: string;
};

/** Presença "digitando"/"gravando" — controle de ritmo, humaniza a cadência. */
export type PresenceKind = "composing" | "recording" | "paused";

export type PresenceInput = {
  to: string;
  presence: PresenceKind;
  /** Por quanto tempo exibir, em ms. O provider decide como aplica. */
  durationMs: number;
};

export interface Channel {
  send(input: SendInput): Promise<SendOutput>;
  /**
   * Sinaliza presença (ex.: "digitando") antes de enviar. Opcional: nem todo
   * provider suporta (a Cloud API oficial, por exemplo, não expõe isso). Quem
   * chama deve tratar como best-effort — presença nunca deve quebrar um envio.
   */
  sendPresence?(input: PresenceInput): Promise<void>;
  /**
   * Envia mídia (imagem/áudio/documento). Opcional: nem todo provider suporta.
   * Quem chama trata a ausência/falha como best-effort (a mensagem ainda é
   * persistida e exibida na plataforma mesmo se o envio ao WhatsApp falhar).
   */
  sendMedia?(input: SendMediaInput): Promise<SendOutput>;
  // eventos de entrada chegam por webhook → normalizados (parseEvolutionInbound) → receiveInbound
}

/**
 * Interface de canal de VOZ (telefonia) — o "similar" ao `Channel` para
 * click-to-call/ligação (AGENTS.md §6/§7 recomendam "interface Channel (ou
 * similar)"). A `Channel` é messaging (`send` de texto); voz tem um contrato
 * distinto: `makeCall` origina uma chamada e devolve o id no provider, `hangup`
 * a termina. Assim o discador progressivo e um futuro nó `ai_agent` de ligação
 * chamam a abstração, nunca a API do tronco — trocar Voopi por outro SIP trunk
 * é escrever outro `CallProvider`.
 *
 * Eventos de ciclo de vida (atendeu/terminou/gravação) não vêm por polling: a
 * platform chama o webhook configurado, que valida (zod) e realimenta a Call.
 */
export type MakeCallResult = { providerCallId: string };

export interface CallProvider {
  /** Origina uma chamada (click-to-call). `from` opcional sobrescreve o ramal. */
  makeCall(input: { to: string; from?: string }): Promise<MakeCallResult>;
  /** Termina uma chamada em andamento pelo id devolvido por `makeCall`. */
  hangup(callId: string): Promise<void>;
}

/** Mensagem de entrada normalizada (independente do provider). */
export type InboundMessage = {
  from: string; // E.164
  fromMe: boolean;
  text: string | null; // texto ou legenda (null quando é só mídia, ex.: áudio)
  /**
   * Mídia recebida (imagem/áudio/documento). Os BYTES não vêm no webhook —
   * `providerMessageId` é usado depois para buscar o base64 na Evolution
   * (fetchEvolutionMediaBase64). null = mensagem de texto puro.
   */
  media?: {
    kind: MediaType;
    mime: string;
    fileName: string | null;
    /** Tamanho em bytes (`fileLength` do webhook), quando vem — decide se baixa (INT-14). */
    size?: number | null;
  } | null;
  providerMessageId: string | null;
  /** jid original do webhook (`…@s.whatsapp.net` ou `…@lid`) — chave do download de mídia. */
  remoteJid?: string | null;
  /** Hora da mensagem no WhatsApp, em SEGUNDOS desde 1970 (null = desconhecida). */
  timestamp: number | null;
  name: string | null; // pushName do remetente
  instance: string | null; // nome da instância do provider (p/ resolver a ChannelAccount)
};
