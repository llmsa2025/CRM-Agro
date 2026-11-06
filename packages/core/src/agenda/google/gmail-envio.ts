import type { Prisma } from "@prisma/client";
import { db, decryptCredentials, encryptCredentials, tenantData, type TenantPrismaClient } from "@crmagro/db";
import { escopoCanal } from "../../conversations/escopo";

/**
 * Envio pelo Gmail (E7): a caixa `gmail_api` que nasce em cima da conexão OAuth da
 * Agenda Google da pessoa. Este arquivo NÃO importa `conexao.ts` (é o `conexao.ts`
 * e o `auth/equipe.ts` que importam este), para não nascer import circular.
 *
 * A caixa guarda só `{ oauthConnectionId, user, from }`: o token NUNCA fica nela.
 * Quem envia (`resolveEmailProvider`, em email/service.ts) pede o access token à
 * conexão, que renova sob demanda. `user` e `from` valem também para o
 * encaminhamento (a ficha E3 confere o envelope por eles).
 */

/** `ChannelAccount.provider` da caixa que envia pela API do Gmail (`"gmail"` é SMTP com senha de app). */
export const PROVEDOR_GMAIL_API = "gmail_api";

/** `ChannelAccount.externalId`: uma caixa por conta Google (`sub`), única por provedor. */
export const externalIdDoGmail = (sub: string) => `gmail:${sub}`;

/** A mesma caixa já está conectada com senha de app: não há duas caixas do mesmo endereço. */
export class CaixaJaConectadaComSenha extends Error {
  constructor() {
    super("Esta caixa já está conectada com senha de app. Para enviar pelo Gmail sem senha, desconecte a caixa com senha primeiro.");
    this.name = "CaixaJaConectadaComSenha";
  }
}

/** Quem escreve: o client do time, a transação do time ou a do `basePrisma` (equipe), com teamId explícito. */
type TransacaoDoTime = Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0];
type ClienteDeCaixas = Pick<Prisma.TransactionClient, "channelAccount"> | TenantPrismaClient | TransacaoDoTime;

/**
 * Existe caixa conectada com SENHA (`smtp` ou `gmail`, os dois são SMTP) do mesmo
 * endereço, dentro do que a pessoa pode usar? Sem diferenciar maiúsculas.
 */
export async function caixaComSenhaDoMesmoEndereco(email: string): Promise<boolean> {
  const alvo = email.trim().toLowerCase();
  if (!alvo) return false;
  const caixas = await db().channelAccount.findMany({
    where: { AND: [{ canal: "email", provider: { in: ["smtp", "gmail"] } }, escopoCanal({ escrita: true })] },
    select: { credentials: true },
  });
  return caixas.some((c) => ((decryptCredentials(c.credentials) as { user?: string } | null)?.user ?? "").trim().toLowerCase() === alvo);
}

function credenciaisDaCaixa(conexaoId: string, email: string): Prisma.InputJsonValue {
  return encryptCredentials({ oauthConnectionId: conexaoId, user: email, from: email }) as unknown as Prisma.InputJsonValue;
}

/**
 * Cria (ou reconecta) a caixa `gmail_api` da pessoa, na volta do Google com `r=gmail`.
 * `upsert` pela chave única (`gmail_api`, `gmail:<sub>`).
 *
 * NÃO chama `adotarAssinaturasSemCaixa`, como o SMTP faz ao criar: ela exige
 * `integrations.manage` (administrador) e quem conecta o Gmail é membro.
 *
 * No `update`, o `oauthConnectionId` muda (desconectar e conectar de novo cria outra
 * conexão) e o dono passa a ser quem acabou de provar que é dono da conta Google. O
 * nome fica. (Sem isto, uma caixa que ficou órfã e mudou de dono na exclusão de uma
 * pessoa passaria a enviar pela conta Google de outra.)
 */
export async function conectarContaGmailApi(p: { ownerId: string; conexaoId: string; sub: string; email: string }): Promise<{ id: string }> {
  const prisma = db();
  const credentials = credenciaisDaCaixa(p.conexaoId, p.email);
  const externalId = externalIdDoGmail(p.sub);
  return prisma.channelAccount.upsert({
    where: { provider_externalId: { provider: PROVEDOR_GMAIL_API, externalId } },
    create: tenantData<Prisma.ChannelAccountUncheckedCreateInput>({
      canal: "email",
      provider: PROVEDOR_GMAIL_API,
      externalId,
      ownerId: p.ownerId,
      label: p.email,
      status: "connected",
      credentials,
    }),
    update: { status: "connected", credentials, ownerId: p.ownerId },
    select: { id: true },
  });
}

/**
 * Volta da Agenda (`r=agenda`): SÓ religa ou desliga a caixa `gmail_api` que já existe,
 * nunca cria (e nunca recusa). Com `include_granted_scopes`, toda reconexão da Agenda
 * devolve o `gmail.send` de novo, inclusive a de depois de um `invalid_grant`.
 * - `comEnvio`: a caixa da pessoa volta a `connected`, com o `oauthConnectionId` atual;
 * - sem `comEnvio` (a pessoa desmarcou a permissão do Gmail): vira `disconnected`.
 * Caixa apagada não renasce. O filtro por dono impede que a volta de uma pessoa
 * religue a caixa de outra (a que ficou órfã depois de uma exclusão).
 */
export async function religarContaGmailApi(p: { ownerId: string; conexaoId: string; sub: string; email: string; comEnvio: boolean }): Promise<void> {
  const where = { provider: PROVEDOR_GMAIL_API, externalId: externalIdDoGmail(p.sub), ownerId: p.ownerId };
  await db().channelAccount.updateMany({
    where,
    data: p.comEnvio ? { status: "connected", credentials: credenciaisDaCaixa(p.conexaoId, p.email) } : { status: "disconnected" },
  });
}

/**
 * Desliga a caixa `gmail_api` de cada conexão que está saindo (ou que o Google
 * recusou): `disconnected` ao desconectar, desativar ou excluir; `error` quando o
 * Google recusa o token (`marcarReautorizacao`). Vai na MESMA transação que guarda a
 * revogação, para não sobrar caixa "conectada" sem conexão. Sem o `teamId` na lista
 * de cada item o `where` não casa com nada (fail-closed).
 */
export async function desligarContasGmail(
  cliente: ClienteDeCaixas,
  lista: { teamId: string; externalAccountId: string }[],
  status: "disconnected" | "error",
): Promise<void> {
  // O client do time e a transação do basePrisma aceitam a mesma chamada (teamId explícito).
  const tx = cliente as Pick<Prisma.TransactionClient, "channelAccount">;
  for (const c of lista) {
    await tx.channelAccount.updateMany({
      where: { teamId: c.teamId, canal: "email", provider: PROVEDOR_GMAIL_API, externalId: externalIdDoGmail(c.externalAccountId) },
      data: { status },
    });
  }
}
