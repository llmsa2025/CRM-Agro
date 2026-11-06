import { z } from "zod";

/**
 * Validação das etapas da campanha (produto §A.2). zod na borda: as actions
 * passam o que vem da tela por aqui antes de gravar.
 */

/**
 * Variáveis que o `renderTemplate` do motor sabe preencher. Variável fora
 * desta lista ficaria LITERAL na mensagem do lead ("Oi {cultura}") — o
 * `renderTemplate` deixa o desconhecido como está —, então é recusada ao
 * salvar. `campaigns/schema.test.ts` confere que cada uma é de fato trocada.
 */
export const VARIAVEIS_DA_MENSAGEM = [
  "saudacao",
  "nome",
  "primeiro_nome",
  "sobrenome",
  "empresa",
  "cargo",
  "profissao",
  "cidade",
  "estado",
  "empresa_cidade",
  "empresa_estado",
] as const;

const VARIAVEL_RE = /\{(\w+)(?:\|[^}]*)?\}/g;
/**
 * Link na 1ª mensagem é o sinal clássico de spam para o WhatsApp. Só passam os
 * links de vídeo que o dono manda de propósito (YouTube e Instagram): o
 * WhatsApp monta o cartão com a capa do vídeo.
 */
const LINK_RE = /(?:https?:\/\/|www\.)[^\s]+/gi;
const SITES_DE_VIDEO = ["youtube.com", "youtu.be", "instagram.com"];

function linkDeVideo(bruto: string): boolean {
  try {
    const host = new URL(/^https?:\/\//i.test(bruto) ? bruto : `https://${bruto}`).hostname.toLowerCase();
    return SITES_DE_VIDEO.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

/** Todo link do texto é de vídeo do YouTube ou do Instagram (sem link também vale). */
export function soTemLinkDeVideo(texto: string): boolean {
  return (texto.match(LINK_RE) ?? []).every(linkDeVideo);
}

export function variaveisDesconhecidas(texto: string): string[] {
  const conhecidas = new Set<string>(VARIAVEIS_DA_MENSAGEM);
  return [...texto.matchAll(VARIAVEL_RE)].map((m) => m[1]!).filter((v) => !conhecidas.has(v));
}

const textoDeMensagem = z
  .string()
  .trim()
  .min(1, "mensagem vazia")
  .max(1000, "mensagem longa demais (máx. 1000 caracteres)")
  .refine(soTemLinkDeVideo, "sem link na primeira mensagem, só de vídeo do YouTube ou do Instagram (outros parecem spam para o WhatsApp)")
  .superRefine((t, ctx) => {
    const fora = variaveisDesconhecidas(t);
    if (fora.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `variável desconhecida: ${[...new Set(fora)].map((v) => `{${v}}`).join(", ")}`,
      });
    }
  });

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const hora = z.string().regex(HORA_RE, "hora no formato HH:MM");
const minutosDe = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));

/**
 * Regra de quem já conversou. `enviar` ("Nenhuma" na tela): recebe a mesma
 * mensagem dos outros. `campanha:<id>`: pula quem RECEBEU mensagem da campanha
 * <id> (enviada, tenha chegado ou não) e manda a mensagem normal aos demais.
 * A campanha escolhida mora no próprio texto da regra (campo `String` no banco,
 * sem coluna nova).
 */
const REGRA_DA_CAMPANHA = /^campanha:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const regraJaConversouSchema = z.union([
  z.enum(["hold", "skip", "retomada", "enviar"]),
  z.string().regex(REGRA_DA_CAMPANHA, "campanha inválida"),
]);
export type RegraJaConversou = "hold" | "skip" | "retomada" | "enviar" | `campanha:${string}`;

/** Id da campanha de uma regra `campanha:<id>`; null para as outras regras. */
export function campanhaDaRegra(regra: string): string | null {
  return REGRA_DA_CAMPANHA.test(regra) ? regra.slice("campanha:".length) : null;
}

export const etapaListaSchema = z
  .object({
    regraJaConversou: regraJaConversouSchema.optional(),
    diasSemCampanha: z.number().int().min(0).max(365).optional(),
  })
  .strict();

