import { z } from "zod";

export const funnelCreateSchema = z.object({
  nome: z.string().trim().min(1, "nome obrigatório"),
  tipo: z.enum(["pre_vendas", "vendas", "follow_up"]),
  codigo: z.string().trim().optional(),
});

/** Novo funil com colunas customizadas (nomes na ordem desejada). */
export const funnelCreateWithStagesSchema = funnelCreateSchema.extend({
  stages: z.array(z.string().trim().min(1)).optional(),
});

export const stageCreateSchema = z.object({
  funnelId: z.string().min(1),
  nome: z.string().trim().min(1, "nome obrigatório"),
  ordem: z.number().int().min(0),
  cor: z.string().trim().optional(),
  codigo: z.string().trim().optional(),
});

export const stageUpdateSchema = z.object({
  nome: z.string().trim().min(1).optional(),
  cor: z.string().trim().optional(),
});

export const dealCreateSchema = z.object({
  funnelId: z.string().min(1),
  stageId: z.string().min(1),
  contactId: z.string().min(1),
  valor: z.number().min(0).optional(),
});

export const funnelUpdateSchema = funnelCreateSchema.partial();

/**
 * "Carregar mais" do kanban (item 2.4, DP-12): cartões de uma etapa (abertos,
 * por padrão) ou os ganhos/perdidos do funil, 50 por página, cursor opaco.
 */
export const listFunnelDealsInputSchema = z.object({
  stageId: z.string().uuid().optional(),
  status: z.enum(["open", "won", "lost"]).default("open"),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Filtro "por vendedor" (F3): dono do negócio. Dentro do escopo de quem pede. */
  dono: z.string().uuid().optional(),
});

export type FunnelCreate = z.infer<typeof funnelCreateSchema>;
export type FunnelCreateWithStages = z.infer<typeof funnelCreateWithStagesSchema>;
export type FunnelUpdate = z.infer<typeof funnelUpdateSchema>;
export type StageCreate = z.infer<typeof stageCreateSchema>;
export type StageUpdate = z.infer<typeof stageUpdateSchema>;
export type DealCreate = z.infer<typeof dealCreateSchema>;
export type ListFunnelDealsInput = z.input<typeof listFunnelDealsInputSchema>;
