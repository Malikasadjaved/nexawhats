import type { AuthenticationState } from './auth.js';

/** Connection states */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** Connection state update */
export interface ConnectionState {
  connection: ConnectionStatus;
  lastDisconnect?: {
    error: Error;
    date: Date;
  };
  isNewLogin?: boolean;
  qr?: string;
  receivedPendingNotifications?: boolean;
  isOnline?: boolean;
}

/** WhatsApp Web version tuple */
export type WAVersion = [number, number, number];

/** Browser description for fingerprinting */
export type WABrowserDescription = [string, string, string];

/** Circuit breaker states */
export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

/** Reconnection strategy */
export interface ReconnectConfig {
  /** Maximum number of reconnection attempts (default: 10) */
  maxRetries: number;
  /** Backoff delays in ms (default: [1000, 2000, 4000, 8000, 16000, 30000]) */
  backoffDelays: number[];
  /** Maximum backoff delay in ms (default: 30000) */
  maxDelay: number;
}

/** Circuit breaker configuration */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures to trip (default: 3) */
  failureThreshold: number;
  /** Time window for counting failures in ms (default: 60000) */
  failureWindow: number;
  /** Initial cooldown after tripping in ms (default: 30000) */
  cooldownMs: number;
  /** Maximum cooldown in ms (default: 300000) */
  maxCooldownMs: number;
}

/** Message queue configuration */
export interface QueueConfig {
  /** Messages per minute (default: 20) */
  messagesPerMinute: number;
  /** Enable human-like timing jitter (default: true) */
  humanLikeTiming: boolean;
  /** Maximum concurrent sends (default: 1) */
  concurrency: number;
  /** Maximum retry attempts for failed messages (default: 3) */
  maxRetries: number;
}

/** Metrics/observability configuration */
export interface MetricsConfig {
  /** Enable Prometheus metrics (default: false) */
  prometheus: boolean;
  /** HTTP port for metrics/health endpoints (default: 9100) */
  port: number;
}

/** Full client configuration */
export interface ClientConfig {
  /** Authentication state (required) */
  auth: AuthenticationState;

  /** Logger instance (default: pino stderr) */
  logger?: unknown;

  /** Browser fingerprint (default: ['NexaWhats', 'Chrome', '22.0']) */
  browser?: WABrowserDescription;

  /** WhatsApp Web version (auto-fetched if not provided) */
  version?: WAVersion;

  /** Connection timeout in ms (default: 20000) */
  connectTimeoutMs?: number;

  /** Keep-alive interval in ms (default: 25000) */
  keepAliveIntervalMs?: number;

  /** Reconnection configuration */
  reconnect?: Partial<ReconnectConfig>;

  /** Circuit breaker configuration */
  circuitBreaker?: Partial<CircuitBreakerConfig>;

  /** Message queue configuration */
  queue?: Partial<QueueConfig>;

  /** Metrics/observability configuration */
  metrics?: Partial<MetricsConfig>;

  /** Whether to emit events for own messages (default: false) */
  emitOwnEvents?: boolean;

  /** Mark as online when connected (default: true) */
  markOnlineOnConnect?: boolean;

  /** JID filter — return true to ignore messages from this JID */
  shouldIgnoreJid?: (jid: string) => boolean;
}
