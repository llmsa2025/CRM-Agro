import type { AiProvider } from "./schema";

/**
 * Teste da chave de API dos provedores de IA, com o MOTIVO quando falha. Antes qualquer falha virava
 * "o teste de conexão falhou" e não dava para saber se a chave estava errada, se faltava permissão ou
 * se o servidor não alcançava o provedor.
 *
 * Nunca devolve nem registra a chave: só o motivo (um código curto).
 */

export type MotivoDaChave =
  | "ok"
  /** Não parece uma chave deste provedor (prefixo errado). Nem chama o provedor. */
  | "formato"
  /** Token do Claude Code (`sk-ant-oat...`), que não funciona como chave de API. */
  | "token_oauth"
  /** Espaço ou quebra de linha no meio da chave (colou duas vezes, ou pegou a linha de baixo). */
  | "espaco"
  /** 401: o provedor não reconhece a chave (errada, cortada ou apagada no painel). */
  | "recusada"
  /** 403: a chave existe, mas sem acesso. */
  | "sem_acesso"
  /** 429: limite de chamadas. */
  | "limite"
  /** 5xx: o provedor está com problema. */
  | "indisponivel"
  /** Sem resposta (rede do servidor, DNS ou tempo esgotado). */
  | "rede";

const TIMEOUT_MS = 10_000;

/** O que se confere ANTES de chamar o provedor (barato, sem rede). `null` = parece uma chave válida. */
export function conferirFormatoDaChave(provider: AiProvider, apiKey: string): Exclude<MotivoDaChave, "ok" | "recusada" | "sem_acesso" | "limite" | "indisponivel" | "rede"> | null {
  if (/\s/.test(apiKey)) return "espaco";
  if (provider === "anthropic") {
    if (apiKey.startsWith("sk-ant-oat")) return "token_oauth";
    if (!apiKey.startsWith("sk-ant-")) return "formato";
  }
  if (provider === "openai" && !apiKey.startsWith("sk-")) return "formato";
  return null;
}

/** Status HTTP da listagem de modelos → motivo. */
export function motivoDoStatus(status: number): MotivoDaChave {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "recusada";
  if (status === 403) return "sem_acesso";
  if (status === 429) return "limite";
  if (status >= 500) return "indisponivel";
  // 400, 404 e o resto: o provedor não aceitou o pedido com esta chave.
  return "recusada";
}

/**
 * Testa a chave com uma chamada barata de listagem de modelos (sem gastar tokens). O `fetch` entra por
 * parâmetro só para o teste (o padrão é o do Node).
 */
export async function diagnosticarChaveDeIa(
  provider: AiProvider,
  apiKey: string,
  chamar: typeof fetch = fetch,
): Promise<{ ok: boolean; motivo: MotivoDaChave }> {
  const formato = conferirFormatoDaChave(provider, apiKey);
  // Espaço no meio e token do Claude Code nunca funcionam: nem chama o provedor. Prefixo diferente do usual
  // ("formato") ainda é testado de verdade (pode ser uma chave de gateway), e só explica o 401.
  if (formato === "espaco" || formato === "token_oauth") return { ok: false, motivo: formato };
  const sinal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res =
      provider === "openai"
        ? await chamar("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` }, signal: sinal })
        : await chamar(`${provider === "glm" ? "https://api.z.ai/api/anthropic" : "https://api.anthropic.com"}/v1/models`, {
            // anthropic e glm (z.ai): endpoint compatível com o da Anthropic.
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            signal: sinal,
          });
    const motivo = motivoDoStatus(res.status);
    if (motivo === "recusada" && formato === "formato") return { ok: false, motivo: "formato" };
    return { ok: motivo === "ok", motivo };
  } catch {
    return { ok: false, motivo: "rede" };
  }
}
