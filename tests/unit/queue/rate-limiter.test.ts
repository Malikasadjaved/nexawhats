import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/queue/rate-limiter.js';

describe('RateLimiter', () => {
  it('should allow initial burst up to max tokens', () => {
    const limiter = new RateLimiter({ messagesPerMinute: 5, humanLikeTiming: false });
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire()).toBe(true);
    }
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('should report available tokens', () => {
    const limiter = new RateLimiter({ messagesPerMinute: 10, humanLikeTiming: false });
    expect(limiter.availableTokens).toBe(10);
    limiter.tryAcquire();
    expect(limiter.availableTokens).toBe(9);
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 60, humanLikeTiming: false });
    // Drain all tokens
    for (let i = 0; i < 60; i++) limiter.tryAcquire();
    expect(limiter.availableTokens).toBe(0);

    // Wait 1 second — should get ~1 token back (60/min = 1/sec)
    await new Promise((r) => setTimeout(r, 1100));
    expect(limiter.availableTokens).toBeGreaterThanOrEqual(1);
  });

  it('should not exceed max tokens after long idle', async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 5, humanLikeTiming: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(limiter.availableTokens).toBeLessThanOrEqual(5);
  });

  it('canAcquire should not consume token', () => {
    const limiter = new RateLimiter({ messagesPerMinute: 1, humanLikeTiming: false });
    expect(limiter.canAcquire()).toBe(true);
    expect(limiter.canAcquire()).toBe(true);
    expect(limiter.availableTokens).toBe(1);
  });

  it('should report time until available when drained', () => {
    const limiter = new RateLimiter({ messagesPerMinute: 60, humanLikeTiming: false });
    for (let i = 0; i < 60; i++) limiter.tryAcquire();
    const wait = limiter.timeUntilAvailable();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1100);
  });

  it('acquire should wait and then succeed', async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 60, humanLikeTiming: false });
    for (let i = 0; i < 60; i++) limiter.tryAcquire();

    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(500);
  }, 5000);

  it('acquire should reject on abort', async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 1, humanLikeTiming: false });
    limiter.tryAcquire();

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(limiter.acquire(controller.signal)).rejects.toThrow();
  });
});
