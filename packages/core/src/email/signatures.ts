import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { escopoCanal } from "../conversations/escopo";
import type { UsoDoEscopo } from "../tenancy/escopo";

/**
 * Assinaturas de e-mail POR CAIXA (ajuste do dono, 28/09): o dono pode ter 2
 * caixas, cada uma com as suas assinaturas e a sua PADRÃO (`isDefault` vale
 * dentro da caixa). Antes a assinatura era do time inteiro.
 *
 * - Quem vê/gerencia: as caixas do escopo da pessoa (F3, `escopoCanal`) — a
 *   assinatura segue a caixa, como as conversas. Gerenciar exige
 *   `integrations.manage` e a caixa no escopo de ESCRITA.
 * - `channelAccountId` nulo = assinatura antiga de time que ainda não tinha
 *   caixa (migration 20260928230000); a primeira caixa conectada a adota.
 * - No envio vale a assinatura da caixa QUE ENVIA (`assinaturaDoEnvio`).
 */

/** Valor do passo de fluxo "usar a assinatura padrão da caixa que enviar". */
export const ASSINATURA_PADRAO_DA_CAIXA = "padrao-da-caixa";

export type SignatureDTO = {
  id: string;
  nome: string;
  html: string;
  isDefault: boolean;
  /** Caixa de e-mail dona da assinatura (null = antiga, de time sem caixa). */
  channelAccountId: string | null;
  /** Nome da caixa — o seletor do fluxo lista as assinaturas de todas as caixas. */
  caixa: string | null;
};

/** A caixa de e-mail não existe no time ou está fora do escopo da pessoa. */
export class CaixaDeEmailNaoEncontrada extends Error {
  constructor() {
    super("Caixa de e-mail não encontrada.");
    this.name = "CaixaDeEmailNaoEncontrada";
  }
}

/** A assinatura não existe no time ou é de uma caixa fora do escopo da pessoa. */
export class AssinaturaNaoEncontrada extends Error {
  constructor() {
    super("Assinatura não encontrada.");
    this.name = "AssinaturaNaoEncontrada";
  }
}

const SELECT = {
  id: true,
  nome: true,
  html: true,
  isDefault: true,
  channelAccountId: true,
  channelAccount: { select: { label: true } },
} satisfies Prisma.EmailSignatureSelect;

type Linha = Prisma.EmailSignatureGetPayload<{ select: typeof SELECT }>;

function toDTO(r: Linha): SignatureDTO {
  return {
    id: r.id,
    nome: r.nome,
    html: r.html,
    isDefault: r.isDefault,
    channelAccountId: r.channelAccountId,
    caixa: r.channelAccount?.label ?? null,
  };
}

/** Assinaturas que a pessoa enxerga: as das caixas do escopo (e as antigas sem caixa). */
function escopoDaAssinatura(uso: UsoDoEscopo = {}): Prisma.EmailSignatureWhereInput {
  const canal = escopoCanal(uso);
  return Object.keys(canal).length ? { OR: [{ channelAccount: canal }, { channelAccountId: null }] } : {};
}

/** A caixa de e-mail em que a pessoa pode mexer (escopo de escrita), ou erro. */
async function caixaParaEditar(channelAccountId: string): Promise<string> {
  const caixa = await db().channelAccount.findFirst({
    where: { AND: [{ id: channelAccountId, canal: "email" }, escopoCanal({ escrita: true })] },
    select: { id: true },
  });
  if (!caixa) throw new CaixaDeEmailNaoEncontrada();
  return caixa.id;
}

/**
 * Assinaturas de UMA caixa (Canais → E-mail; escrever/responder no inbox) ou,
 * sem caixa, as de todas as caixas que a pessoa vê (seletor do passo de fluxo).
 */
export async function listSignatures(opts: { channelAccountId?: string } = {}): Promise<SignatureDTO[]> {
  const rows = await db().emailSignature.findMany({
    where: opts.channelAccountId
      ? { AND: [{ channelAccountId: opts.channelAccountId }, escopoDaAssinatura()] }
      : escopoDaAssinatura(),
    orderBy: [{ isDefault: "desc" }, { nome: "asc" }],
    select: SELECT,
  });
  return rows.map(toDTO);
}

