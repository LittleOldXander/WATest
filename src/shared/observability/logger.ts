import pino from 'pino';

/**
 * Narrow structured-logging port. Application and infrastructure code
 * depends on this interface only, never on pino directly, so the logging
 * backend can be swapped and tests can inject a silent collector.
 */
export interface Logger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
  debug(context: Record<string, unknown>, message: string): void;
}

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

/** Production/dev logger backed by pino (structured JSON, or pretty locally). */
export function createLogger({ level, pretty }: LoggerOptions): Logger {
  return pino({
    level,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: true } } }
      : {}),
  });
}

/** Dependency-free logger, handy for bootstrap paths and simple scripts. */
export const consoleLogger: Logger = {
  info: (context, message) => {
    console.info(message, context);
  },
  warn: (context, message) => {
    console.warn(message, context);
  },
  error: (context, message) => {
    console.error(message, context);
  },
  debug: (context, message) => {
    console.debug(message, context);
  },
};

/** No-op logger for unit tests that assert behavior rather than log output. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
