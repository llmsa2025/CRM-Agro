import { z } from "zod";

/**
 * O FATO de ligação: o que o adaptador entrega ao núcleo de prova (plano: a documentação interna,
 * F1B-03). É um dado NEUTRO e mínimo: diz o que aconteceu com uma ligação, nunca com quem.
 *
 * - **Nunca** carrega telefone, SDP, nome nem corpo do aviso. O schema é `.strict()`: campo desconhecido
 *   reprova. O destino e a origem que o aviso traz para conferência vão à parte, nas PONTAS (só em memória).
 * - Quem decide o desfecho é o aplicador (F1B-08), pela tabela de causas. O fato só traz a causa neutra.
 * - O `idEvento` é estável para o mesmo aviso: o mesmo aviso duas vezes dá o mesmo id (a caixa acrescenta a origem).
 */

/** Instante completo em ISO 8601 com fuso. */
const InstanteDeLigacaoSchema = z.string().datetime({ offset: true });

/** Id que vem do provedor ou é fabricado: ASCII visível, sem espaço, para caber em chave de fila e de índice. */
const IdDeLigacaoSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "Id com caracteres inválidos.");

/** As 11 causas neutras da tabela de causas (plano, Notas comuns da F1B). */
export const CAUSAS_DE_LIGACAO = [
  "atendida",
  "nao_atendeu",
  "ocupado",
  "recusou",
  "caixa_postal",
  "numero_inexistente",
  "cancelada_por_quem_ligou",
  "falha_de_rede",
  "sem_permissao",
  "destino_nao_recebe",
  "desconhecida",
] as const;
export const CausaDeLigacaoSchema = z.enum(CAUSAS_DE_LIGACAO);
export type CausaDeLigacao = z.infer<typeof CausaDeLigacaoSchema>;

/** Onde a linha está no provedor: a conta e o id dentro dela (ramal, id do número). */
export const RefDaLinhaDeLigacaoSchema = z.object({ contaExterna: IdDeLigacaoSchema, idExterno: IdDeLigacaoSchema }).strict();
export type RefDaLinhaDeLigacao = z.infer<typeof RefDaLinhaDeLigacaoSchema>;

const base = {
  idEvento: IdDeLigacaoSchema,
  ocorridoEm: InstanteDeLigacaoSchema,
  providerCallId: IdDeLigacaoSchema.optional(),
  refDaLinha: RefDaLinhaDeLigacaoSchema.optional(),
  /** O id da ligação no CRM Agro, quando o adaptador o devolveu ao provedor (metadata) e o aviso o repete. */
  refDaLigacao: z.string().uuid().optional(),
};

/** Código curto do provedor (ex.: `480`, `NORMAL_CLEARING`). Nada que pareça telefone. */
const CodigoDoProvedorSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[\x20-\x7e]+$/, "Código com caracteres inválidos.")
  .refine((s) => !/\d{8,}/.test(s), "O código do provedor não pode conter número de telefone.");

/** O arquivo da gravação é citado pelo id dele, NUNCA pela URL (a URL pode carregar token). */
const RefDaGravacaoSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[\x21-\x7e]+$/, "Referência com caracteres inválidos.")
  .refine((s) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(s), "A referência da gravação não pode ser uma URL.");

const FatoChamandoSchema = z.object({ ...base, tipo: z.literal("chamando") }).strict();
const FatoAtendidaSchema = z.object({ ...base, tipo: z.literal("atendida") }).strict();
const FatoRecusadaSchema = z.object({ ...base, tipo: z.literal("recusada") }).strict();
const FatoEncerradaSchema = z
  .object({
    ...base,
    tipo: z.literal("encerrada"),
    causa: CausaDeLigacaoSchema,
    atendidaEm: InstanteDeLigacaoSchema.optional(),
    /** Segundos conectados, só quando o provedor informa. */
    duracaoConectadaS: z.number().int().min(0).max(86_400).optional(),
    codigoDoProvedor: CodigoDoProvedorSchema.optional(),
  })
  .strict();
