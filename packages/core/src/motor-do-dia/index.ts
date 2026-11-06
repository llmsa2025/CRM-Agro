// @crmagro/core — motor do dia (metodologia comercial virada em número).
// Feriados BR, horário comercial e orçamento/priorização de toques (AGENTS.md §8).
export { type BusinessHoursOptions, isBusinessHour, canCallNow, getNextCallSlot as getNextBusinessHourSlot } from "./business-hours";
export * from "./holidays";
export * from "./touch-budget";
// Config de horário comercial/feriados do time (configurável via TeamConfig).
export {
  teamConfigSchema,
  teamConfigUpdateSchema,
  toBusinessHoursOptions,
  getTeamConfig,
  updateTeamConfig,
  DEFAULT_TEAM_CONFIG,
  type TeamConfigDTO,
  type UpdateTeamConfigInput,
} from "./team-config";
// Primitivos de fuso expostos para alongside modules (ex.: discador) reaproveitarem
// a mesma noção de "dia de parede" sem reimplementar conversão UTC↔zoned.
export { DEFAULT_TZ, zonedParts, zonedTimeToUtc } from "./tz";
