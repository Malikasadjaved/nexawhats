import type { MessageQueue } from '../queue/index.js';
import type { AnyMessageContent, MessagePriority, WAMessage } from '../types/message.js';

/**
 * Message sender — wraps the queue for ergonomic message sending.
 *
 * The actual socket-level sendMessage will be injected in Phase 6
 * when we fork Baileys' messages-send module.
 */
export class MessageSender {
  private queue: MessageQueue | null = null;
  private directSendFn:
    | ((jid: string, content: AnyMessageContent) => Promise<WAMessage | undefined>)
    | null = null;

  /** Inject the message queue */
  setQueue(queue: MessageQueue): void {
    this.queue = queue;
  }

  /** Inject the direct send function (low-level socket send) */
  setDirectSendFn(
    fn: (jid: string, content: AnyMessageContent) => Promise<WAMessage | undefined>,
  ): void {
    this.directSendFn = fn;
  }

  /**
   * Send a message through the queue (rate-limited, priority-ordered).
   */
  async send(
    jid: string,
    content: AnyMessageContent,
    priority: MessagePriority = 'normal',
  ): Promise<unknown> {
    if (this.queue) {
      return this.queue.enqueue(jid, content, priority);
    }

    // No queue — send directly
    if (this.directSendFn) {
      return this.directSendFn(jid, content);
    }

    throw new Error('No send function configured — client not connected');
  }

  /**
   * Send a message bypassing the queue (for urgent system messages).
   */
  async sendDirect(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> {
    if (!this.directSendFn) {
      throw new Error('No send function configured — client not connected');
    }
    return this.directSendFn(jid, content);
  }
}
