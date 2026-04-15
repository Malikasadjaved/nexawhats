import { EventEmitter } from 'node:events';
import type { CircuitBreakerConfig, CircuitBreakerState } from '../types/socket.js';

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  failureWindow: 60000,
  cooldownMs: 30000,
  maxCooldownMs: 300000,
};

/**
 * Circuit breaker for connection management.
 *
 * - **Closed** (normal): requests flow through
 * - **Open** (tripped): all requests fail-fast for cooldown period
 * - **Half-Open** (probing): allow one request to test recovery
 *
 * Trips on consecutive 405/463 rate-limit errors.
 * Resets on successful connection.
 */
export class CircuitBreaker extends EventEmitter {
  private _state: CircuitBreakerState = 'closed';
  private failures: number[] = [];
  private cooldownMs: number;
  private openedAt = 0;
  private consecutiveTrips = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cooldownMs = this.config.cooldownMs;
  }

  /** Current state */
  get state(): CircuitBreakerState {
    // Auto-transition from open → half-open after cooldown
    if (this._state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.transitionTo('half-open');
    }
    return this._state;
  }

  /** Whether requests should be allowed through */
  get isAllowed(): boolean {
    const current = this.state; // triggers auto-transition check
    return current === 'closed' || current === 'half-open';
  }

  /** Time remaining in cooldown (0 if not open) */
  get cooldownRemainingMs(): number {
    if (this._state !== 'open') return 0;
    const remaining = this.cooldownMs - (Date.now() - this.openedAt);
    return Math.max(0, remaining);
  }

  /** Record a failure (e.g., 405/463 error) */
  recordFailure(): void {
    const now = Date.now();

    // Remove failures outside the window
    this.failures = this.failures.filter((t) => now - t < this.config.failureWindow);

    this.failures.push(now);

    if (this._state === 'half-open') {
      // Any failure in half-open → back to open
      this.trip();
      return;
    }

    if (this.failures.length >= this.config.failureThreshold) {
      this.trip();
    }
  }

  /** Record a success — resets the circuit breaker */
  recordSuccess(): void {
    this.failures = [];
    this.consecutiveTrips = 0;
    this.cooldownMs = this.config.cooldownMs;

    if (this._state !== 'closed') {
      this.transitionTo('closed');
    }
  }

  /** Manually trip the circuit breaker */
  trip(): void {
    this.consecutiveTrips++;
    // Double cooldown on each consecutive trip (capped)
    this.cooldownMs = Math.min(
      this.config.cooldownMs * 2 ** (this.consecutiveTrips - 1),
      this.config.maxCooldownMs,
    );
    this.openedAt = Date.now();
    this.transitionTo('open');
  }

  /** Reset to closed state */
  reset(): void {
    this.failures = [];
    this.consecutiveTrips = 0;
    this.cooldownMs = this.config.cooldownMs;
    this.transitionTo('closed');
  }

  private transitionTo(newState: CircuitBreakerState): void {
    const from = this._state;
    if (from === newState) return;
    this._state = newState;
    this.emit('state-change', { from, to: newState });
  }
}
