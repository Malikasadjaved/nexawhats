import type { AnyMessageContent, MessagePriority } from '../types/message.js';
import { DeadLetterQueue } from './dead-letter.js';
import { RateLimiter } from './rate-limiter.js';

export { DeadLetterQueue } from './dead-letter.js';
export { RateLimiter } from './rate-limiter.js';

/** Queued message entry */
interface QueueEntry {
  jid: string;
  content: AnyMessageContent;
  priority: MessagePriority;
  attempts: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  enqueuedAt: Date;
}

/** Priority weights for ordering (lower = processed first) */
const PRIORITY_WEIGHT: Record<MessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Message queue with priority ordering, rate limiting, and dead-letter support.
 */
export class MessageQueue {
  private readonly queue: QueueEntry[] = [];
  private readonly rateLimiter: RateLimiter;
  readonly deadLetters: DeadLetterQueue;
  private readonly maxRetries: number;
  private readonly maxSize: number;
  private processing = false;
  private sendFn: ((jid: string, content: AnyMessageContent) => Promise<unknown>) | null = null;

  constructor(
    options: {
      messagesPerMinute?: number;
      humanLikeTiming?: boolean;
      maxRetries?: number;
      maxSize?: number;
    } = {},
  ) {
    this.rateLimiter = new RateLimiter({
      messagesPerMinute: options.messagesPerMinute,
      humanLikeTiming: options.humanLikeTiming,
    });
    this.deadLetters = new DeadLetterQueue();
    this.maxRetries = options.maxRetries ?? 3;
    this.maxSize = options.maxSize ?? 10000;
  }

  /** Set the actual send function (injected by the client) */
  setSendFn(fn: (jid: string, content: AnyMessageContent) => Promise<unknown>): void {
    this.sendFn = fn;
  }

  /** Enqueue a message for sending */
  async enqueue(
    jid: string,
    content: AnyMessageContent,
    priority: MessagePriority = 'normal',
  ): Promise<unknown> {
    if (this.queue.length >= this.maxSize) {
      throw new Error(`Queue is full (${this.maxSize} messages)`);
    }

    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        jid,
        content,
        priority,
        attempts: 0,
        resolve,
        reject,
        enqueuedAt: new Date(),
      };

      // Insert in priority order
      const weight = PRIORITY_WEIGHT[priority];
      const insertIndex = this.queue.findIndex((e) => PRIORITY_WEIGHT[e.priority] > weight);
      if (insertIndex === -1) {
        this.queue.push(entry);
      } else {
        this.queue.splice(insertIndex, 0, entry);
      }

      this.processNext();
    });
  }

  /** Process the next message in the queue */
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0 || !this.sendFn) return;

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0];

        // Wait for rate limiter
        await this.rateLimiter.acquire();

        entry.attempts++;

        try {
          const result = await this.sendFn(entry.jid, entry.content);
          this.queue.shift();
          entry.resolve(result);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));

          if (entry.attempts >= this.maxRetries) {
            this.queue.shift();
            this.deadLetters.add({
              jid: entry.jid,
              content: entry.content,
              error: err,
              attempts: entry.attempts,
              firstAttempt: entry.enqueuedAt,
              lastAttempt: new Date(),
            });
            entry.reject(err);
          }
          // else: stays in queue for retry on next loop
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Current queue depth */
  get depth(): number {
    return this.queue.length;
  }

  /** Get queue depth by priority */
  depthByPriority(): Record<MessagePriority, number> {
    const counts: Record<MessagePriority, number> = {
      urgent: 0,
      high: 0,
      normal: 0,
      low: 0,
    };
    for (const entry of this.queue) {
      counts[entry.priority]++;
    }
    return counts;
  }

  /** Clear the queue (rejects all pending) */
  clear(): void {
    for (const entry of this.queue.splice(0)) {
      entry.reject(new Error('Queue cleared'));
    }
  }

  /** Whether the queue is currently processing */
  get isProcessing(): boolean {
    return this.processing;
  }
}