const FatoFalhouAoOriginarSchema = z.object({ ...base, tipo: z.literal("falhou_ao_originar"), causa: CausaDeLigacaoSchema }).strict();
const FatoGravacaoProntaSchema = z
  .object({
    ...base,
    tipo: z.literal("gravacao_pronta"),
    refGravacao: RefDaGravacaoSchema,
    /** Hash do arquivo, quando o provedor o informa. A cópia confere. */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mime: z.string().max(80).regex(/^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/),
    expiraEm: InstanteDeLigacaoSchema.optional(),
  })
  .strict();

export const TIPOS_DE_FATO_DE_LIGACAO = ["chamando", "atendida", "recusada", "encerrada", "falhou_ao_originar", "gravacao_pronta"] as const;
export type TipoDeFatoDeLigacao = (typeof TIPOS_DE_FATO_DE_LIGACAO)[number];

export const FatoDeLigacaoSchema = z
  .discriminatedUnion("tipo", [
    FatoChamandoSchema,
    FatoAtendidaSchema,
    FatoRecusadaSchema,
    FatoEncerradaSchema,
    FatoFalhouAoOriginarSchema,
    FatoGravacaoProntaSchema,
  ])
  .superRefine((f, ctx) => {
    if (f.providerCallId === undefined && f.refDaLigacao === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerCallId"], message: "O fato precisa de providerCallId ou de refDaLigacao." });
    }
  });
export type FatoDeLigacao = z.infer<typeof FatoDeLigacaoSchema>;

/**
 * Sinal EFÊMERO: vive só em memória e nunca vai a banco, fila nem log. Hoje só a resposta SDP de uma ligação
 * pelo navegador (WebRTC), que o motor do navegador consome uma vez.
 */
export const SinalEfemeroDeLigacaoSchema = z
  .object({
    tipo: z.literal("sdp_resposta"),
    /** Até 16 KB. */
    valor: z
      .string()
      .min(1)
      .max(16 * 1024),
    providerCallId: IdDeLigacaoSchema,
    refDaLigacao: z.string().uuid().optional(),
  })
  .strict();
export type SinalEfemeroDeLigacao = z.infer<typeof SinalEfemeroDeLigacaoSchema>;

/**
 * Ponta: o destino e a origem que o aviso traz, para o CRM Agro conferir com a ligação gravada (destino
 * divergente é órfão). Vive só em memória: NUNCA vai para banco nem para log, e não faz parte do fato.
 */
export const PontaDeLigacaoSchema = z
  .object({
    /** O `idEvento` do fato a que a ponta pertence. */
    idEvento: IdDeLigacaoSchema,
    destinoE164: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/)
      .optional(),
    /** O identificador da origem no provedor (ramal, id do número). */
    origemExterna: IdDeLigacaoSchema.optional(),
  })
  .strict();
export type PontaDeLigacao = z.infer<typeof PontaDeLigacaoSchema>;

const pontasSaoDeFatos = (r: { fatos: { idEvento: string }[]; pontas: { idEvento: string }[] }, ctx: z.RefinementCtx) => {
  const ids = new Set(r.fatos.map((f) => f.idEvento));
  if (r.pontas.some((p) => !ids.has(p.idEvento))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pontas"], message: "Toda ponta pertence a um fato do mesmo resultado." });
  }
};

/** O que `normalizarWebhook` devolve. PURA: sem rede nem banco. */
export const ResultadoDaNormalizacaoDeLigacaoSchema = z
  .object({
    fatos: z.array(FatoDeLigacaoSchema).max(200),
    sinais: z.array(SinalEfemeroDeLigacaoSchema).max(50),
    pontas: z.array(PontaDeLigacaoSchema).max(200),
  })
  .strict()
  .superRefine(pontasSaoDeFatos);
export type ResultadoDaNormalizacaoDeLigacao = z.infer<typeof ResultadoDaNormalizacaoDeLigacaoSchema>;

/** O que `consultar` devolve: o fim real, visto pelo próprio provedor. */
export const ResultadoDaConsultaDeLigacaoSchema = z
  .object({
    fatos: z.array(FatoDeLigacaoSchema).max(200),
    pontas: z.array(PontaDeLigacaoSchema).max(200),
  })
  .strict()
  .superRefine(pontasSaoDeFatos);
export type ResultadoDaConsultaDeLigacao = z.infer<typeof ResultadoDaConsultaDeLigacaoSchema>;
