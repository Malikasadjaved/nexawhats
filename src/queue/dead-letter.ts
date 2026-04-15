/** A message that permanently failed to send */
export interface DeadLetter {
  jid: string;
  content: unknown;
  error: Error;
  attempts: number;
  firstAttempt: Date;
  lastAttempt: Date;
}

/**
 * Dead-letter queue for messages that failed after max retries.
 * Keeps a bounded history for inspection and reprocessing.
 */
export class DeadLetterQueue {
  private readonly items: DeadLetter[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /** Add a failed message to the dead-letter queue */
  add(letter: DeadLetter): void {
    this.items.push(letter);
    // Evict oldest if over capacity
    while (this.items.length > this.maxSize) {
      this.items.shift();
    }
  }

  /** Get all dead letters */
  getAll(): readonly DeadLetter[] {
    return this.items;
  }

  /** Get dead letters for a specific JID */
  getForJid(jid: string): DeadLetter[] {
    return this.items.filter((item) => item.jid === jid);
  }

  /** Clear all dead letters */
  clear(): void {
    this.items.length = 0;
  }

  /** Remove and return dead letters for reprocessing */
  drain(): DeadLetter[] {
    return this.items.splice(0);
  }

  /** Current count */
  get size(): number {
    return this.items.length;
  }
}
