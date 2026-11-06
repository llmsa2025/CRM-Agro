import type { Prisma } from "@prisma/client";
import { env } from "@crmagro/config";
import { db, tenantData } from "@crmagro/db";
import { deleteEvolutionInstance } from "@crmagro/channels";
import { requireCan } from "../auth/authz";
import { invalidarStatusWhatsApp } from "../channels-limit/service";
import { createChannelAccountSchema, type CreateChannelAccountInput } from "../conversations/schema";
import { logger } from "../logger/index";
import { assertOwned } from "../tenancy/assert-owned";
import { donoPadrao } from "../tenancy/escopo";
import { z } from "zod";

/** Renomeia só o rótulo no CRM Agro; a identidade da instância fica estável. */
export async function renomearContaDeCanal(id: string, nome: string): Promise<void> {
  requireCan("integrations.manage");
  const prisma = db();
  const label = z.string().trim().min(1, "Informe um nome").max(100, "Use até 100 caracteres").parse(nome);
  await assertOwned("channelAccount", id);
  await prisma.channelAccount.update({ where: { id }, data: { label } });
  await invalidarStatusWhatsApp();
}

/**
 * Contas de canal: criar pelo caminho MANUAL e excluir (auditoria do #53).
 *
 * O caminho manual (`createChannelAccountAction`) aceitava `provider =
 * "evolution"` com o `apiUrl` e o nome da instância vindos do CLIENTE:
 * - a verificação ia para uma URL escolhida pelo admin do cliente (SSRF cego);
 * - bastava o servidor dele responder "open" para gravar `externalId` = nome de
 *   uma instância REAL da Evolution da plataforma sem conta no CRM Agro (conta
 *   apagada com a instância viva, legado sem `externalId`). A partir daí o time
 *   enviava e RECEBIA pelo número de outro time.
 *
 * Decisão: WhatsApp NÃO entra mais pelo caminho manual — só pelo onboarding do
 * QR (`whatsapp-onboarding.ts`), que cria a instância na Evolution do env, a
 * amarra ao time enquanto pendente e só então grava a conta. Nenhuma tela usa
 * o caminho manual para WhatsApp, e "aceitar instância pendente do time" aqui
 * seria só uma cópia do `confirmWhatsAppOnboarding`.
 */

/** WhatsApp (Evolution) só se conecta pelo QR do onboarding. */
export class WhatsAppSoPeloQr extends Error {
  constructor() {
    super('WhatsAppSoPeloQr: conecte o WhatsApp pelo QR em Integrações → Canais → "Conectar WhatsApp".');
    this.name = "WhatsAppSoPeloQr";
  }
}

/**
 * A Evolution não apagou a instância: a conta fica (tente de novo). A mensagem
 * é FIXA — o corpo cru da resposta da Evolution vai só para o log (auditoria
 * do #120).
 */
export class InstanciaNaoRemovida extends Error {
  constructor(readonly httpStatus: number | null) {
    const motivo = httpStatus ? `a Evolution recusou (HTTP ${httpStatus})` : "a Evolution não respondeu";
    super(`InstanciaNaoRemovida: não deu para desconectar o número (${motivo}). Tente de novo.`);
    this.name = "InstanciaNaoRemovida";
  }
}

/** Cria conta de canal pelo caminho manual (não WhatsApp). Admin. */
export async function criarContaDeCanal(input: CreateChannelAccountInput): Promise<{ id: string }> {
  requireCan("integrations.manage");
  const prisma = db();
  const { canal, label, provider, credentials } = createChannelAccountSchema.parse(input);
  if (canal === "whatsapp" || provider === "evolution") throw new WhatsAppSoPeloQr();
  const conta = await prisma.channelAccount.create({
    data: tenantData<Prisma.ChannelAccountUncheckedCreateInput>({
      canal,
      label,
      provider,
        ownerId: donoPadrao(), // F3: quem conectou (vê as conversas; + master/admin/"ver tudo")
      credentials: credentials as Prisma.InputJsonValue,
      status: "connected",
    }),
    select: { id: true },
  });
  return conta;
}

/**
 * Exclui uma conta do time. Conta Evolution: apaga ANTES a instância na
 * Evolution do env (a sessão do WhatsApp cai e o nome da instância deixa de
 * existir — ninguém mais a "reivindica"). Se a Evolution falhar, a conta fica
 * e o erro volta (404 = já não existia, segue).
 */
export async function excluirContaDeCanal(id: string): Promise<void> {
  requireCan("integrations.manage");
  const prisma = db();
  await assertOwned("channelAccount", id);
  const conta = await prisma.channelAccount.findUnique({
    where: { id },
    select: { provider: true, externalId: true, credentials: true },
  });
  if (!conta) return;
  if (conta.provider === "evolution") {
    const instance = conta.externalId ?? (conta.credentials as { instance?: string } | null)?.instance ?? null;
    if (instance) {
      const r = await deleteEvolutionInstance({ apiUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY, instance });
      if (!r.ok) {
        logger.warn({ accountId: id, instance, err: r.error }, "[canais] Evolution não apagou a instância — conta mantida");
        const status = /Evolution delete (\d{3})/.exec(r.error ?? "")?.[1];
        throw new InstanciaNaoRemovida(status ? Number(status) : null);
      }
      logger.info({ accountId: id, instance }, "[canais] instância da Evolution apagada junto com a conta");
    }
  }
  await prisma.channelAccount.delete({ where: { id } });
  await invalidarStatusWhatsApp();
}
