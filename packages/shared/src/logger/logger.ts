import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  destination?: DestinationStream;
  level?: string;
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: { scope },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
}
