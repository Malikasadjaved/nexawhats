import { EventEmitter } from 'node:events';
import { extractText, isGroupMessage } from './messages/receive.js';
import { MessageSender } from './messages/send.js';
import { type Context, type Middleware, MiddlewarePipeline } from './middleware/index.js';
import { MessageQueue } from './queue/index.js';
import { CircuitBreaker } from './socket/circuit-breaker.js';
import { ConnectionStateMachine } from './socket/state-machine.js';
import type { AuthStore } from './store/interface.js';
import type { NexaWhatsEventMap } from './types/events.js';
import type { AnyMessageContent, MessagePriority, WAMessage } from './types/message.js';
import type { ClientConfig, ConnectionState } from './types/socket.js';

/**
 * NexaWhats client — the main entry point.
 *
 * @example
 * ```typescript
 * import { createClient, MemoryAuthStore } from 'nexawhats';
 *
 * const client = createClient({
 *   auth: await new MemoryAuthStore().loadState(),
 *   queue: { messagesPerMinute: 20, humanLikeTiming: true },
 * });
 *
 * client.use(async (ctx, next) => {
 *   console.log('Received:', ctx.text);
 *   await next();
 * });
 *
 * client.on('messages.upsert', ({ messages }) => {
 *   for (const msg of messages) {
 *     client.send(msg.key.remoteJid!, { text: 'Hello!' });
 *   }
 * });
 *
 * await client.connect();
 * ```
 */
export class NexaWhatsClient extends EventEmitter {
  readonly config: ClientConfig;
  readonly connection: ConnectionStateMachine;
  readonly circuitBreaker: CircuitBreaker;
  readonly queue: MessageQueue;
  readonly sender: MessageSender;
  readonly middleware: MiddlewarePipeline;
  private store: AuthStore | null = null;

  constructor(config: ClientConfig) {
    super();
    this.config = config;

    // Initialize connection state machine
    this.connection = new ConnectionStateMachine();
    this.connection.on('transition', (_from, to) => {
      this.emit('connection.update', {
        connection: to,
      } satisfies Partial<ConnectionState>);
    });

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    this.circuitBreaker.on('state-change', (event) => {
      this.emit('circuit-breaker.state-change', event);
    });

    // Initialize message queue
    this.queue = new MessageQueue({
      messagesPerMinute: config.queue?.messagesPerMinute,
      humanLikeTiming: config.queue?.humanLikeTiming,
      maxRetries: config.queue?.maxRetries,
    });

    // Initialize message sender
    this.sender = new MessageSender();
    this.sender.setQueue(this.queue);

    // Initialize middleware pipeline
    this.middleware = new MiddlewarePipeline();
  }

  /** Register middleware */
  use(middleware: Middleware): this {
    this.middleware.use(middleware);
    return this;
  }

  /** Set the auth store */
  setStore(store: AuthStore): this {
    this.store = store;
    return this;
  }

  /**
   * Send a message (through the queue).
   *
   * @example
   * await client.send('923124166950@s.whatsapp.net', { text: 'Hello!' });
   * await client.send(jid, { image: buffer, caption: 'Photo' }, 'high');
   */
  async send(
    jid: string,
    content: AnyMessageContent,
    priority: MessagePriority = 'normal',
  ): Promise<unknown> {
    return this.sender.send(jid, content, priority);
  }

  /**
   * Connect to WhatsApp.
   *
   * This is a placeholder that will be implemented in Phase 2+6
   * when we have the full Noise handshake + socket layer.
   */
  async connect(): Promise<void> {
    this.connection.transition('connecting');
    // Phase 2+6: Noise handshake, WebSocket connect, auth exchange
    // For now, just transition to show the state machine works
  }

  /**
   * Disconnect gracefully.
   */
  async disconnect(): Promise<void> {
    if (this.connection.isConnected || this.connection.isConnecting) {
      this.connection.reset();
    }
    this.queue.clear();
  }

  /**
   * Process an incoming message through the middleware pipeline.
   * Called internally when a message is received.
   */
  async processMessage(message: WAMessage): Promise<void> {
    const jid = message.key.remoteJid ?? '';

    const ctx: Context = {
      message,
      jid,
      senderName: message.pushName ?? undefined,
      isGroup: isGroupMessage(message),
      text: extractText(message),
      timestamp: message.messageTimestamp ?? Math.floor(Date.now() / 1000),
      store: this.store as AuthStore,
      reply: async (content: AnyMessageContent) => {
        await this.send(jid, content, 'high');
      },
      resolveLID: async (lid: string) => {
        // Phase 6: actual LID resolution via Signal repository
        return lid;
      },
      state: {},
    };

    await this.middleware.execute(ctx);
  }

  /** Whether the client is currently connected */
  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  /** Current connection state */
  get connectionState(): string {
    return this.connection.state;
  }

  /** Current queue depth */
  get queueDepth(): number {
    return this.queue.depth;
  }
}

// Typed event helpers (avoids unsafe declaration merging)
/** Type-safe event listener registration */
export type TypedOn = <T extends keyof NexaWhatsEventMap>(
  event: T,
  listener: (arg: NexaWhatsEventMap[T]) => void,
) => NexaWhatsClient;

/** Type-safe event listener removal */
export type TypedOff = <T extends keyof NexaWhatsEventMap>(
  event: T,
  listener: (arg: NexaWhatsEventMap[T]) => void,
) => NexaWhatsClient;

/** Type-safe event emission */
export type TypedEmit = <T extends keyof NexaWhatsEventMap>(
  event: T,
  arg: NexaWhatsEventMap[T],
) => boolean;

/**
 * Create a new NexaWhats client.
 *
 * @example
 * const client = createClient({
 *   auth: await store.loadState(),
 * });
 */
export function createClient(config: ClientConfig): NexaWhatsClient {
  return new NexaWhatsClient(config);
}
