import type { Middleware } from '../types.js';

/**
 * Middleware that adds human-like behavior to reduce ban risk.
 *
 * - Adds random delay before processing (1-3s, gaussian distribution)
 * - Simulates "reading" time proportional to message length
 */
export function antiBan(
  options: {
    /** Minimum delay in ms (default: 1000) */
    minDelay?: number;
    /** Maximum delay in ms (default: 3000) */
    maxDelay?: number;
    /** Add extra delay for longer messages (ms per 100 chars, default: 500) */
    readingTimePerChunk?: number;
  } = {},
): Middleware {
  const { minDelay = 1000, maxDelay = 3000, readingTimePerChunk = 500 } = options;

  return async (ctx, next) => {
    // Base delay — gaussian distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const mean = (minDelay + maxDelay) / 2;
    const stddev = (maxDelay - minDelay) / 4;
    const baseDelay = Math.max(minDelay, Math.min(maxDelay, mean + z * stddev));

    // Reading time based on message length
    const textLength = ctx.text?.length ?? 0;
    const readingTime = Math.floor(textLength / 100) * readingTimePerChunk;

    const totalDelay = baseDelay + readingTime;

    await new Promise((resolve) => setTimeout(resolve, totalDelay));
    await next();
  };
}
