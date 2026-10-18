import pino, { type DestinationStream, type LevelWithSilent, type Logger } from "pino";

export type { Logger };
export type LogLevel = LevelWithSilent;

export interface CreateLoggerOptions {
  /** Service name included in every log line, e.g. "api". */
  service: string;
  level: LogLevel;
  /**
   * Optional destination stream. Defaults to process stdout. Tests pass a
   * PassThrough to capture output.
   */
  destination?: DestinationStream;
}

/**
 * Sensitive-key redaction. Phase 0 never handles real keys, but the redaction
 * list is a permanent safety net for future phases.
 */
const REDACT_PATHS = ["privateKey", "mnemonic", "seedPhrase", "password", "*.privateKey", "*.mnemonic", "*.seedPhrase", "*.password"];

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    options.destination,
  );
}
