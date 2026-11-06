import { z } from "zod";

/**
 * Verificador do agro: o que um contato É no agro. Vários tipos ou nenhum.
 *
 * - produtor: dono ou sócio de empresa com atividade rural (o nome do contato bate com um sócio da empresa);
 * - fazenda: a propriedade rural em si (nome ou foto);
 * - armazem: armazém geral, silo, cerealista;
 * - algodoeira: beneficiamento de algodão;
 * - pecuaria: criação de gado (foto de gado, ou "pecuária" no nome);
 * - transportadora: transporte de carga (nome com "transportadora" ou "transportes", ou CNAE de transporte rodoviário de carga).
 *
 * A lavoura vista na foto conta como fazenda. Gado na foto conta como pecuária, não como fazenda.
 */
export const AGRO_TIPOS = ["produtor", "fazenda", "armazem", "algodoeira", "pecuaria", "transportadora"] as const;
export type AgroTipo = (typeof AGRO_TIPOS)[number];

export const AGRO_ROTULO: Record<AgroTipo, string> = {
  produtor: "Produtor",
  fazenda: "Fazenda",
  armazem: "Armazém",
  algodoeira: "Algodoeira",
  pecuaria: "Pecuária",
  transportadora: "Transportadora",
};

export const agroTipoSchema = z.enum(AGRO_TIPOS);

export function ehAgroTipo(v: unknown): v is AgroTipo {
  return typeof v === "string" && (AGRO_TIPOS as readonly string[]).includes(v);
}

/** Lista de tipos vinda do banco ou da tela: só os válidos, sem repetir, na ordem do catálogo. */
export function agroTiposValidos(v: readonly unknown[] | null | undefined): AgroTipo[] {
  const vistos = new Set((v ?? []).filter(ehAgroTipo));
  return AGRO_TIPOS.filter((t) => vistos.has(t));
}

/** Valor do filtro da lista para "nenhum tipo" (contato sem classificação). */
export const AGRO_SEM_TIPO = "nenhum" as const;
export type AgroFiltro = AgroTipo | typeof AGRO_SEM_TIPO;

/** Filtro da lista vindo da URL: um tipo, "nenhum" ou nada (valor estranho vira nada). */
export function agroFiltroValido(v: unknown): AgroFiltro | undefined {
  return v === AGRO_SEM_TIPO || ehAgroTipo(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Leitura da foto (quem lê é o Claude, pelo MCP crmagro-agro; o servidor valida)
// ---------------------------------------------------------------------------

/** "outra" = a foto não mostra nada do agro (pessoa, paisagem urbana, logotipo de outra coisa). "pecuaria" = gado. */
export const CATEGORIAS_DA_FOTO = ["fazenda", "lavoura", "armazem", "algodoeira", "pecuaria", "outra"] as const;
export type CategoriaDaFoto = (typeof CATEGORIAS_DA_FOTO)[number];

export const leituraDaFotoSchema = z.object({
  categoria: z.enum(CATEGORIAS_DA_FOTO),
  confianca: z.enum(["alta", "media", "baixa"]),
  /** O que apareceu na imagem, em uma frase. Vai para a tela como evidência. */
  motivo: z.string().trim().min(1).max(300),
});
export type LeituraDaFoto = z.infer<typeof leituraDaFotoSchema>;

// ---------------------------------------------------------------------------
// O que fica em Contact.agroDetalhe
// ---------------------------------------------------------------------------

export const evidenciaSchema = z.object({
  /** null = só informa (não conta para nenhum tipo). */
  tipo: agroTipoSchema.nullable(),
  fonte: z.enum(["nome", "empresa", "socio", "foto"]),
  /** 2 = sinal forte (decide sozinho), 1 = fraco (precisa de outro sinal de outra fonte), 0 = só informa. */
  peso: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  texto: z.string().max(400),
});
export type Evidencia = z.infer<typeof evidenciaSchema>;

/** A foto, no último estado conhecido. Nunca guarda a imagem, o telefone nem o endereço da foto. */
export const estadoDaFotoSchema = z.discriminatedUnion("estado", [
  z.object({ estado: z.literal("na_fila"), em: z.string().datetime() }),
  z.object({ estado: z.literal("lida"), em: z.string().datetime(), leitura: leituraDaFotoSchema }),
  z.object({ estado: z.literal("sem_foto"), em: z.string().datetime() }),
  /** Não deu para saber (WhatsApp sem conta conectada, sem número, Evolution fora do ar). */
  z.object({ estado: z.literal("indisponivel"), em: z.string().datetime(), motivo: z.string().max(200) }),
]);
export type EstadoDaFoto = z.infer<typeof estadoDaFotoSchema>;

export const agroDetalheSchema = z.object({
  versao: z.string(),
  /** "manual" = a pessoa ajustou os tipos; a verificação automática não mexe até ela pedir. */
  origem: z.enum(["automatica", "manual"]),
  verificadoEm: z.string().datetime(),
  evidencias: z.array(evidenciaSchema).max(40),
  /** A foto na fila (`na_fila`) é o pedido que o Claude lê pelo MCP crmagro-agro. */
  foto: estadoDaFotoSchema.nullable(),
});
export type AgroDetalhe = z.infer<typeof agroDetalheSchema>;

/** Lê o Json do banco sem confiar nele: formato antigo ou estranho vira null. */
export function lerAgroDetalhe(v: unknown): AgroDetalhe | null {
  const p = agroDetalheSchema.safeParse(v);
  return p.success ? p.data : null;
}
