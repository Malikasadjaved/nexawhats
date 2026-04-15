import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../../../src/socket/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({
      failureThreshold: 3,
      failureWindow: 60000,
      cooldownMs: 100, // short for testing
      maxCooldownMs: 500,
    });
  });

  it('should start in closed state', () => {
    expect(cb.state).toBe('closed');
    expect(cb.isAllowed).toBe(true);
  });

  describe('failure tracking', () => {
    it('should stay closed below threshold', () => {
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('closed');
      expect(cb.isAllowed).toBe(true);
    });

    it('should trip to open at threshold', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('open');
      expect(cb.isAllowed).toBe(false);
    });
  });

  describe('cooldown', () => {
    it('should transition to half-open after cooldown', async () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('open');

      await new Promise((r) => setTimeout(r, 150));
      expect(cb.state).toBe('half-open');
      expect(cb.isAllowed).toBe(true);
    });

    it('should report cooldown remaining', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.cooldownRemainingMs).toBeGreaterThan(0);
      expect(cb.cooldownRemainingMs).toBeLessThanOrEqual(100);
    });
  });

  describe('recovery', () => {
    it('should reset to closed on success', () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess();
      expect(cb.state).toBe('closed');
    });

    it('should return to open from half-open on failure', async () => {
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      await new Promise((r) => setTimeout(r, 150));
      expect(cb.state).toBe('half-open');

      cb.recordFailure();
      expect(cb.state).toBe('open');
    });
  });

  describe('cooldown escalation', () => {
    it('should double cooldown on consecutive trips', async () => {
      // First trip
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe('open');

      // Wait for half-open
      await new Promise((r) => setTimeout(r, 150));
      expect(cb.state).toBe('half-open');

      // Fail again → trip with doubled cooldown
      cb.recordFailure();
      expect(cb.state).toBe('open');

      // Cooldown should be ~200ms now (doubled from 100)
      await new Promise((r) => setTimeout(r, 110));
      expect(cb.state).toBe('open'); // still open — 200ms cooldown
      await new Promise((r) => setTimeout(r, 110));
      expect(cb.state).toBe('half-open'); // now half-open after ~220ms
    });
  });

  describe('events', () => {
    it('should emit state-change events', () => {
      const listener = vi.fn();
      cb.on('state-change', listener);

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(listener).toHaveBeenCalledWith({ from: 'closed', to: 'open' });
    });
  });

  describe('manual control', () => {
    it('trip() should open immediately', () => {
      cb.trip();
      expect(cb.state).toBe('open');
    });

    it('reset() should return to closed', () => {
      cb.trip();
      cb.reset();
      expect(cb.state).toBe('closed');
    });
  });
});
