import { z } from "zod";

/**
 * A MATRIZ DE CAPACIDADES de cada provedor de ligação.
 *
 * É um dado ESTÁTICO, versionado no código e revisado na ficha de cada adaptador. O núcleo de prova consulta
 * a matriz antes de agir e nunca assume que um provedor sabe fazer algo.
 *
 * Regra do plano: "n/c" (não confirmado) NÃO vale. O adaptador diz sim ou não. Na dúvida, `false`.
 */

/** Chave do provedor de ligação (`api4com`, `whatsapp_cloud`). */
export const ChaveDeProvedorDeLigacaoSchema = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, "Chave de provedor inválida.");
export type ChaveDeProvedorDeLigacao = z.infer<typeof ChaveDeProvedorDeLigacaoSchema>;

/** Como o vendedor liga: pelo navegador (webphone) ou por uma ponte (o provedor liga para o celular dele). */
export const MODOS_DE_ORIGINAR_DE_LIGACAO = ["navegador", "ponte"] as const;
export type ModoDeOriginarDeLigacao = (typeof MODOS_DE_ORIGINAR_DE_LIGACAO)[number];

/** O CRM Agro cria conta e linha, só a linha, ou o dono cadastra à mão. */
export const MODOS_DE_PROVISIONAMENTO_DE_LIGACAO = ["conta_e_linha", "linha", "manual"] as const;
export type ModoDeProvisionamentoDeLigacao = (typeof MODOS_DE_PROVISIONAMENTO_DE_LIGACAO)[number];

/** Por onde o aviso da gravação pronta chega: webhook, consulta ou nunca. */
export const ENTREGAS_DE_GRAVACAO_DE_LIGACAO = ["webhook", "consulta", "nenhuma"] as const;
export type EntregaDeGravacaoDeLigacao = (typeof ENTREGAS_DE_GRAVACAO_DE_LIGACAO)[number];

/** Quem avisa as pessoas na linha de que a ligação está sendo gravada. */
export const AVISOS_DE_GRAVACAO_DE_LIGACAO = ["provedor", "crmagro", "nenhum"] as const;
export type AvisoDeGravacaoDeLigacao = (typeof AVISOS_DE_GRAVACAO_DE_LIGACAO)[number];

/**
 * Como o aviso do provedor prova a origem: URL assinada por nós (o segredo vai no endereço cadastrado no
 * provedor) ou assinatura que o próprio provedor calcula (HMAC, por exemplo).
 */
export const MODOS_DE_WEBHOOK_DE_LIGACAO = ["url_assinada", "assinatura_do_provedor"] as const;
export type ModoDeWebhookDeLigacao = (typeof MODOS_DE_WEBHOOK_DE_LIGACAO)[number];

