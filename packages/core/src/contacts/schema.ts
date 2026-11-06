import { z } from "zod";
import { normalizePhone } from "./phone";

/**
 * Schemas zod de contato — uma fonte de verdade. Tipos via z.infer.
 * A normalização (E.164, lowercase email) acontece no service, não no schema,
 * pra manter o schema válido para create E partial update.
 */

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .optional()
  .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "email inválido");

const telefoneField = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || normalizePhone(v) !== null, "telefone inválido (use DDD + número)");

/**
 * Número vindo de formulário em pt-BR: "1.250" = 1250, "2,5" = 2.5, "1.250,5"
 * = 1250.5. Vazio ou null = null (na atualização, limpa o campo); ausente =
 * não mexe. Não usa `z.coerce` — ele transforma "" e null em 0.
 */
export function numeroBR(v: unknown): unknown {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return v;
  const s = v.trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (s === "") return null;
  if (s.includes(",")) return Number(s.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
  return Number(s);
}
const numeroOpcional = (max: number, rotulo: string) =>
  z
    .preprocess(
      numeroBR,
      z
        .number({ invalid_type_error: `${rotulo} inválido(a)` })
        .finite(`${rotulo} inválido(a)`)
        .nonnegative(`${rotulo} não pode ser negativo(a)`)
        .max(max, `${rotulo} acima do limite`)
        .nullable(),
    )
    .optional();
/** Área da propriedade em hectares (opcional; teto 10 milhões de ha). */
export const areaHaField = numeroOpcional(10_000_000, "área");
/** Faturamento anual em R$ (opcional; teto 1 trilhão). */
export const faturamentoAnualField = numeroOpcional(1e12, "faturamento");

export const contactCreateSchema = z.object({
  nome: z.string().trim().min(1, "nome obrigatório"),
  sobrenome: z.string().trim().optional(),
  email: emailField,
  telefone: telefoneField,
  cidade: z.string().trim().optional(),
  estado: z.string().trim().max(40).optional(),
  empresa: z.string().trim().optional(),
  cargo: z.string().trim().optional(),
  origem: z.string().trim().optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
  areaHa: areaHaField,
  faturamentoAnual: faturamentoAnualField,
});

export const contactUpdateSchema = contactCreateSchema.partial().extend({
  /**
   * As tags que a pessoa via ao abrir o formulário de edição. Com ela, `tags` vale pela DIFERENÇA (o que foi posto
   * e o que foi tirado), não como lista final: ver `update` e `tags/do-contato.ts`. Sem ela, `tags` é a lista final.
   */
  tagsIniciais: z.array(z.string().trim().min(1)).optional(),
});

export const noteSchema = z.object({
  conteudo: z.string().trim().min(1, "nota vazia"),
});

export type ContactCreate = z.infer<typeof contactCreateSchema>;
export type ContactUpdate = z.infer<typeof contactUpdateSchema>;
export type ContactNote = z.infer<typeof noteSchema>;

// ---------------------------------------------------------------------------
// Schema CANÔNICO de escrita de contato (writeContact). Fonte de verdade única
// que TODA borda usa (form, IA, captação, import CSV, webhook). Ver
// a documentação interna §2.
//
// Regra "pessoa vs empresa": o Contact é a PESSOA. CNPJ/IE/site NUNCA são coluna
// de pessoa — vão para `companies[]`→Company. Por isso o schema de pessoa é
// .strict(): passar `cnpj`/`site`/`ie` no nível da pessoa é ERRO explícito (o
// caller deve mandar em companies[]), fechando o furo das reimplementações.
// ---------------------------------------------------------------------------

/** Identifiers multicanal explícitos (a coluna telefone/email não existe mais). */
export const contactIdentifiersSchema = z
  .object({
    whatsapp: z.string().trim().optional(),
    email: emailField,
    instagram: z.string().trim().optional(),
    linkedin: z.string().trim().optional(),
  })
  .default({});

/** Empresa vinculada (papel) — dedup por CNPJ acontece no serviço. */
export const companyUpsertSchema = z.object({
  nome: z.string().trim().min(1, "nome da empresa obrigatório"),
  cnpj: z.string().trim().optional().nullable(),
  ie: z.string().trim().optional().nullable(),
  site: z.string().trim().optional().nullable(),
  email: z.string().trim().optional().nullable(),
  telefone: z.string().trim().optional().nullable(),
  endereco: z.string().trim().optional().nullable(),
  cidade: z.string().trim().optional().nullable(),
  estado: z.string().trim().optional().nullable(),
  instagram: z.string().trim().optional().nullable(),
  linkedin: z.string().trim().optional().nullable(),
  naturezaJuridica: z.string().trim().optional().nullable(),
  papel: z.enum(["dono", "socio", "funcionario", "outro"]).default("socio"),
});

/** Proveniência: quem/como escreveu (atribuição estruturada — §3). */
export const provenanceSchema = z.object({
  /** origem técnica: "form" | "csv" | "captacao_cnpj" | "ia" | "webhook" | … */
  source: z.string().trim().min(1),
  /** ator: "human" | "ai" | "system" */
  actor: z.enum(["human", "ai", "system"]).default("human"),
});

export const contactUpsertSchema = z
  .object({
    nome: z.string().trim().min(1, "nome obrigatório"),
    sobrenome: z.string().trim().optional(),
    cidade: z.string().trim().optional(),
    estado: z.string().trim().max(40).optional(),
    endereco: z.string().trim().optional(),
    cargo: z.string().trim().optional(),
    cpf: z.string().trim().optional(),
    // `empresa` é o NOME denormalizado da empresa principal (coluna legado, usada
    // por lista/card do funil/{empresa}). NÃO é dado estruturado de empresa — CNPJ/
    // IE/site continuam PROIBIDOS na pessoa (vão em companies[]).
    empresa: z.string().trim().optional(),
    origem: z.string().trim().optional(),
    tags: z.array(z.string().trim().min(1)).default([]),
    areaHa: areaHaField,
    faturamentoAnual: faturamentoAnualField,
    identifiers: contactIdentifiersSchema,
    companies: z.array(companyUpsertSchema).optional(),
    provenance: provenanceSchema,
  })
  .strict();

export type ContactIdentifiersInput = z.infer<typeof contactIdentifiersSchema>;
export type CompanyUpsertInput = z.infer<typeof companyUpsertSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type ContactUpsertInput = z.input<typeof contactUpsertSchema>;
export type ContactUpsertParsed = z.infer<typeof contactUpsertSchema>;
