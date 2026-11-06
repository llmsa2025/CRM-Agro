import pino from "pino";

/**
 * Logger singleton — logs estruturados JSON em produção, legível em dev.
 *
 * Em dev: pino-pretty (cores, níveis, timestamp legível).
 * Em prod: JSON puro (machine-readable, compatível com ELK/Datadog/etc).
 *
 * Nível configurável via LOG_LEVEL (default: info).
 * Usado por web, worker e packages core (via import direto).
 */

const isDev = process.env.NODE_ENV !== "production";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {
        // JSON estruturado em produção — sem transport (mais performático).
        formatters: {
          level: (label) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

export { logger };
export default logger;
