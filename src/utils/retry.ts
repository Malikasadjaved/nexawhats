/** Options for retry with exponential backoff */
export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts: number;
  /** Base delay in ms (default: 1000) */
  baseDelay: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelay: number;
  /** Multiplier for each retry (default: 2) */
  multiplier: number;
  /** Add random jitter (default: true) */
  jitter: boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Predicate — should we retry this error? (default: always retry) */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  jitter: true,
};

/** Calculate delay for a given attempt */
export function calculateBackoff(attempt: number, options: Partial<RetryOptions> = {}): number {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const delay = Math.min(opts.baseDelay * opts.multiplier ** attempt, opts.maxDelay);
  if (opts.jitter) {
    return delay * (0.5 + Math.random() * 0.5);
  }
  return delay;
}

/** Sleep for a given duration, respecting abort signal */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Retry an async operation with exponential backoff.
 *
 * @example
 * const result = await retry(
 *   () => fetchSomething(),
 *   { maxAttempts: 3, baseDelay: 1000 }
 * );
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === opts.maxAttempts - 1) break;
      if (opts.shouldRetry && !opts.shouldRetry(lastError, attempt)) break;

      const delay = calculateBackoff(attempt, opts);
      await sleep(delay, opts.signal);
    }
  }

  throw lastError;
}
