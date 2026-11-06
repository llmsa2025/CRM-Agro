import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db, tenantData } from "@crmagro/db";
import { requireCan } from "../auth/authz";
import { assertOwnedMany } from "../tenancy/assert-owned";

import { whereDoEscopo } from "../tenancy/escopo";
/**
 * Camadas do mapa (produto §B) — como as camadas do Google My Maps: a pessoa
 * cria "Acima de 5.000 ha", "Centro-Sul", "Feira 2026"…, dá uma cor, move
 * contatos para dentro (um por vez, pela ficha, ou os N visíveis de uma vez) e
 * liga/desliga cada camada na tela. Um contato fica em no máximo uma camada;
 * sem camada = "Sem camada" (também ligável/desligável).
 *
 * RBAC: ler = qualquer um do time; criar/renomear/excluir/mover = `contacts.write`.
 */

export const CORES_CAMADA = ["#1F4A3A", "#2F5B8A", "#9A6212", "#A8321E", "#6B4C9A", "#0E7C7B", "#C2185B", "#505752"] as const;

export const camadaInputSchema = z.object({
  nome: z.string().trim().min(1, "nome obrigatório").max(60),
  cor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "cor inválida")
    .default(CORES_CAMADA[0]),
});
export type CamadaInput = z.input<typeof camadaInputSchema>;

export type CamadaDTO = { id: string; nome: string; cor: string; ordem: number; contatos: number };

export class CamadaNaoEncontrada extends Error {
  constructor(id: string) {
    super(`CamadaNaoEncontrada: camada ${id} não encontrada no time.`);
    this.name = "CamadaNaoEncontrada";
  }
}
export class CamadaJaExiste extends Error {
  constructor(nome: string) {
    super(`CamadaJaExiste: já existe uma camada chamada "${nome}".`);
    this.name = "CamadaJaExiste";
  }
}

/** Camadas do time, na ordem, com a contagem de contatos de cada uma + os sem camada. */
export async function listCamadas(): Promise<{ camadas: CamadaDTO[]; semCamada: number }> {
  const prisma = db();
  // F3: contagens só dos contatos do escopo de quem pede.
  const escopo = whereDoEscopo("contatos", "ownerId", { compartilhado: true }) as Prisma.ContactWhereInput;
  const [rows, semCamada] = await Promise.all([
    prisma.mapaCamada.findMany({
      orderBy: [{ ordem: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { contatos: { where: escopo } } } },
    }),
    prisma.contact.count({ where: { AND: [{ camadaId: null }, escopo] } }),
  ]);
  return { camadas: rows.map((r) => ({ id: r.id, nome: r.nome, cor: r.cor, ordem: r.ordem, contatos: r._count.contatos })), semCamada };
}

export async function createCamada(input: CamadaInput): Promise<CamadaDTO> {
  requireCan("contacts.write");
  const d = camadaInputSchema.parse(input);
  const prisma = db();
  const existe = await prisma.mapaCamada.findFirst({ where: { nome: d.nome }, select: { id: true } });
  if (existe) throw new CamadaJaExiste(d.nome);
  const ultima = await prisma.mapaCamada.findFirst({ orderBy: { ordem: "desc" }, select: { ordem: true } });
  const r = await prisma.mapaCamada.create({ data: tenantData<Prisma.MapaCamadaUncheckedCreateInput>({ nome: d.nome, cor: d.cor, ordem: (ultima?.ordem ?? 0) + 1 }) });
  return { id: r.id, nome: r.nome, cor: r.cor, ordem: r.ordem, contatos: 0 };
}

export async function updateCamada(id: string, input: Partial<CamadaInput>): Promise<CamadaDTO> {
  requireCan("contacts.write");
  const d = camadaInputSchema.partial().parse(input);
  const prisma = db();
  const atual = await prisma.mapaCamada.findUnique({ where: { id }, select: { id: true } });
  if (!atual) throw new CamadaNaoEncontrada(id);
  if (d.nome) {
    const outra = await prisma.mapaCamada.findFirst({ where: { nome: d.nome, id: { not: id } }, select: { id: true } });
    if (outra) throw new CamadaJaExiste(d.nome);
  }
  const r = await prisma.mapaCamada.update({
    where: { id },
    data: { ...(d.nome ? { nome: d.nome } : {}), ...(d.cor ? { cor: d.cor } : {}) },
    include: { _count: { select: { contatos: true } } },
  });
  return { id: r.id, nome: r.nome, cor: r.cor, ordem: r.ordem, contatos: r._count.contatos };
}

/** Exclui a camada; os contatos voltam para "Sem camada" (FK SetNull). */
export async function deleteCamada(id: string): Promise<void> {
  requireCan("contacts.write");
  const prisma = db();
  const atual = await prisma.mapaCamada.findUnique({ where: { id }, select: { id: true } });
  if (!atual) throw new CamadaNaoEncontrada(id);
  await prisma.mapaCamada.delete({ where: { id } });
}

export type ContatoNoMapaDTO = { id: string; camadaId: string | null; areaHa: number | null; faturamentoAnual: number | null };

/** O que o cartão do contato no mapa mostra além do pino: camada, área e faturamento. */
export async function contatoNoMapa(id: string): Promise<ContatoNoMapaDTO | null> {
  // F3: só o contato do escopo de quem pede.
  const escopo = whereDoEscopo("contatos", "ownerId", { compartilhado: true }) as Prisma.ContactWhereInput;
  return db().contact.findFirst({ where: { AND: [{ id }, escopo] }, select: { id: true, camadaId: true, areaHa: true, faturamentoAnual: true } });
}

/**
 * Move contatos para uma camada (`null` = tira da camada). Só ids do próprio
 * time entram (`assertOwnedMany`); a camada também precisa ser do time.
 */
export async function moverContatosParaCamada(contactIds: string[], camadaId: string | null): Promise<{ movidos: number }> {
  requireCan("contacts.write");
  const ids = [...new Set(contactIds)].slice(0, 5000);
  if (ids.length === 0) return { movidos: 0 };
  await assertOwnedMany("contact", ids);
  const prisma = db();
  if (camadaId) {
    const c = await prisma.mapaCamada.findUnique({ where: { id: camadaId }, select: { id: true } });
    if (!c) throw new CamadaNaoEncontrada(camadaId);
  }
  const r = await prisma.contact.updateMany({ where: { id: { in: ids } }, data: { camadaId } });
  return { movidos: r.count };
}
