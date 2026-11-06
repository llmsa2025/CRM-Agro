import { z } from "zod";

/**
 * Horário de envio POR FLUXO (guardado em `Flow.triggerConfig.janelaEnvio`).
 *
 * Quem decide quando um passo automático pode falar com uma pessoa (mensagem, e-mail, DM, agente) é o
 * PRÓPRIO fluxo, não só a configuração da empresa. Três modos:
 *
 * - `empresa` (padrão, e o que vale para fluxo sem nada salvo): segue a configuração da empresa. Com
 *   "Respeitar horário comercial" desligado lá, o fluxo envia a qualquer hora; ligado, só nos dias e horas
 *   da empresa (e fora dos feriados, se a empresa pede).
 * - `livre`: este fluxo envia a qualquer hora, seja qual for a configuração da empresa.
 * - `propria`: este fluxo tem os próprios dias, horas e feriados. O fuso continua o da empresa.
 *
 * Antes desta mudança o motor ignorava o botão "Respeitar horário comercial" e sempre segurava o envio fora
 * de segunda a sexta, 8h às 18h, o que contradizia o texto da tela ("Desligado, prospecta a qualquer hora").
 */

export const DIAS_DA_SEMANA = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DiaDaSemana = (typeof DIAS_DA_SEMANA)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use o formato "HH:mm" (ex.: 08:00)');
const minutos = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const janelaEnvioSchema = z
  .discriminatedUnion("modo", [
    z.object({ modo: z.literal("empresa") }),
    z.object({ modo: z.literal("livre") }),
    z.object({
      modo: z.literal("propria"),
      abertura: hhmm,
      fechamento: hhmm,
      dias: z.array(z.enum(DIAS_DA_SEMANA)).min(1, "marque ao menos um dia").max(7),
      feriados: z.boolean(),
    }),
  ])
  .superRefine((j, ctx) => {
    if (j.modo === "propria" && minutos(j.abertura) >= minutos(j.fechamento)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "o fechamento deve ser depois da abertura", path: ["fechamento"] });
    }
  });
export type JanelaEnvio = z.infer<typeof janelaEnvioSchema>;

/** Fluxo sem nada salvo, ou com valor que não vale: segue a empresa. */
export const JANELA_DA_EMPRESA: JanelaEnvio = { modo: "empresa" };

/** Padrão ao escolher "personalizado" no editor: seg a sex, 08:00 às 18:00, sem feriados. */
export const JANELA_PROPRIA_PADRAO: Extract<JanelaEnvio, { modo: "propria" }> = {
  modo: "propria",
  abertura: "08:00",
  fechamento: "18:00",
  dias: ["mon", "tue", "wed", "thu", "fri"],
  feriados: true,
};

/**
 * Lê o horário de envio do `triggerConfig` do fluxo. Tolerante: ausente ou inválido vira `empresa` (o motor
 * nunca quebra por causa de um valor torto, e o fluxo segue com o horário da empresa).
 */
export function lerJanelaEnvio(triggerConfig: unknown): JanelaEnvio {
  if (!triggerConfig || typeof triggerConfig !== "object") return JANELA_DA_EMPRESA;
  const bruto = (triggerConfig as { janelaEnvio?: unknown }).janelaEnvio;
  const r = janelaEnvioSchema.safeParse(bruto);
  return r.success ? r.data : JANELA_DA_EMPRESA;
}

const NOME_DOS_DIAS: Record<DiaDaSemana, string> = {
  sun: "dom",
  mon: "seg",
  tue: "ter",
  wed: "qua",
  thu: "qui",
  fri: "sex",
  sat: "sáb",
};

/** "seg a sex", "seg, qua e sex" ou "todos os dias": para mostrar no editor. */
export function resumoDosDias(dias: readonly string[]): string {
  const ordem = DIAS_DA_SEMANA.filter((d) => dias.includes(d));
  if (ordem.length === 0) return "nenhum dia";
  if (ordem.length === 7) return "todos os dias";
  const indices = ordem.map((d) => DIAS_DA_SEMANA.indexOf(d));
  const seguidos = indices.every((n, i) => i === 0 || n === indices[i - 1]! + 1);
  if (seguidos && ordem.length >= 3) return `${NOME_DOS_DIAS[ordem[0]!]} a ${NOME_DOS_DIAS[ordem[ordem.length - 1]!]}`;
  const nomes = ordem.map((d) => NOME_DOS_DIAS[d]);
  return nomes.length === 1 ? nomes[0]! : `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}

/** Linha de texto do horário da empresa, para o editor mostrar o que "seguir a empresa" significa hoje. */
export function resumoDoHorarioDaEmpresa(cfg: {
  respectBusinessHours: boolean;
  businessHourStart: string;
  businessHourEnd: string;
  businessDays: string;
  respectHolidays: boolean;
}): string {
  if (!cfg.respectBusinessHours) return "sem restrição de horário (o horário comercial da empresa está desativado)";
  const dias = resumoDosDias(cfg.businessDays.split(",").map((d) => d.trim()));
  return `${dias}, das ${cfg.businessHourStart} às ${cfg.businessHourEnd}${cfg.respectHolidays ? ", sem feriados" : ""}`;
}
