import { z } from "zod";

/**
 * Importação de contatos em 4 passos (produto §C): Arquivo → Colunas →
 * Checagem → Importar. Schemas da borda (zod); tipos via `z.infer`.
 */

/**
 * Para onde vai cada coluna da planilha. `null` = "Não importar".
 * `tags` aceita várias colunas (ex.: "Cultura" e "Segmento"); os demais, uma.
 */
export const CAMPOS_IMPORTACAO = [
  "nome",
  "sobrenome",
  "cpf",
  "documento",
  "whatsapp",
  "whatsapp2",
  "email",
  "email2",
  "empresa",
  "cnpj",
  "ie",
  "cidade",
  "estado",
  "cargo",
  "origem",
  "tags",
] as const;

export const campoImportacaoSchema = z.enum(CAMPOS_IMPORTACAO);
export type CampoImportacao = z.infer<typeof campoImportacaoSchema>;

/** Um item por coluna da planilha, na mesma ordem das colunas. */
export const mapeamentoSchema = z.array(campoImportacaoSchema.nullable()).max(200);
export type Mapeamento = z.infer<typeof mapeamentoSchema>;

/** Opções do passo "Importar". */
export const opcoesImportacaoSchema = z.object({
  /** Origem gravada nos contatos sem coluna de origem. */
  origem: z.string().trim().min(1).max(60).default("csv"),
  /** Contato que já existe: completar os campos vazios (padrão) ou deixar como está. */
  existentes: z.enum(["completar", "pular"]).default("completar"),
});
export type OpcoesImportacao = z.infer<typeof opcoesImportacaoSchema>;
export type OpcoesImportacaoInput = z.input<typeof opcoesImportacaoSchema>;

/** Entrada da prévia: o texto da planilha (CSV) e, opcionalmente, o mapeamento escolhido. */
export const previewImportInputSchema = z.object({
  texto: z.string(),
  mapeamento: mapeamentoSchema.optional(),
});
export type PreviewImportInput = z.infer<typeof previewImportInputSchema>;
