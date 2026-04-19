import {
  Counter,
  Gauge,
  Histogram,
  type Registry,
  collectDefaultMetrics,
  register as defaultRegister,
} from 'prom-client';

/**
 * NexaWhats Prometheus metrics.
 *
 * All metrics are created against a registry (shared by default, or a
 * scoped one per client for multi-tenant scenarios). Record helpers are
 * no-ops when {@link NexaWhatsMetrics.enabled} is false, so call sites
 * don't have to guard every record.
 */
export interface NexaWhatsMetricsOptions {
  /** If false, every record* call becomes a no-op. Default: true. */
  enabled?: boolean;
  /** Custom registry — useful for isolating metrics in tests. Default: shared. */
  register?: Registry;
  /** If true, also collect Node process/event-loop metrics. Default: false. */
  collectDefault?: boolean;
  /** Metric name prefix. Default: 'nexawhats_'. */
  prefix?: string;
}

/** Connection status label → numeric value for the gauge. */
const CONNECTION_STATE_VALUES: Record<string, number> = {
  disconnected: 0,
  connecting: 1,
  connected: 2,
  reconnecting: 3,
};

/** Circuit breaker state → numeric value. */
const CIRCUIT_BREAKER_VALUES: Record<string, number> = {
  closed: 0,
  open: 1,
  'half-open': 2,
};

export class NexaWhatsMetrics {
  readonly enabled: boolean;
  readonly register: Registry;
  readonly messagesSent: Counter<'type' | 'priority'>;
  readonly messagesReceived: Counter<'type'>;
  readonly messagesFailed: Counter<'reason'>;
  readonly connectionState: Gauge<string>;
  readonly sendDuration: Histogram<string>;
  readonly queueDepth: Gauge<'priority'>;
  readonly circuitBreakerState: Gauge<string>;

  constructor(options: NexaWhatsMetricsOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.register = options.register ?? defaultRegister;
    const prefix = options.prefix ?? 'nexawhats_';

    // When metrics are disabled, we still build the objects (cheap) but
    // the record helpers short-circuit. This keeps the public API uniform.
    if (options.collectDefault) {
      collectDefaultMetrics({ register: this.register, prefix });
    }

    this.messagesSent = new Counter({
      name: `${prefix}messages_sent_total`,
      help: 'Total messages sent, labelled by type and priority',
      labelNames: ['type', 'priority'],
      registers: [this.register],
    });
    this.messagesReceived = new Counter({
      name: `${prefix}messages_received_total`,
      help: 'Total messages received, labelled by type',
      labelNames: ['type'],
      registers: [this.register],
    });
    this.messagesFailed = new Counter({
      name: `${prefix}messages_failed_total`,
      help: 'Total send failures, labelled by reason',
      labelNames: ['reason'],
      registers: [this.register],
    });
    this.connectionState = new Gauge({
      name: `${prefix}connection_state`,
      help: 'Connection state (0=disconnected 1=connecting 2=connected 3=reconnecting)',
      registers: [this.register],
    });
    this.sendDuration = new Histogram({
      name: `${prefix}send_duration_seconds`,
      help: 'Time spent sending a message, in seconds',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.register],
    });
    this.queueDepth = new Gauge({
      name: `${prefix}queue_depth`,
      help: 'Number of messages queued, labelled by priority',
      labelNames: ['priority'],
      registers: [this.register],
    });
    this.circuitBreakerState = new Gauge({
      name: `${prefix}circuit_breaker_state`,
      help: 'Circuit breaker state (0=closed 1=open 2=half-open)',
      registers: [this.register],
    });
  }

  recordMessageSent(type: string, priority: string): void {
    if (!this.enabled) return;
    this.messagesSent.labels(type, priority).inc();
  }

  recordMessageReceived(type: string): void {
    if (!this.enabled) return;
    this.messagesReceived.labels(type).inc();
  }

  recordMessageFailed(reason: string): void {
    if (!this.enabled) return;
    this.messagesFailed.labels(reason).inc();
  }

  setConnectionState(state: string): void {
    if (!this.enabled) return;
    const value = CONNECTION_STATE_VALUES[state];
    if (typeof value === 'number') this.connectionState.set(value);
  }

  setCircuitBreakerState(state: string): void {
    if (!this.enabled) return;
    const value = CIRCUIT_BREAKER_VALUES[state];
    if (typeof value === 'number') this.circuitBreakerState.set(value);
  }

  setQueueDepth(priority: string, depth: number): void {
    if (!this.enabled) return;
    this.queueDepth.labels(priority).set(depth);
  }

  /** Record a send duration. Returns the end() callback — call when the send resolves. */
  startSendTimer(): () => void {
    if (!this.enabled) return () => undefined;
    return this.sendDuration.startTimer();
  }

  /** Reset every metric to zero. Primarily for tests. */
  reset(): void {
    this.messagesSent.reset();
    this.messagesReceived.reset();
    this.messagesFailed.reset();
    this.connectionState.reset();
    this.sendDuration.reset();
    this.queueDepth.reset();
    this.circuitBreakerState.reset();
  }

  /** Prometheus text format for the /metrics endpoint. */
  async render(): Promise<string> {
    return this.register.metrics();
  }

  get contentType(): string {
    return this.register.contentType;
  }
}