export async function createSignature(input: {
  channelAccountId: string;
  nome: string;
  html: string;
  isDefault?: boolean;
}): Promise<SignatureDTO> {
  requireCan("integrations.manage");
  const prisma = db();
  const nome = input.nome.trim();
  if (!nome) throw new Error("nome da assinatura obrigatório");
  const channelAccountId = await caixaParaEditar(input.channelAccountId);
  // A primeira assinatura da caixa vira a padrão dela automaticamente.
  const total = await prisma.emailSignature.count({ where: { channelAccountId } });
  const isDefault = input.isDefault || total === 0;
  if (isDefault) {
    await prisma.emailSignature.updateMany({ where: { channelAccountId, isDefault: true }, data: { isDefault: false } });
  }
  const row = await prisma.emailSignature.create({
    data: tenantData<Prisma.EmailSignatureUncheckedCreateInput>({ channelAccountId, nome, html: input.html ?? "", isDefault }),
    select: SELECT,
  });
  return toDTO(row);
}

/** A assinatura em que a pessoa pode mexer (caixa no escopo de escrita), ou erro. */
async function assinaturaParaEditar(id: string) {
  const atual = await db().emailSignature.findFirst({
    where: { AND: [{ id }, escopoDaAssinatura({ escrita: true })] },
    select: { id: true, channelAccountId: true, isDefault: true },
  });
  if (!atual) throw new AssinaturaNaoEncontrada();
  return atual;
}

export async function updateSignature(
  id: string,
  input: { nome?: string; html?: string; isDefault?: boolean },
): Promise<SignatureDTO> {
  requireCan("integrations.manage");
  const prisma = db();
  const atual = await assinaturaParaEditar(id);
  // Padrão é uma por caixa: marcar esta desmarca a outra DA MESMA caixa.
  if (input.isDefault) {
    await prisma.emailSignature.updateMany({
      where: { channelAccountId: atual.channelAccountId, isDefault: true, NOT: { id } },
      data: { isDefault: false },
    });
  }
  const data: Prisma.EmailSignatureUncheckedUpdateInput = {};
  if (input.nome !== undefined) data.nome = input.nome.trim();
  if (input.html !== undefined) data.html = input.html;
  if (input.isDefault !== undefined) data.isDefault = input.isDefault;
  const row = await prisma.emailSignature.update({ where: { id }, data, select: SELECT });
  return toDTO(row);
}

export async function deleteSignature(id: string): Promise<void> {
  requireCan("integrations.manage");
  const prisma = db();
  const atual = await prisma.emailSignature.findFirst({
    where: { AND: [{ id }, escopoDaAssinatura({ escrita: true })] },
    select: { id: true, channelAccountId: true, isDefault: true },
  });
  if (!atual) return; // já não existe (ou não é da pessoa): nada a fazer
  await prisma.emailSignature.deleteMany({ where: { id } });
  // Apagou a padrão: a mais antiga que sobrou na caixa assume, para a caixa
  // não ficar sem padrão (o "padrão da caixa" do fluxo e o inbox usam).
  if (atual.isDefault) {
    const proxima = await prisma.emailSignature.findFirst({
      where: { channelAccountId: atual.channelAccountId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (proxima) await prisma.emailSignature.update({ where: { id: proxima.id }, data: { isDefault: true } });
  }
}

/**
 * HTML da assinatura de um envio pela caixa `channelAccountId` (a que ENVIA):
 * - sem `signatureId` → nenhuma (passo de fluxo "— nenhuma —");
 * - a escolhida, se for DESTA caixa (ou antiga, sem caixa);
 * - senão (de outra caixa, apagada ou `ASSINATURA_PADRAO_DA_CAIXA`) → a padrão
 *   da caixa que envia. Nunca sai a assinatura de outra caixa.
 * A caixa já foi conferida no escopo por quem envia (`sendEmail`).
 */
export async function assinaturaDoEnvio(signatureId: string | null | undefined, channelAccountId: string): Promise<string> {
  if (!signatureId) return "";
  const prisma = db();
  if (signatureId !== ASSINATURA_PADRAO_DA_CAIXA) {
    const escolhida = await prisma.emailSignature.findFirst({
      where: { id: signatureId },
      select: { html: true, channelAccountId: true },
    });
    if (escolhida && (escolhida.channelAccountId === channelAccountId || escolhida.channelAccountId === null)) {
      return escolhida.html;
    }
  }
  const padrao = await prisma.emailSignature.findFirst({
    where: { channelAccountId, isDefault: true },
    select: { html: true },
  });
  return padrao?.html ?? "";
}

/**
 * Assinaturas antigas sem caixa (time que não tinha e-mail na migration) passam
 * para a caixa recém-conectada — ninguém perde a assinatura que já tinha.
 */
export async function adotarAssinaturasSemCaixa(channelAccountId: string): Promise<void> {
  requireCan("integrations.manage");
  const prisma = db();
  const caixa = await caixaParaEditar(channelAccountId);
  await prisma.emailSignature.updateMany({ where: { channelAccountId: null }, data: { channelAccountId: caixa } });
}
