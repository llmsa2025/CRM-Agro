import type { Prisma, TeamConfig as TeamConfigRow } from "@prisma/client";
import { db, getCurrentTeamId, tenantData } from "@crmagro/db";
import { z } from "zod";
import { DEFAULT_TZ } from "./tz";
import type { BusinessHoursOptions } from "./business-hours";
import { requireCan } from "../auth/authz";

/**
 * Configuração de horário comercial e feriados do time (1:1 com Team).
 *
 * Faz o tráfego entre o `TeamConfig` do Prisma e as funções de `business-hours`.
 * Puro (só @crmagro/db): chama `db()` no início de cada função (leitura eager do
 * teamId via ALS — §12). teamId NUNCA é parâmetro manual; vem do contexto. Por
 * isso `getTeamConfig()`/`updateTeamConfig()` rodam DENTRO de `runWithTeam`.
 *
 * A row nasce opcional — só é criada quando o time salva uma config não-default;
 * ausência = `DEFAULT_TEAM_CONFIG` em runtime (não trava o discador).
 */

// ─── Schemas zod (uma fonte de verdade para bordas) ─────────────────────

/** "HH:mm" validado como horário de parede (00:00–23:59). */
const timeField = z
  .string()
  .trim()
  .regex(/^\d{2}:\d{2}$/, 'use o formato "HH:mm" (ex.: 08:00)')
  .refine((t) => {
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    if (!m) return false;
    return Number(m[1]) <= 23 && Number(m[2]) <= 59;
  }, "horário inválido");

/** Lista CSV de dias: "mon,tue,wed,thu,fri" (abreviações ISO em minúsculas). */
const daysField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(sun|mon|tue|wed|thu|fri|sat)(,(sun|mon|tue|wed|thu|fri|sat))*$/,
    "use abreviações separadas por vírgula (ex.: mon,tue,wed,thu,fri)",
  );

/** Lista fusos válidos via Intl supportedValuesOf (Node 18+); fallback leniente. */
const VALID_TZ = new Set(
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : [],
);
function isValidTimezone(tz: string): boolean {
  if (VALID_TZ.size === 0) return tz.trim().length > 0; // ambiente sem a API
  return VALID_TZ.has(tz.trim());
}
const timezoneField = z.string().trim().refine(isValidTimezone, "fuso inválido");

function toMinutes(t: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** Schema completo da config (GET/seed). O tipo é a fonte de verdade do DTO. */
export const teamConfigSchema = z
  .object({
    respectBusinessHours: z.boolean(),
    businessHourStart: timeField,
    businessHourEnd: timeField,
    businessDays: daysField,
    respectHolidays: z.boolean(),
    timezone: timezoneField,
  })
  .superRefine((v, ctx) => {
    if (toMinutes(v.businessHourStart) >= toMinutes(v.businessHourEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessHourEnd"],
        message: "fechamento deve ser depois da abertura",
      });
    }
  });

/** Schema de atualização (PUT): todos os campos opcionais; regras cross-field
 * só rodam quando ambos os horários vierem juntos. */
export const teamConfigUpdateSchema = z
  .object({
    respectBusinessHours: z.boolean().optional(),
    businessHourStart: timeField.optional(),
    businessHourEnd: timeField.optional(),
    businessDays: daysField.optional(),
    respectHolidays: z.boolean().optional(),
    timezone: timezoneField.optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.businessHourStart != null &&
      v.businessHourEnd != null &&
      toMinutes(v.businessHourStart) >= toMinutes(v.businessHourEnd)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessHourEnd"],
        message: "fechamento deve ser depois da abertura",
      });
    }
  });

export type TeamConfigDTO = z.infer<typeof teamConfigSchema>;
export type UpdateTeamConfigInput = z.infer<typeof teamConfigUpdateSchema>;

// ─── Defaults e mapeamento ──────────────────────────────────────────────

/** Defaults do TeamConfig quando não há row no banco (espelha schema.prisma). */
export const DEFAULT_TEAM_CONFIG: TeamConfigDTO = {
  respectBusinessHours: false,
  businessHourStart: "08:00",
  businessHourEnd: "18:00",
  businessDays: "mon,tue,wed,thu,fri",
  respectHolidays: true,
  timezone: DEFAULT_TZ,
};

/** Row do Prisma → DTO (só os campos de domínio; id/timestamps ficam de fora). */
function toDTO(row: TeamConfigRow): TeamConfigDTO {
  return {
    respectBusinessHours: row.respectBusinessHours,
    businessHourStart: row.businessHourStart,
    businessHourEnd: row.businessHourEnd,
    businessDays: row.businessDays,
    respectHolidays: row.respectHolidays,
    timezone: row.timezone,
  };
}

/** Converte o DTO de config nas opções consumidas por `business-hours`. */
export function toBusinessHoursOptions(cfg: TeamConfigDTO): BusinessHoursOptions {
  return {
    timeZone: cfg.timezone,
    respectBusinessHours: cfg.respectBusinessHours,
    businessHourStart: cfg.businessHourStart,
    businessHourEnd: cfg.businessHourEnd,
    businessDays: cfg.businessDays,
    respectHolidays: cfg.respectHolidays,
  };
}

// ─── Serviços ───────────────────────────────────────────────────────────

/**
 * Cache da config por time (item 1.3): o motor consulta a config a CADA envio
 * (janela + fuso da cota). 5 min por processo; salvar a config limpa o cache
 * deste processo (os outros pegam em até 5 min).
 */
const CACHE_CONFIG_MS = 5 * 60_000;
const cacheConfig = new Map<string, { cfg: TeamConfigDTO; ate: number }>();

export async function getTeamConfigComCache(agora = Date.now()): Promise<TeamConfigDTO> {
  const teamId = getCurrentTeamId() ?? "";
  const hit = cacheConfig.get(teamId);
  if (hit && hit.ate > agora) return hit.cfg;
  const cfg = await getTeamConfig();
  cacheConfig.set(teamId, { cfg, ate: agora + CACHE_CONFIG_MS });
  return cfg;
}

/**
 * Lê a config do time (ou defaults se a row não existir). A extensão de tenancy
 * injeta `teamId` no `where` do findFirst — não há teamId manual aqui.
 */
export async function getTeamConfig(): Promise<TeamConfigDTO> {
  const prisma = db();
  const row = await prisma.teamConfig.findFirst();
  return row ? toDTO(row) : { ...DEFAULT_TEAM_CONFIG };
}

/**
 * Atualiza (ou cria) a config do time. Aceita campos parciais; valores omitidos
 * preservam o que já está salvo (ou os defaults do banco numa row nova). Valida
 * o input com `teamConfigUpdateSchema` e devolve a config resultante.
 */
export async function updateTeamConfig(input: UpdateTeamConfigInput): Promise<TeamConfigDTO> {
  requireCan("settings.businessHours");
  const prisma = db();
  const data = teamConfigUpdateSchema.parse(input);
  cacheConfig.delete(getCurrentTeamId() ?? "");

  // Upsert por time: findFirst (where teamId injetado) decide update vs create.
  const existing = await prisma.teamConfig.findFirst();
  if (existing) {
    const updated = await prisma.teamConfig.update({
      where: { id: existing.id },
      data,
    });
    return toDTO(updated);
  }

  const created = await prisma.teamConfig.create({
    data: tenantData<Prisma.TeamConfigUncheckedCreateInput>(data),
  });
  return toDTO(created);
}
