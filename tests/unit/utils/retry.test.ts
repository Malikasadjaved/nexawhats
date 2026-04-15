import { describe, expect, it, vi } from 'vitest';
import { calculateBackoff, retry, sleep } from '../../../src/utils/retry.js';

describe('calculateBackoff', () => {
  it('should return base delay for attempt 0', () => {
    const delay = calculateBackoff(0, { baseDelay: 1000, multiplier: 2, jitter: false });
    expect(delay).toBe(1000);
  });

  it('should double on each attempt', () => {
    const delay1 = calculateBackoff(1, { baseDelay: 1000, multiplier: 2, jitter: false });
    const delay2 = calculateBackoff(2, { baseDelay: 1000, multiplier: 2, jitter: false });
    expect(delay1).toBe(2000);
    expect(delay2).toBe(4000);
  });

  it('should cap at maxDelay', () => {
    const delay = calculateBackoff(10, {
      baseDelay: 1000,
      multiplier: 2,
      maxDelay: 5000,
      jitter: false,
    });
    expect(delay).toBe(5000);
  });

  it('should add jitter when enabled', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(calculateBackoff(0, { baseDelay: 1000, multiplier: 2, jitter: true }));
    }
    // With jitter, we should get varied delays
    expect(delays.size).toBeGreaterThan(1);
  });

  it('should produce delays between 50-100% of base when jittered', () => {
    for (let i = 0; i < 50; i++) {
      const delay = calculateBackoff(0, { baseDelay: 1000, multiplier: 2, jitter: true });
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });
});

describe('sleep', () => {
  it('should resolve after the given duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('should reject when abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toThrow();
  });

  it('should reject when abort signal fires during sleep', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(sleep(5000, controller.signal)).rejects.toThrow();
  });
});

describe('retry', () => {
  it('should succeed on first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, { maxAttempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');
    const result = await retry(fn, { maxAttempts: 3, baseDelay: 10, jitter: false });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw after max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(retry(fn, { maxAttempts: 3, baseDelay: 10, jitter: false })).rejects.toThrow(
      'always fails',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should respect shouldRetry predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(
      retry(fn, {
        maxAttempts: 5,
        baseDelay: 10,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should pass attempt number to the function', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');
    await retry(fn, { maxAttempts: 3, baseDelay: 10, jitter: false });
    expect(fn).toHaveBeenCalledWith(0);
    expect(fn).toHaveBeenCalledWith(1);
  });
});
