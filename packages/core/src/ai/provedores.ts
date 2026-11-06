import { getAiApiKey } from "../integrations/service";
import { logger } from "../logger/index";

/**
 * Provedores de IA do time e a CHAMADA com fallback (item 3.5, INT-24).
 *
 * Antes cada chamador resolvia "o 1º conectado" e, no primeiro HTTP ≠ 2xx,
 * desistia — um 529 da Anthropic virava erro para o usuário (ou fallback no
 * fluxo) mesmo com o GLM conectado. Agora a lista de candidatos vem em ordem de
 * preferência e, em 429/5xx/timeout/erro de rede, a chamada passa para o
 * próximo. Erro 4xx do próprio pedido (400, 401…) NÃO troca de provedor: o
 * pedido está errado, não o provedor.
 *
 * Os dois falam o formato Messages da Anthropic (o z.ai expõe endpoint
 * compatível), então o mesmo corpo serve para ambos — só muda base e modelo.
 */

export type ProvedorIa = "anthropic" | "glm";

export const PROVIDER_BASE: Record<ProvedorIa, string> = {
  anthropic: "https://api.anthropic.com",
  glm: "https://api.z.ai/api/anthropic",
};
export const DEFAULT_MODEL: Record<ProvedorIa, string> = {
  anthropic: "claude-sonnet-4-5",
  glm: "glm-4.6",
};
const ORDEM_PADRAO: ProvedorIa[] = ["anthropic", "glm"];

export type CandidatoIa = { provider: ProvedorIa; apiKey: string; model: string };

/** Falha da IA depois de esgotar os candidatos (ou erro não recuperável). */
export class IaChamadaFalhou extends Error {
  constructor(
    message: string,
    /** Algum provedor chegou a responder 429/5xx/timeout (vale tentar mais tarde). */
    readonly transitorio: boolean,
  ) {
    super(message);
    this.name = "IaChamadaFalhou";
  }
}

/**
 * Candidatos conectados, na ordem de tentativa.
 * - Com `pedido`: ele primeiro (com o `modelo` pedido) e depois os outros
 *   conectados, com o modelo padrão de cada um. Pedido NÃO conectado → lista
 *   vazia (quem escolheu um provedor não pode acabar em outro sem saber).
 * - Sem `pedido`: todos os conectados (anthropic antes de glm); o `modelo`, se
 *   vier, vale só para o primeiro.
 */
export async function provedoresConectados(pedido?: ProvedorIa, modelo?: string): Promise<CandidatoIa[]> {
  const ordem = pedido ? [pedido, ...ORDEM_PADRAO.filter((p) => p !== pedido)] : ORDEM_PADRAO;
  const out: CandidatoIa[] = [];
  for (const p of ordem) {
    const apiKey = await getAiApiKey(p);
    if (!apiKey) {
      if (p === pedido) return [];
      continue;
    }
    out.push({ provider: p, apiKey, model: out.length === 0 && modelo ? modelo : DEFAULT_MODEL[p] });
  }
  return out;
}

/** Status que justificam tentar o próximo provedor. */
function ehTransitorio(status: number): boolean {
  return status === 429 || status >= 500;
}

export type RespostaIa = {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason?: string;
};

/**
 * Faz UMA chamada `/v1/messages` com fallback entre os candidatos, a partir de
 * `inicio` (o loop do agente continua no provedor que respondeu por último).
 * `sinal` é o prazo/cancelamento do chamador: abortou → propaga na hora, sem
 * tentar o próximo. Devolve a resposta e o índice do candidato usado.
 */
export async function chamarIa(
  candidatos: CandidatoIa[],
  corpo: Record<string, unknown>,
  opts: { timeoutMs: number; sinal?: AbortSignal; inicio?: number },
): Promise<{ data: RespostaIa; usado: number }> {
  const falhas: string[] = [];
  for (let i = opts.inicio ?? 0; i < candidatos.length; i++) {
    const c = candidatos[i]!;
    const sinais = [AbortSignal.timeout(opts.timeoutMs)];
    if (opts.sinal) sinais.push(opts.sinal);
    let res: Response;
    try {
      res = await fetch(`${PROVIDER_BASE[c.provider]}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": c.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ ...corpo, model: c.model }),
        signal: AbortSignal.any(sinais),
      });
    } catch (e) {
      // Prazo/cancelamento do chamador: não é culpa do provedor — para aqui.
      if (opts.sinal?.aborted) throw e;
      falhas.push(`${c.provider}: ${e instanceof Error ? e.message : String(e)}`);
      logger.warn({ provider: c.provider }, "[ia] provedor sem resposta — tentando o próximo");
      continue;
    }
    if (res.ok) return { data: (await res.json()) as RespostaIa, usado: i };

    const body = await res.text().catch(() => "");
    if (!ehTransitorio(res.status)) {
      throw new IaChamadaFalhou(`IA (${c.provider}) falhou: HTTP ${res.status} ${body.slice(0, 300)}`, false);
    }
    falhas.push(`${c.provider}: HTTP ${res.status}`);
    logger.warn({ provider: c.provider, status: res.status }, "[ia] provedor indisponível — tentando o próximo");
  }
  throw new IaChamadaFalhou(
    falhas.length ? `IA indisponível (${falhas.join("; ")})` : "IA sem provedor conectado",
    falhas.length > 0,
  );
}

/** Junta os blocos de texto de uma resposta. */
export function textoDaResposta(data: RespostaIa): string {
  return (data.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!.trim())
    .join("\n")
    .trim();
}
