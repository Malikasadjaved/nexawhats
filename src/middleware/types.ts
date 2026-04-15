import type { AuthStore } from '../store/interface.js';
import type { AnyMessageContent, WAMessage } from '../types/message.js';

/** Next function in the middleware chain */
export type NextFn = () => Promise<void>;

/** Middleware function signature (Koa-style) */
export type Middleware = (ctx: Context, next: NextFn) => Promise<void>;

/** Context object passed through the middleware pipeline */
export interface Context {
  /** The incoming message */
  message: WAMessage;

  /** Resolved JID (LID→phone if resolved) */
  jid: string;

  /** Sender's push name */
  senderName: string | undefined;

  /** Whether this is a group message */
  isGroup: boolean;

  /** Extracted text content from the message */
  text: string | undefined;

  /** Timestamp of the message */
  timestamp: number;

  /** Auth store reference */
  store: AuthStore;

  /** Reply to the sender with content */
  reply: (content: AnyMessageContent) => Promise<void>;

  /** Resolve a LID JID to phone-number JID */
  resolveLID: (lid: string) => Promise<string>;

  /** Custom metadata — middleware can attach data here */
  state: Record<string, unknown>;
}
