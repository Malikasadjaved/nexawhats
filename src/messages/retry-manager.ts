/**
 * Message Retry Manager — caches recently sent messages so they can be
 * re-encrypted and re-sent when a recipient device requests a retry.
 *
 * Ported from Baileys' `Utils/message-retry-manager.js`.
 */

import { LRUCache } from 'lru-cache';
import type { Logger } from 'pino';

const MAX_CACHE_SIZE = 512;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRY_COUNT = 5;
const MIN_SESSION_RECREATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface RetryStatistics {
  total: number;
  success: number;
  fail: number;
  media: number;
  session: number;
  phone: number;
}

function defaultStats(): RetryStatistics {
  return { total: 0, success: 0, fail: 0, media: 0, session: 0, phone: 0 };
}

export class MessageRetryManager {
  private readonly cache = new LRUCache<
    string,
    { message: Record<string, unknown>; retryCount: number }
  >({
    max: MAX_CACHE_SIZE,
    ttl: CACHE_TTL_MS,
  });
  private readonly retryCounts = new LRUCache<string, number>({
    max: MAX_CACHE_SIZE,
    ttl: CACHE_TTL_MS,
  });
  private readonly sessionRecreateTs = new Map<string, number>();
  private pendingPhoneRequest = false;
  statistics: RetryStatistics = defaultStats();
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /** Store a recently sent message for potential retry. */
  addRecentMessage(to: string, id: string, message: Record<string, unknown>): void {
    const key = `${to}:${id}`;
    this.cache.set(key, { message, retryCount: 0 });
  }

  /** Retrieve a cached message for retry. */
  getRecentMessage(to: string, id: string): Record<string, unknown> | undefined {
    const entry = this.cache.get(`${to}:${id}`);
    return entry?.message;
  }

  /** Reset retry count for a specific recipient+message pair. */
  incrementRetryCount(to: string, id: string): number {
    const key = `${to}:${id}`;
    const current = this.retryCounts.get(key) ?? 0;
    const next = current + 1;
    this.retryCounts.set(key, next);

    const cached = this.cache.get(key);
    if (cached) {
      cached.retryCount = next;
      this.cache.set(key, cached);
    }

    return next;
  }

  /** Current retry count for a specific recipient+message pair. */
  getRetryCount(to: string, id: string): number {
    return this.retryCounts.get(`${to}:${id}`) ?? 0;
  }

  /** Whether the pair has exceeded the maximum retry count. */
  hasExceededMaxRetries(to: string, id: string): boolean {
    return this.getRetryCount(to, id) >= MAX_RETRY_COUNT;
  }

  /** Whether a retry can be attempted for this pair. */
  canRetry(to: string, id: string): boolean {
    return !this.hasExceededMaxRetries(to, id) && this.cache.has(`${to}:${id}`);
  }

  /** Remove a cached message (e.g. after successful delivery). */
  remove(to: string, id: string): void {
    const key = `${to}:${id}`;
    this.cache.delete(key);
    this.retryCounts.delete(key);
  }

  /** Clear all cached retry state. */
  clear(): void {
    this.cache.clear();
    this.retryCounts.clear();
    this.sessionRecreateTs.clear();
    this.statistics = defaultStats();
  }

  /**
   * Whether the session should be recreated for this JID.
   * Returns true if no session exists, or if retryCount >= 2 and
   * more than 1 hour since the last session recreate.
   */
  shouldRecreateSession(jid: string, retryCount: number, hasSession: boolean): boolean {
    if (!hasSession) return true;
    if (retryCount < 2) return false;
    const lastTs = this.sessionRecreateTs.get(jid);
    if (!lastTs) return true;
    return Date.now() - lastTs > MIN_SESSION_RECREATE_INTERVAL_MS;
  }

  /** Record that a session was recreated for this JID. */
  recordSessionRecreate(jid: string): void {
    this.sessionRecreateTs.set(jid, Date.now());
  }

  /** Schedule a phone number request (retry-triggered). */
  schedulePhoneRequest(delayMs = 3000): void {
    if (this.pendingPhoneRequest) return;
    this.pendingPhoneRequest = true;
    this.logger?.debug?.('phone request scheduled via retry manager');
    setTimeout(() => {
      this.pendingPhoneRequest = false;
    }, delayMs);
  }

  /** Track a successful retry delivery. */
  trackSuccess(): void {
    this.statistics.total++;
    this.statistics.success++;
  }

  /** Track a failed retry delivery. */
  trackFail(): void {
    this.statistics.total++;
    this.statistics.fail++;
  }

  /** Track a media retry. */
  trackMedia(): void {
    this.statistics.total++;
    this.statistics.media++;
  }

  /** Track a session-oriented retry. */
  trackSession(): void {
    this.statistics.total++;
    this.statistics.session++;
  }

  /** Track a phone-request-oriented retry. */
  trackPhone(): void {
    this.statistics.total++;
    this.statistics.phone++;
  }
}
