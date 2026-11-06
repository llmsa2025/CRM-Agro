import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db, getCurrentTeamId, TenantContextRequiredError } from "@crmagro/db";
import { normalizePhone } from "@crmagro/channels";
import { classificarProdutor, type ProdutorLabel } from "../produtor/classify";
import { temWhatsApp } from "../campaigns/tem-whatsapp";
import { requireCan } from "../auth/authz";
import { logger } from "../logger/index";
import { escopoRascunho } from "./escopo";

/**
 * Dados da fila de captação que as telas novas mostram (produto §H.2–H.6), todos
 * em `ProspectDraft.extra`:
 * - `temWhatsApp` (true/false/null): checagem SEM ENVIAR do A.4, feita pelo
 *   worker quando o lote termina;
 * - `produtorLabel`/`produtorScore`: classificador de produtor rural sobre os
 *   CNAEs/IEs do CNPJ (origem `cnpj`), na gravação do rascunho;
 * - `avaliacao`/`avaliacoes` (Maps) e `bio` (Instagram): vêm do extrator.
 */

// ─── Produtor rural (H.3) ───────────────────────────────────────────────────

/** O que o classificador lê do `CnpjResult` guardado em `extra` (zod na borda). */
const cnpjExtraSchema = z
  .object({
    cnae: z.string().nullish(),
    cnaesSecundarios: z.array(z.object({ codigo: z.string() }).passthrough()).nullish(),
    ies: z.array(z.object({ tipo: z.string().nullish(), habilitada: z.boolean().nullish() }).passthrough()).nullish(),
    razaoSocial: z.string().nullish(),
    nomeFantasia: z.string().nullish(),
    nomeSocio: z.string().nullish(),
  })
  .passthrough();

/**
 * Rótulo de produtor de um rascunho de CNPJ. `null` quando não há CNAE nenhum
 * (sem sinal, o classificador diria "não produtor" por falta de dado — melhor
 * não afirmar).
 */
export function produtorDoRascunho(extra: unknown): { produtorLabel: ProdutorLabel; produtorScore: number } | null {
  const r = cnpjExtraSchema.safeParse(extra);
  if (!r.success) return null;
  const e = r.data;
  const secundarios = (e.cnaesSecundarios ?? []).map((c) => c.codigo);
  if (!e.cnae && secundarios.length === 0) return null;
  const c = classificarProdutor({
    cnaePrincipal: e.cnae ?? null,
    cnaesSecundarios: secundarios,
    ies: (e.ies ?? []).map((i) => ({ tipo: i.tipo ?? null, habilitada: i.habilitada ?? false })),
    razaoSocial: e.razaoSocial ?? null,
    nomeFantasia: e.nomeFantasia ?? null,
    nomeSocio: e.nomeSocio ?? null,
  });
  return { produtorLabel: c.produtorLabel, produtorScore: c.produtorScore };
}

// ─── Tem WhatsApp? (H.2) ────────────────────────────────────────────────────

export type ResumoTemWhatsAppLote = { verificados: number; comWhatsApp: number; semWhatsApp: number; naoSei: number };

const temChave = (extra: unknown, chave: string) =>
  !!extra && typeof extra === "object" && !Array.isArray(extra) && chave in (extra as object);

/**
 * Marca `extra.temWhatsApp` nos rascunhos PENDENTES do lote que têm telefone e
 * ainda não foram checados. Roda no worker, no contexto do time (sistema), ao
 * fim da captura.
 *
 * Tudo passa por `temWhatsApp` (campanhas A.4): cache global primeiro, lotes de
 * 50 com pausa e teto diário POR CONTA — os mesmos da campanha, então a
 * captação não abre um segundo caminho de consulta. Só `/chat/whatsappNumbers`:
 * NUNCA envia mensagem. Conta = a WhatsApp conectada mais antiga do time; sem
 * ela, só o cache responde e o resto fica `null` ("não deu para saber").
 *
 * A gravação é um `UPDATE` por valor (true/false/null) que junta a chave ao
 * JSON existente, com `"teamId"` explícito (§12f). Escreve na fila e gasta a
 * cota diária de checagem da conta: exige `captacao.run` (o worker passa como
 * sistema; viewer, não).
 */
