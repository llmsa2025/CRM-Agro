import { z } from "zod";

/**
 * Schemas zod de tag — uma fonte de verdade. Tipos via z.infer.
 *
 * `cor` é um token da UI (ex.: "brand", "amber", "sky") ou hex; a UI resolve.
 */

export const tagCreateSchema = z.object({
  nome: z.string().trim().min(1, "nome obrigatório").max(40, "nome muito longo"),
  cor: z.string().trim().min(1).max(24).optional(),
});

export const tagUpdateSchema = tagCreateSchema.partial();

/**
 * Atribuição de tag a um contato. `tagId` null = remover a tag do contato
 * (contato pode ficar sem tag — é permitido). O limite de "1 tag por contato
 * (por enquanto)" é imposto no service (substitui a existente).
 */
export const assignTagSchema = z.object({
  contactId: z.string().uuid(),
  tagId: z.string().uuid().nullable(),
});

/** Atribuição em massa (mover N contatos para uma tag, ou tirar a tag de todos). */
export const assignTagBulkSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1, "selecione ao menos um contato"),
  tagId: z.string().uuid().nullable(),
});

export type TagCreate = z.infer<typeof tagCreateSchema>;
export type TagUpdate = z.infer<typeof tagUpdateSchema>;
export type AssignTag = z.infer<typeof assignTagSchema>;
export type AssignTagBulk = z.infer<typeof assignTagBulkSchema>;