export const etapaMensagemSchema = z
  .object({
    mensagem: textoDeMensagem,
    variacoes: z.array(textoDeMensagem).max(5, "no máximo 5 variações").optional(),
    textoRetomada: textoDeMensagem.nullish(),
  })
  .strict();

/**
 * Ritmo. Os PADRÕES vêm do banco (decisão 7 do plano, confirmado pelo dono em
 * 27/09: 60–180 s, lote 20, pausa 15–25 min, 08:30–11:30 / 13:30–17:30);
 * aqui só os limites de segurança: intervalo mínimo de 30 s entre mensagens e
 * lote de no máximo 50 — abaixo disso é rajada, com qualquer aquecimento.
 */
export const etapaRitmoSchema = z
  .object({
    channelAccountId: z.string().uuid(),
    flowId: z.string().uuid().nullish(),
    limiteDiario: z.number().int().min(1).max(1000).nullish(),
    janelaInicio: hora,
    janelaFim: hora,
    pausaAlmocoInicio: hora.nullish(),
    pausaAlmocoFim: hora.nullish(),
    intervaloMinS: z.number().int().min(30).max(3600),
    intervaloMaxS: z.number().int().min(30).max(3600),
    loteTamanho: z.number().int().min(1).max(50),
    pausaLoteMinM: z.number().int().min(1).max(240),
    pausaLoteMaxM: z.number().int().min(1).max(240),
    freioSaidasPct: z.number().int().min(1).max(50),
    freioFalhasSeq: z.number().int().min(1).max(50),
    iniciaEm: z.coerce.date().nullish(),
  })
  .strict()
  .refine((r) => minutosDe(r.janelaInicio) < minutosDe(r.janelaFim), {
    message: "a janela precisa começar antes de terminar",
    path: ["janelaFim"],
  })
  .refine((r) => r.intervaloMinS <= r.intervaloMaxS, { message: "intervalo mínimo maior que o máximo", path: ["intervaloMaxS"] })
  .refine((r) => r.pausaLoteMinM <= r.pausaLoteMaxM, { message: "pausa mínima maior que a máxima", path: ["pausaLoteMaxM"] })
  .refine((r) => !r.pausaAlmocoInicio === !r.pausaAlmocoFim, {
    message: "pausa do almoço precisa de início e fim",
    path: ["pausaAlmocoFim"],
  })
  .refine(
    (r) =>
      !r.pausaAlmocoInicio ||
      !r.pausaAlmocoFim ||
      (minutosDe(r.janelaInicio) < minutosDe(r.pausaAlmocoInicio) &&
        minutosDe(r.pausaAlmocoInicio) < minutosDe(r.pausaAlmocoFim) &&
        minutosDe(r.pausaAlmocoFim) < minutosDe(r.janelaFim)),
    { message: "a pausa do almoço precisa ficar dentro da janela", path: ["pausaAlmocoInicio"] },
  );

export type EtapaLista = z.infer<typeof etapaListaSchema>;
export type EtapaMensagem = z.infer<typeof etapaMensagemSchema>;
export type EtapaRitmo = z.infer<typeof etapaRitmoSchema>;

export const nomeCampanhaSchema = z.string().trim().min(1, "nome obrigatório").max(120);

/** Origem da lista. Planilha: as linhas já lidas (a action usa o leitor da importação). */
export const origemListaSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("colados"),
    texto: z.string().max(200_000),
  }),
  z.object({
    tipo: z.literal("planilha"),
    arquivo: z.string().max(200).optional(),
    linhas: z
      .array(
        z.object({
          telefone: z.string().max(40),
          nome: z.string().max(120).optional(),
          empresa: z.string().max(120).optional(),
          cidade: z.string().max(80).optional(),
        }),
      )
      .max(5000, "no máximo 5000 linhas por campanha"),
  }),
  z.object({
    tipo: z.literal("filtro"),
    contactIds: z.array(z.string().uuid()).min(1).max(5000, "no máximo 5000 contatos por campanha"),
  }),
]);
export type OrigemLista = z.infer<typeof origemListaSchema>;