export async function marcarTemWhatsAppDoLote(lote: string): Promise<ResumoTemWhatsAppLote> {
  requireCan("captacao.run");
  const prisma = db();
  const teamId = getCurrentTeamId();
  if (!teamId) throw new TenantContextRequiredError("marcarTemWhatsAppDoLote", "ProspectDraft");
  const resumo: ResumoTemWhatsAppLote = { verificados: 0, comWhatsApp: 0, semWhatsApp: 0, naoSei: 0 };

  const rascunhos = await prisma.prospectDraft.findMany({
    where: { AND: [{ lote, status: "pendente", telefone: { not: null } }, escopoRascunho({ escrita: true })] },
    select: { id: true, telefone: true, extra: true },
  });
  const alvo = rascunhos.filter((r) => !temChave(r.extra, "temWhatsApp"));
  if (alvo.length === 0) return resumo;

  const conta = await prisma.channelAccount.findFirst({
    where: { canal: "whatsapp", provider: "evolution", status: "connected", paused: false },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const respostas = await temWhatsApp(
    alvo.map((r) => r.telefone!),
    { channelAccountId: conta?.id ?? null },
  );

  const grupos = new Map<boolean | null, string[]>([[true, []], [false, []], [null, []]]);
  for (const r of alvo) {
    const e164 = normalizePhone(r.telefone!);
    const existe = e164 ? respostas.get(e164)?.existe ?? null : null;
    grupos.get(existe)!.push(r.id);
  }
  for (const [valor, ids] of grupos) {
    if (ids.length === 0) continue;
    await prisma.$executeRaw`
      UPDATE "ProspectDraft"
      SET extra = (CASE WHEN jsonb_typeof(extra) = 'object' THEN extra ELSE '{}'::jsonb END)
                  || jsonb_build_object('temWhatsApp', ${JSON.stringify(valor)}::jsonb)
      WHERE "teamId" = ${teamId} AND id = ANY(${ids}::text[])`;
  }
  resumo.verificados = alvo.length;
  resumo.comWhatsApp = grupos.get(true)!.length;
  resumo.semWhatsApp = grupos.get(false)!.length;
  resumo.naoSei = grupos.get(null)!.length;
  logger.info({ lote, ...resumo, conta: conta?.id ?? null }, "[captura] tem WhatsApp? marcado na fila");
  return resumo;
}

// ─── Leitura para a tela (DTO) ──────────────────────────────────────────────

export type ExtrasDoRascunho = {
  temWhatsApp: boolean | null;
  produtorLabel: ProdutorLabel | null;
  produtorScore: number | null;
  avaliacao: number | null;
  avaliacoes: number | null;
  bio: string | null;
};

/** Rótulos do classificador de produtor (filtro da fila, H.6). */
export const PRODUTOR_LABELS = ["produtor", "provavel_produtor", "nao_produtor"] as const satisfies readonly ProdutorLabel[];

const extrasSchema = z
  .object({
    temWhatsApp: z.boolean().nullish().catch(null),
    produtorLabel: z.enum(PRODUTOR_LABELS).nullish().catch(null),
    produtorScore: z.number().nullish().catch(null),
    avaliacao: z.number().nullish().catch(null),
    avaliacoes: z.number().int().nullish().catch(null),
    bio: z.string().nullish().catch(null),
  })
  .passthrough();

/** Extrai os campos das telas do JSON `extra` (lixo ou ausente → null). */
export function extrasDoRascunho(extra: unknown): ExtrasDoRascunho {
  const r = extrasSchema.safeParse(extra ?? {});
  // Cada campo tem `.catch(null)`: só falha se `extra` nem for objeto.
  const e = r.success ? r.data : extrasSchema.parse({});
  return {
    temWhatsApp: e.temWhatsApp ?? null,
    produtorLabel: e.produtorLabel ?? null,
    produtorScore: e.produtorScore ?? null,
    avaliacao: e.avaliacao ?? null,
    avaliacoes: e.avaliacoes ?? null,
    bio: e.bio ?? null,
  };
}

/** Filtros da fila (H.6) em `extra`, prontos para o `where` do Prisma. */
export function filtrosDeExtras(input: {
  temWhatsApp?: boolean;
  produtorLabel?: ProdutorLabel | ProdutorLabel[];
}): Prisma.ProspectDraftWhereInput[] {
  const f: Prisma.ProspectDraftWhereInput[] = [];
  if (typeof input.temWhatsApp === "boolean") {
    f.push({ extra: { path: ["temWhatsApp"], equals: input.temWhatsApp } });
  }
  const labels = input.produtorLabel === undefined ? [] : Array.isArray(input.produtorLabel) ? input.produtorLabel : [input.produtorLabel];
  if (labels.length) {
    f.push({ OR: labels.map((l) => ({ extra: { path: ["produtorLabel"], equals: l } })) });
  }
  return f;
}