export const CapacidadesDeLigacaoSchema = z
  .object({
    /** Os modos de ligar que o adaptador faz. Ao menos um, sem repetir. */
    originar: z.array(z.enum(MODOS_DE_ORIGINAR_DE_LIGACAO)).min(1),
    /** O provedor pede o destino na hora, por uma resposta síncrona (Twilio). Exige o modo "navegador". */
    originacaoSincrona: z.boolean(),
    provisionarLinha: z.enum(MODOS_DE_PROVISIONAMENTO_DE_LIGACAO),
    consulta: z
      .object({
        /** Dá para perguntar ao provedor como uma ligação terminou. */
        porId: z.boolean(),
        /** Teto de consultas por minuto, quando o provedor limita. Nulo sem consulta. */
        porMinuto: z.number().int().positive().nullable(),
        /** A consulta diz se e quando a ligação foi atendida. */
        trazAtendimento: z.boolean(),
      })
      .strict(),
    /** A causa do fim que o provedor informa é confiável o bastante para virar desfecho. */
    causaDoFimGarantida: z.boolean(),
    /** A duração informada conta só a partir do atendimento (e não desde o toque). */
    duracaoDesdeAtendimento: z.boolean(),
    /** O provedor avisa "chamando" e "atendida" enquanto a ligação acontece, e não só o fim. */
    eventosAoVivo: z.boolean(),
    /** O aviso traz o número de destino e/ou a origem, para o CRM Agro conferir com a ligação gravada. */
    pontasNoAviso: z.object({ destino: z.boolean(), origem: z.boolean() }).strict(),
    gravacao: z
      .object({
        entrega: z.enum(ENTREGAS_DE_GRAVACAO_DE_LIGACAO),
        /** Quantas horas o provedor guarda o arquivo. Nulo quando não há prazo declarado. */
        prazoHoras: z.number().int().positive().nullable(),
        aviso: z.enum(AVISOS_DE_GRAVACAO_DE_LIGACAO),
        /** O CRM Agro consegue mandar apagar o arquivo no provedor. */
        apagavel: z.boolean(),
      })
      .strict(),
    /** Liga para quem nunca falou com a empresa (a telefonia liga; o WhatsApp oficial não). */
    ligaAFrio: z.boolean(),
    webhook: z.enum(MODOS_DE_WEBHOOK_DE_LIGACAO),
    sandbox: z.boolean(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const erro = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (new Set(c.originar).size !== c.originar.length) erro(["originar"], "Modos de ligar repetidos.");

    if (!c.consulta.porId) {
      if (c.consulta.porMinuto !== null) erro(["consulta", "porMinuto"], "Sem consulta por id não há limite de consultas por minuto.");
      if (c.consulta.trazAtendimento) erro(["consulta", "trazAtendimento"], "Sem consulta por id a consulta não traz o atendimento.");
    }

    // Sem gravação, não há aviso, prazo nem o que apagar. E, ao contrário, aviso nenhum com prazo nulo e nada
    // a apagar é a mesma coisa que não ter gravação.
    const g = c.gravacao;
    const semNada = g.aviso === "nenhum" && g.prazoHoras === null && !g.apagavel;
    if (g.entrega === "nenhuma" && !semNada) {
      erro(["gravacao"], "Sem entrega de gravação, o aviso é nenhum, o prazo é nulo e não há o que apagar.");
    }
    if (g.entrega !== "nenhuma" && semNada) {
      erro(["gravacao"], "Gravação entregue precisa de aviso, de prazo ou de como apagar. Senão a entrega é nenhuma.");
    }

    if (c.originacaoSincrona && !c.originar.includes("navegador")) {
      erro(["originacaoSincrona"], "Originação síncrona exige o modo navegador.");
    }
  });

export type CapacidadesDeLigacao = z.infer<typeof CapacidadesDeLigacaoSchema>;

/** Valida e congela uma matriz. Lança `ZodError` (texto sem valores) se for incoerente. */
export function definirCapacidadesDeLigacao(c: CapacidadesDeLigacao): Readonly<CapacidadesDeLigacao> {
  const ok = CapacidadesDeLigacaoSchema.parse(c);
  return Object.freeze({
    ...ok,
    originar: Object.freeze([...ok.originar]) as ModoDeOriginarDeLigacao[],
    consulta: Object.freeze({ ...ok.consulta }),
    pontasNoAviso: Object.freeze({ ...ok.pontasNoAviso }),
    gravacao: Object.freeze({ ...ok.gravacao }),
  });
}

/** As capacidades booleanas simples (as que a suíte confere uma a uma). */
export const CAPACIDADES_BOOLEANAS_DE_LIGACAO = [
  "originacaoSincrona",
  "causaDoFimGarantida",
  "duracaoDesdeAtendimento",
  "eventosAoVivo",
  "ligaAFrio",
  "sandbox",
] as const satisfies readonly (keyof CapacidadesDeLigacao)[];
export type CapacidadeBooleanaDeLigacao = (typeof CAPACIDADES_BOOLEANAS_DE_LIGACAO)[number];
