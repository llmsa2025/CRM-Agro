import { z } from "zod";

/**
 * Schema da resposta da BrasilAPI (GET /api/cnpj/v1/{cnpj}).
 * passthrough: a BrasilAPI devolve dezenas de campos; só validamos o que
 * usamos, o resto é ignorado. Campos de nome/cnpj podem vir ausentes.
 */
export const brasilApiCnpjSchema = z
  .object({
    cnpj: z.string().optional(),
    nome_fantasia: z.string().optional(),
    razao_social: z.string().optional(),
    nome_empresarial: z.string().optional(),
    situacao_cadastral: z.string().optional(),
    descricao_situacao_cadastral: z.string().optional(),
    data_inicio_atividade: z.string().optional(),
    cnae_fiscal: z.string().optional(),
    cnae_fiscal_descricao: z.string().optional(),
    tipo_logradouro: z.string().optional(),
    logradouro: z.string().optional(),
    numero: z.string().optional(),
    complemento: z.string().optional(),
    bairro: z.string().optional(),
    municipio: z.string().optional(),
    uf: z.string().optional(),
    cep: z.string().optional(),
    ddd_telefone_1: z.string().optional(),
    ddd_telefone_2: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

export type BrasilApiCnpj = z.infer<typeof brasilApiCnpjSchema>;
