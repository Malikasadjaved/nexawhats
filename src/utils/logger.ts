import pino from 'pino';

/** Create a logger that writes to stderr (never stdout — MCP safe) */
export function createLogger(name = 'nexawhats', level = 'info'): pino.Logger {
  return pino({
    name,
    level,
    transport: {
      target: 'pino/file',
      options: { destination: 2 }, // fd 2 = stderr
    },
  });
}

/** Default logger instance */
export const defaultLogger = createLogger();

/** No-op logger for testing */
export const silentLogger = pino({ level: 'silent' });
