import type { CallProvider, MakeCallResult } from "../types";
import {
  voopiWebhookSchema,
  voopiConfigSchema,
  type VoopiConfig,
  type VoopiWebhookEvent,
} from "./schema";

/** Teto de cada chamada à API da Voopi (INT-15). */
const VOOPI_TIMEOUT_MS = 15_000;

/**
 * Provider Voopi (tronco SIP) — click-to-call para o discador progressivo.
 *
 * Implementa `CallProvider` (o "similar" ao `Channel` para voz — ver types.ts).
 * O motor de fluxos / discador chama `makeCall`/`hangup`, nunca a API da Voopi
 * direto. Trocar de tronco SIP é escrever outro `CallProvider`.
 *
 * Originação: NÃO enviamos um SIP INVITE cru do Node (exigiria stack SIP/UPD,
 * inviável no serverless e desnecessário — a Voopi faz o INVITE do lado dela).
 * Pedimos à API REST de click-to-call da Voopi que oportunidades o INVITE no
 * tronco `sip.voopi.com.br`. O SIP URI do ramal (ex.: `sip:user@sip.voopi.com.br
 * :5060`) é construído da config e enviado como `from` no pedido.
 *
 * Eventos de ciclo de vida (call.answered / call.ended / call.recording) chegam
 * por webhook → `parseWebhook` normaliza com zod. A publicação no redis-bus e a
 * atualização da Call no banco ficam no endpoint do app (apps/web/.../voopi),
 * NÃO aqui — mesmo padrão do WhatsApp: `parseEvolutionInbound` (channels) só
 * normaliza; `receiveInbound`/`applyStatusUpdate` (core) gravam + publicam.
 * Mantém channels sem depender de core (evita ciclo: core → channels).
 *
 * IMPORTANTE — verificar endpoints/payload contra a doc da Voopi ao plugar a
 * primeira instância real (paths aqui são razoáveis mas NÃO validados contra o
 * sandbox da Voopi). Mesmo espírito do `EvolutionProvider.sendPresence`.
 */
export class VoopiProvider implements CallProvider {
  constructor(private config: VoopiConfig) {
    // Validação defensiva no boot: falha cedo se config veio sem shape (a borda
    // de UI já valida, mas o provider pode ser montado direto em testes/seed).
    voopiConfigSchema.parse(config);
  }

  /**
   * Base da API REST de click-to-call. Derivada do `sipHost` trocando o prefixo
   * `sip.` por `api.` (tronco `sip.voopi.com.br` → API `api.voopi.com.br`), com
   * fallback pra `https://${sipHost}` se o host não seguir a convenção `sip.*`.
   */
  apiBase(): string {
    const host = this.config.sipHost.replace(/^sip\./, "api.");
    return `https://${host}`;
  }

  /**
   * SIP URI do ramal/tronco (ex.: `sip:user@sip.voopi.com.br:5060`). Usada como
   * `from` no click-to-call — a Voopi origina o INVITE partindo deste ramal.
   */
  sipUri(from?: string): string {
    const user = (from ?? this.config.sipUser).replace(/^\+/, "");
    return `sip:${user}@${this.config.sipHost}:${this.config.sipPort}`;
  }

  /** Basic Auth com a conta do tronco (mesma identidade do SIP). */
  private authHeader(): string {
    const token = Buffer.from(`${this.config.sipUser}:${this.config.sipPassword}`).toString("base64");
    return `Basic ${token}`;
  }

  /**
   * Origina uma chamada click-to-call: POST {apiBase}/api/v1/click-to-call com
   * Basic Auth, body `{ from: sipUri, to, callbackUrl }`. A Voopi faz o SIP
   * INVITE no tronco e devolve o `providerCallId`, que liga a row Call (campo
   * `providerCallId`) ao leg remoto — base do webhook de realimentação.
   *
   * `to` deve vir em E.164 (mesma convenção do restante da plataforma); a API da
   * Voopi aceita o número discável. `from` opcional sobrescreve o ramal SIP.
   */
  async makeCall({ to, from }: { to: string; from?: string }): Promise<MakeCallResult> {
    const body: Record<string, string> = { from: this.sipUri(from), to: to.replace(/^\+/, "") };
    if (this.config.webhookUrl) body.callbackUrl = this.config.webhookUrl;

    const res = await fetch(`${this.apiBase()}/api/v1/click-to-call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader(),
      },
      body: JSON.stringify(body),
      // cache: false — originação é Sensível a cada clique, nunca cacheável.
      cache: "no-store",
      // INT-15: Voopi travada não segura a tela de ligações.
      signal: AbortSignal.timeout(VOOPI_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Voopi makeCall failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    // A Voopi pode devolver `callId`, `id` ou `call_id` — toleramos as variantes.
    const providerCallId =
      (typeof data.callId === "string" && data.callId) ||
      (typeof data.id === "string" && data.id) ||
      (typeof data.call_id === "string" && data.call_id) ||
      null;
    if (!providerCallId) {
      throw new Error(
        `Voopi makeCall: sem providerCallId na resposta (status ${res.status}).`,
      );
    }
    return { providerCallId };
  }

  /**
   * Termina a chamada: DELETE {apiBase}/api/v1/calls/{callId} com Basic Auth.
   * Best-effort: a chamada pode já ter caído (404 é tratado como sucesso — o
   * efeito desejado, "chamada encerrada", já foi atingido).
   */
  async hangup(callId: string): Promise<void> {
    const res = await fetch(`${this.apiBase()}/api/v1/calls/${encodeURIComponent(callId)}`, {
      method: "DELETE",
      headers: { Authorization: this.authHeader() },
      cache: "no-store",
      signal: AbortSignal.timeout(VOOPI_TIMEOUT_MS),
    });
    if (res.ok || res.status === 404) return;
    throw new Error(`Voopi hangup failed (${res.status}): ${await res.text()}`);
  }

  /**
   * Normaliza o payload do webhook da Voopi num `VoopiWebhookEvent` validado
   * (zod com passthrough — extrai só o que importa, tolera campos extra).
   * Descarta itens que não casam o contrato (igual ao `parseEvolutionInbound`;
   * o endpoint decide se loga).
   *
   * STATIC de propósito: o endpoint (apps/web) valida o POST ANTES de ter (ou
   * precisar de) uma config/instância Voopi — só zod na borda. O provider é quem
   * "conhece" o contrato do seu próprio webhook; expô-lo aqui (sem depender de
   * config) mantém o parse perto do domínio e reutilizável pelo endpoint.
   *
   * Quando a Voopi envia múltiplos eventos num único POST (batch), o array vem
   * em `data` — nesse caso devolvo um evento por item. Caso contrário, trato o
   * body inteiro como um evento único.
   */
  static parseWebhook(body: unknown): VoopiWebhookEvent[] {
    const targets = Array.isArray((body as { data?: unknown[] })?.data)
      ? (body as { data: unknown[] }).data
      : [body];
    const events: VoopiWebhookEvent[] = [];
    for (const item of targets) {
      const parsed = voopiWebhookSchema.safeParse(item);
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  }
}
