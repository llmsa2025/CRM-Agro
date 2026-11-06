import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Token do gatilho Webhook de fluxo (auditoria S5, item 0.6; em hash desde 10/2026).
 *
 * O token é o segredo da URL pública `/api/webhooks/flow/<token>`. Quem o tem injeta contato no CRM e
 * dispara mensagem, então ele recebe o mesmo trato dos outros tokens do projeto (convite, reset de
 * senha, relay da extensão): o banco guarda só o HASH e o texto puro aparece UMA vez, na tela, no
 * momento em que é gerado.
 *
 * Regras:
 * - o token é do SERVIDOR (24 bytes aleatórios, base64url, 192 bits). Nada que venha do cliente vira
 *   token (antes o editor propunha um UUID e o servidor aceitava);
 * - só `regenerateWebhookToken` gera e troca o token. Editar, salvar, ativar e pausar o fluxo nunca
 *   mexem nele. Trocar invalida o anterior na hora;
 * - o lookup é por `Flow.webhookTokenHash` (índice único), nunca pelo texto;
 * - hash = sha256 hex PURO, sem pepper: o token tem 192 bits (122 nos antigos, que eram UUID do
 *   navegador), então não existe ataque de dicionário a evitar, e o pepper só se justifica para dado
 *   de pouca entropia (como o CPF, ver `db/src/crypto.ts`). É o mesmo padrão de convite, reset e
 *   relay (`tokenHash`), e deixa o backfill da migration ser SQL puro (`sha256()` do Postgres), sem
 *   segredo dentro do SQL.
 */

export const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

/** Token novo: 24 bytes aleatórios (32 caracteres base64url, 192 bits). */
export function gerarWebhookToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * sha256 hex do token. É o que o banco guarda e o que entra na chave do limite de requisições.
 * Igual a `encode(sha256(convert_to("webhookToken", 'UTF8')), 'hex')` do Postgres (a migration usa esse SQL).
 */
export function hashDoWebhookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Formato plausível de token na URL (filtra lixo antes de ir ao banco). */
export function tokenDeUrlValido(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

/** Compara dois hashes em tempo constante (o que veio do banco contra o calculado do token apresentado). */
export function hashesDoWebhookIguais(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Chave do limite de requisições por token (`rateLimit`). Usa o HASH, nunca o token: a chave vai para o
 * Redis (`rl:<chave>:<janela>`), para o mapa em memória e, com o Redis fora, para o log de aviso.
 */
export function chaveDoLimiteDoWebhook(token: string): string {
  // O token é cortado antes de virar hash só para um texto enorme não custar CPU.
  return `flowhook:t:${hashDoWebhookToken(token.slice(0, 256)).slice(0, 32)}`;
}

/**
 * Chave `FLOW_WEBHOOK_TOKEN_HASH` (lida a cada chamada, como `FLOW_JANELA_ENVIO`).
 * - `on`: só o hash fica no banco; o texto puro aparece uma vez, ao gerar;
 * - ausente ou qualquer outro valor (padrão): o hash é gravado SEMPRE, e o texto puro também (e o
 *   espelho em `triggerConfig.webhookToken`), como era antes. É o que permite voltar a versão do app
 *   sem derrubar as URLs que já circulam. Ligar e desligar nunca invalida URL, porque o lookup é
 *   sempre pelo hash.
 */
export function webhookSoGravaHash(): boolean {
  return (process.env.FLOW_WEBHOOK_TOKEN_HASH ?? "").trim().toLowerCase() === "on";
}

/** O que gravar em `Flow` quando um token novo nasce (a única porta de escrita do token). */
export function dadosDoTokenNovo(token: string, agora: Date = new Date()) {
  return {
    webhookTokenHash: hashDoWebhookToken(token),
    webhookTokenGeradoEm: agora,
    webhookToken: webhookSoGravaHash() ? null : token,
  };
}

/** Fluxo sem o token do webhook: no lugar vêm `webhookTem` e `webhookGeradoEm`, que não revelam nada. */
export type FluxoSemSegredo<T> = Omit<T, "webhookToken" | "webhookTokenHash" | "webhookTokenGeradoEm"> & {
  webhookTem: boolean;
  webhookGeradoEm: Date | null;
};

/** Tira só o espelho do token de um `triggerConfig` (para os DTOs e para quem copiar um fluxo). */
export function triggerConfigSemToken<T>(cfg: T): T {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return cfg;
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== "webhookToken")) as T;
}

/**
 * Tira do fluxo tudo o que dá acesso à URL do webhook: `webhookToken`, `webhookTokenHash` e o espelho
 * `triggerConfig.webhookToken`. Resposta de API, retorno de serviço e qualquer DTO passam por aqui. Não
 * altera o objeto de entrada.
 */
export function tirarSegredosDoFluxo<
  T extends { triggerConfig?: unknown; webhookToken?: string | null; webhookTokenHash?: string | null; webhookTokenGeradoEm?: Date | null },
>(flow: T): FluxoSemSegredo<T> {
  const { webhookToken, webhookTokenHash, webhookTokenGeradoEm, ...resto } = flow;
  return {
    ...resto,
    triggerConfig: triggerConfigSemToken(resto.triggerConfig),
    webhookTem: Boolean(webhookToken || webhookTokenHash),
    webhookGeradoEm: webhookTokenGeradoEm ?? null,
  } as unknown as FluxoSemSegredo<T>;
}
