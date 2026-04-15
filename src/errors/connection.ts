import { NexaWhatsErrorCode } from '../types/errors.js';

/** Base error class for NexaWhats */
export class NexaWhatsError extends Error {
  readonly code: NexaWhatsErrorCode;
  readonly isRetryable: boolean;

  constructor(message: string, code: NexaWhatsErrorCode, isRetryable = false) {
    super(message);
    this.name = 'NexaWhatsError';
    this.code = code;
    this.isRetryable = isRetryable;
  }
}

/** Connection-related errors */
export class ConnectionError extends NexaWhatsError {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number, isRetryable = true) {
    super(message, NexaWhatsErrorCode.CONNECTION_FAILED, isRetryable);
    this.name = 'ConnectionError';
    this.statusCode = statusCode;
  }
}

/** Rate limited by WhatsApp (405/463) */
export class RateLimitError extends NexaWhatsError {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs = 30000) {
    super(message, NexaWhatsErrorCode.RATE_LIMITED, true);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Account banned by WhatsApp (403) */
export class BannedError extends NexaWhatsError {
  constructor(message = 'This WhatsApp number has been banned') {
    super(message, NexaWhatsErrorCode.BANNED, false);
    this.name = 'BannedError';
  }
}

/** Session logged out (401) */
export class LoggedOutError extends NexaWhatsError {
  constructor(message = 'Session logged out — re-authentication required') {
    super(message, NexaWhatsErrorCode.LOGGED_OUT, false);
    this.name = 'LoggedOutError';
  }
}

/** Connection timeout */
export class ConnectionTimeoutError extends NexaWhatsError {
  constructor(timeoutMs: number) {
    super(`Connection timed out after ${timeoutMs}ms`, NexaWhatsErrorCode.CONNECTION_TIMEOUT, true);
    this.name = 'ConnectionTimeoutError';
  }
}

/** Circuit breaker is open — requests fail-fast */
export class CircuitBreakerOpenError extends NexaWhatsError {
  readonly cooldownRemainingMs: number;

  constructor(cooldownRemainingMs: number) {
    super(
      `Circuit breaker is open — retry in ${Math.ceil(cooldownRemainingMs / 1000)}s`,
      NexaWhatsErrorCode.CIRCUIT_BREAKER_OPEN,
      true,
    );
    this.name = 'CircuitBreakerOpenError';
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}
