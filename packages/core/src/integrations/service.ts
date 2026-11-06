import type { Prisma } from "@prisma/client";
import { db, tenantData, encryptCredentials, decryptCredentials } from "@crmagro/db";
import {
  aiModeSchema,
  saveAiIntegrationSchema,
  type AiIntegrationDTO,
  type AiMode,
  type AiProvider,
  type SaveAiIntegrationInput,
} from "./schema";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { diagnosticarChaveDeIa, type MotivoDaChave } from "./chave-ia";

/**
 * Serviço de Integrações de IA (Fase 6). Guarda a chave de API de cada provedor
 * CIFRADA em `Integration.credentials` (AES-256-GCM via encryptCredentials) e a
 * governança (`aiMode`) no `TeamConfig`. Tudo tenant-scoped: `db()` eager, o
 * teamId vem do ALS. A chave em claro NUNCA sai daqui para a UI — só os serviços
 * server-side (o agente) chamam `getAiApiKey`.
 */

const PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  glm: "GLM (z.ai)",
};

/** Testa a chave (sem gastar tokens). Quem precisa do motivo usa `diagnosticarChaveDeIa`. */
export async function testAiKey(provider: AiProvider, apiKey: string): Promise<boolean> {
  return (await diagnosticarChaveDeIa(provider, apiKey)).ok;
}

/** Mascara a chave para exibição (só os 4 últimos). */
function maskKey(apiKey: string): string {
  const last = apiKey.slice(-4);
  return `••••${last}`;
}

/**
 * Conecta/atualiza um provedor de IA: testa a chave, cifra e faz upsert do
 * Integration (status connected/error conforme o teste). Retorna se conectou.
 */
export async function saveAiIntegration(input: SaveAiIntegrationInput): Promise<{ connected: boolean; motivo: MotivoDaChave }> {
  requireCan("integrations.manage");
  const { provider, apiKey } = saveAiIntegrationSchema.parse(input);
  const prisma = db();
  const { ok, motivo } = await diagnosticarChaveDeIa(provider, apiKey);
  // Só o provedor e o motivo vão para o log: nunca a chave.
  if (!ok) logger.warn({ provider, motivo }, "[ia] o teste da chave falhou");
  const credentials = encryptCredentials({ apiKey }) as unknown as Prisma.InputJsonValue;
  const status = ok ? "connected" : "error";

  const existing = await prisma.integration.findFirst({ where: { tipo: provider } });
  if (existing) {
    await prisma.integration.update({ where: { id: existing.id }, data: { credentials, status } });
  } else {
    await prisma.integration.create({
      data: tenantData<Prisma.IntegrationUncheckedCreateInput>({ tipo: provider, credentials, status }),
    });
  }
  return { connected: ok, motivo };
}

/** Remove a integração de IA de um provedor. */
export async function deleteAiIntegration(provider: AiProvider): Promise<void> {
  requireCan("integrations.manage");
  const prisma = db();
  await prisma.integration.deleteMany({ where: { tipo: provider } });
}

/**
 * Chave de API em CLARO de um provedor — SÓ para uso server-side (o agente).
 * Nunca deve ser exposta à UI. Null se não conectado.
 */
export async function getAiApiKey(provider: AiProvider): Promise<string | null> {
  const prisma = db();
  const row = await prisma.integration.findFirst({ where: { tipo: provider }, select: { credentials: true } });
  if (!row?.credentials) return null;
  const dec = decryptCredentials(row.credentials) as { apiKey?: string } | null;
  return dec?.apiKey ?? null;
}

/** Lista o estado dos 3 provedores de IA para a UI (mascarado, nunca a chave). */
export async function listAiIntegrations(): Promise<AiIntegrationDTO[]> {
  const prisma = db();
  const rows = await prisma.integration.findMany({
    where: { tipo: { in: ["anthropic", "openai", "glm"] } },
    select: { tipo: true, status: true, credentials: true, updatedAt: true },
  });
  const byProvider = new Map(rows.map((r) => [r.tipo as AiProvider, r]));
  return (["anthropic", "openai", "glm"] as AiProvider[]).map((provider) => {
    const row = byProvider.get(provider);
    let maskedKey: string | null = null;
    if (row?.credentials) {
      const dec = decryptCredentials(row.credentials) as { apiKey?: string } | null;
      if (dec?.apiKey) maskedKey = maskKey(dec.apiKey);
    }
    return {
      provider,
      connected: row?.status === "connected",
      status: row?.status ?? "disconnected",
      maskedKey,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });
}

/** Rótulo legível de um provedor. */
export function aiProviderLabel(provider: AiProvider): string {
  return PROVIDER_LABEL[provider];
}

// ─── Governança (TeamConfig.aiMode) ─────────────────────────────────────────

/** Modo de governança da IA do time (default "off"). */
export async function getAiMode(): Promise<AiMode> {
  const prisma = db();
  const cfg = await prisma.teamConfig.findFirst({ select: { aiMode: true } });
  const parsed = aiModeSchema.safeParse(cfg?.aiMode);
  return parsed.success ? parsed.data : "off";
}

/** Define o modo de governança da IA (upsert do TeamConfig do time). */
export async function setAiMode(mode: AiMode): Promise<void> {
  requireCan("integrations.manage");
  const m = aiModeSchema.parse(mode);
  const prisma = db();
  const existing = await prisma.teamConfig.findFirst({ select: { id: true } });
  if (existing) {
    await prisma.teamConfig.update({ where: { id: existing.id }, data: { aiMode: m } });
  } else {
    await prisma.teamConfig.create({ data: tenantData<Prisma.TeamConfigUncheckedCreateInput>({ aiMode: m }) });
  }
}
