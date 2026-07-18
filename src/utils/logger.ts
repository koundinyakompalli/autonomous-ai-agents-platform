import { pino, type Logger as PinoLogger } from "pino";
import { config } from "../config/index.js";
import { specFactoryCorrelationLogFields } from "../spec-factory/telemetry/correlation.js";

// Create the logger instance
const rawLogger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  base: {
    service: "specter",
  },
  mixin: specFactoryCorrelationLogFields,
});

export const logger = rawLogger;

// Create child loggers for different modules
export const createLogger = (module: string) => {
  return rawLogger.child({ module });
};

// Export typed logger
export type Logger = PinoLogger;
