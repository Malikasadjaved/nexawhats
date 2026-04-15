import type { Middleware } from '../types.js';

/**
 * Middleware that logs message processing lifecycle.
 */
export function messageLogger(
  logFn: (
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ) => void = defaultLog,
): Middleware {
  return async (ctx, next) => {
    const start = Date.now();
    const preview = ctx.text ? ctx.text.slice(0, 50) : '(media/other)';

    logFn('info', `[IN] ${ctx.jid}: ${preview}`, {
      jid: ctx.jid,
      isGroup: ctx.isGroup,
      senderName: ctx.senderName,
      messageId: ctx.message.key.id ?? undefined,
    });

    try {
      await next();

      const elapsed = Date.now() - start;
      logFn('info', `[OK] ${ctx.jid}: processed in ${elapsed}ms`, {
        jid: ctx.jid,
        elapsed,
      });
    } catch (error) {
      const elapsed = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      logFn('error', `[ERR] ${ctx.jid}: ${message} (${elapsed}ms)`, {
        jid: ctx.jid,
        elapsed,
        error: message,
      });
      throw error;
    }
  };
}

function defaultLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  _data?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}
