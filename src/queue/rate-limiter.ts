/**
 * Token bucket rate limiter with optional human-like timing.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private readonly humanLikeTiming: boolean;

  constructor(
    options: {
      /** Messages per minute (default: 20) */
      messagesPerMinute?: number;
      /** Enable gaussian jitter between messages (default: true) */
      humanLikeTiming?: boolean;
    } = {},
  ) {
    this.maxTokens = options.messagesPerMinute ?? 20;
    this.tokens = this.maxTokens;
    this.refillRate = this.maxTokens / 60000; // tokens per ms
    this.lastRefill = Date.now();
    this.humanLikeTiming = options.humanLikeTiming ?? true;
  }

  /** Refill tokens based on elapsed time */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /** Check if a token is available (does not consume) */
  canAcquire(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  /** Try to acquire a token. Returns true if acquired. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait until a token is available, then acquire it */
  async acquire(signal?: AbortSignal): Promise<void> {
    while (!this.tryAcquire()) {
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');

      // Wait for one token to refill
      const waitMs = Math.ceil(1 / this.refillRate);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(waitMs, 1000));
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

    // Add human-like delay after acquiring
    if (this.humanLikeTiming) {
      const delay = this.gaussianDelay(2500, 800);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
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
  }

  /** Time until next token is available (ms) */
  timeUntilAvailable(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  /** Current token count */
  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Generate a gaussian-distributed delay for human-like timing.
   * Uses Box-Muller transform.
   */
  private gaussianDelay(mean: number, stddev: number): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const delay = mean + z * stddev;
    // Clamp between 500ms and 5000ms
    return Math.max(500, Math.min(5000, delay));
  }
}
