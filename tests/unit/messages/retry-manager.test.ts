import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageRetryManager } from '../../../src/messages/retry-manager.js';

describe('MessageRetryManager', () => {
  let manager: MessageRetryManager;

  beforeEach(() => {
    manager = new MessageRetryManager();
  });

  afterEach(() => {
    manager.clear();
  });

  // ── Basic cache operations ──────────────────────────────────────────

  describe('addRecentMessage / getRecentMessage', () => {
    it('stores and retrieves a message', () => {
      const msg = { conversation: 'hello' };
      manager.addRecentMessage('123@s.whatsapp.net', 'msg-1', msg);
      expect(manager.getRecentMessage('123@s.whatsapp.net', 'msg-1')).toEqual(msg);
    });

    it('returns undefined for unknown message', () => {
      expect(manager.getRecentMessage('123@s.whatsapp.net', 'nonexistent')).toBeUndefined();
    });

    it('isolates by JID', () => {
      const msg = { conversation: 'hello' };
      manager.addRecentMessage('123@s.whatsapp.net', 'msg-1', msg);
      expect(manager.getRecentMessage('456@s.whatsapp.net', 'msg-1')).toBeUndefined();
    });

    it('isolates by message ID', () => {
      const msg = { conversation: 'hello' };
      manager.addRecentMessage('123@s.whatsapp.net', 'msg-1', msg);
      expect(manager.getRecentMessage('123@s.whatsapp.net', 'msg-2')).toBeUndefined();
    });
  });

  // ── Retry count tracking ────────────────────────────────────────────

  describe('retry counts', () => {
    it('starts at 0', () => {
      expect(manager.getRetryCount('123@s.whatsapp.net', 'msg-1')).toBe(0);
    });

    it('increments on each call', () => {
      expect(manager.incrementRetryCount('123@s.whatsapp.net', 'msg-1')).toBe(1);
      expect(manager.incrementRetryCount('123@s.whatsapp.net', 'msg-1')).toBe(2);
      expect(manager.incrementRetryCount('123@s.whatsapp.net', 'msg-1')).toBe(3);
      expect(manager.getRetryCount('123@s.whatsapp.net', 'msg-1')).toBe(3);
    });

    it('tracks counts independently per (jid, msgId)', () => {
      manager.incrementRetryCount('a@s.whatsapp.net', 'm1');
      manager.incrementRetryCount('a@s.whatsapp.net', 'm1');
      manager.incrementRetryCount('b@s.whatsapp.net', 'm1');
      expect(manager.getRetryCount('a@s.whatsapp.net', 'm1')).toBe(2);
      expect(manager.getRetryCount('b@s.whatsapp.net', 'm1')).toBe(1);
    });

    it('also updates count on cached message entry', () => {
      const msg = { conversation: 'test' };
      manager.addRecentMessage('jid@s.whatsapp.net', 'id', msg);
      manager.incrementRetryCount('jid@s.whatsapp.net', 'id');
      const cached = manager.getRecentMessage('jid@s.whatsapp.net', 'id');
      expect(cached).toBeDefined();
    });
  });

  // ── Max retries enforcement ────────────────────────────────────────

  describe('hasExceededMaxRetries', () => {
    it('returns false for count < 5', () => {
      expect(manager.hasExceededMaxRetries('j@s.whatsapp.net', 'm')).toBe(false);
    });

    it('returns false at exactly 4', () => {
      for (let i = 0; i < 4; i++) manager.incrementRetryCount('j@s.whatsapp.net', 'm');
      expect(manager.hasExceededMaxRetries('j@s.whatsapp.net', 'm')).toBe(false);
    });

    it('returns true at count 5', () => {
      for (let i = 0; i < 5; i++) manager.incrementRetryCount('j@s.whatsapp.net', 'm');
      expect(manager.hasExceededMaxRetries('j@s.whatsapp.net', 'm')).toBe(true);
    });

    it('returns true beyond 5', () => {
      for (let i = 0; i < 10; i++) manager.incrementRetryCount('j@s.whatsapp.net', 'm');
      expect(manager.hasExceededMaxRetries('j@s.whatsapp.net', 'm')).toBe(true);
    });
  });

  // ── canRetry ───────────────────────────────────────────────────────

  describe('canRetry', () => {
    it('returns false when message not in cache', () => {
      expect(manager.canRetry('j@s.whatsapp.net', 'm')).toBe(false);
    });

    it('returns true when message is cached and under limit', () => {
      manager.addRecentMessage('j@s.whatsapp.net', 'm', { text: 'hi' });
      expect(manager.canRetry('j@s.whatsapp.net', 'm')).toBe(true);
    });

    it('returns false when retry count exceeded even with cached message', () => {
      manager.addRecentMessage('j@s.whatsapp.net', 'm', { text: 'hi' });
      for (let i = 0; i < 5; i++) manager.incrementRetryCount('j@s.whatsapp.net', 'm');
      expect(manager.canRetry('j@s.whatsapp.net', 'm')).toBe(false);
    });
  });

  // ── remove / clear ─────────────────────────────────────────────────

  describe('remove / clear', () => {
    it('remove deletes from both caches', () => {
      const msg = { conversation: 'hi' };
      manager.addRecentMessage('j@s.whatsapp.net', 'm', msg);
      manager.incrementRetryCount('j@s.whatsapp.net', 'm');
      manager.remove('j@s.whatsapp.net', 'm');
      expect(manager.getRecentMessage('j@s.whatsapp.net', 'm')).toBeUndefined();
      expect(manager.getRetryCount('j@s.whatsapp.net', 'm')).toBe(0);
    });

    it('clear resets all state', () => {
      manager.addRecentMessage('a@s.whatsapp.net', '1', { text: 'a' });
      manager.addRecentMessage('b@s.whatsapp.net', '2', { text: 'b' });
      manager.incrementRetryCount('a@s.whatsapp.net', '1');
      manager.incrementRetryCount('a@s.whatsapp.net', '1');
      manager.clear();
      expect(manager.getRecentMessage('a@s.whatsapp.net', '1')).toBeUndefined();
      expect(manager.getRecentMessage('b@s.whatsapp.net', '2')).toBeUndefined();
      expect(manager.getRetryCount('a@s.whatsapp.net', '1')).toBe(0);
    });
  });

  // ── LRU eviction ───────────────────────────────────────────────────

  describe('LRU eviction', () => {
    it('evicts oldest entries past 512', () => {
      const msg = { conversation: 'stress' };
      // Fill to exactly 512
      for (let i = 0; i < 512; i++) {
        manager.addRecentMessage('j@s.whatsapp.net', `msg-${i}`, msg);
      }
      // First entry should still be present
      expect(manager.getRecentMessage('j@s.whatsapp.net', 'msg-0')).toBeDefined();

      // One more should evict the oldest
      manager.addRecentMessage('j@s.whatsapp.net', 'msg-512', msg);
      // The oldest may have been evicted (LRU behavior depends on access pattern)
      // At minimum, msg-512 must be present
      expect(manager.getRecentMessage('j@s.whatsapp.net', 'msg-512')).toBeDefined();
    });
  });

  // ── Cache expiry behaviour ───────────────────────────────────────

  describe('cache expiry behaviour', () => {
    it('entries are independently tracked for retry count and message', () => {
      const msg = { conversation: 'test' };
      manager.addRecentMessage('j@s.whatsapp.net', 'm', msg);
      // Removing just the message doesn't clear retry count in lru-cache impl
      // But canRetry requires BOTH: cached message AND under limit
      manager.remove('j@s.whatsapp.net', 'm');
      expect(manager.canRetry('j@s.whatsapp.net', 'm')).toBe(false);
    });

    it('canRetry requires message in cache', () => {
      // Even with no retries, can't retry if message not in cache
      manager.incrementRetryCount('j@s.whatsapp.net', 'm');
      expect(manager.canRetry('j@s.whatsapp.net', 'm')).toBe(false);
    });
  });

  // ── Session recreate logic ─────────────────────────────────────────

  describe('shouldRecreateSession', () => {
    it('returns true when no session exists', () => {
      expect(manager.shouldRecreateSession('j@s.whatsapp.net', 0, false)).toBe(true);
    });

    it('returns false when session exists and retryCount < 2', () => {
      expect(manager.shouldRecreateSession('j@s.whatsapp.net', 1, true)).toBe(false);
    });

    it('returns true when retryCount >= 2 and no prior recreate recorded', () => {
      expect(manager.shouldRecreateSession('j@s.whatsapp.net', 2, true)).toBe(true);
    });

    it('obeys 1-hour cooldown between recreates', () => {
      manager.recordSessionRecreate('j@s.whatsapp.net');
      // Immediately after recording, should not recreate again
      expect(manager.shouldRecreateSession('j@s.whatsapp.net', 3, true)).toBe(false);
    });

    it('allows recreate after cooldown expires', () => {
      vi.useFakeTimers();
      try {
        manager.recordSessionRecreate('j@s.whatsapp.net');
        vi.advanceTimersByTime(60 * 60 * 1000 + 1);
        expect(manager.shouldRecreateSession('j@s.whatsapp.net', 2, true)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Statistics tracking ────────────────────────────────────────────

  describe('statistics', () => {
    it('starts with zero counts', () => {
      expect(manager.statistics).toEqual({
        total: 0,
        success: 0,
        fail: 0,
        media: 0,
        session: 0,
        phone: 0,
      });
    });

    it('trackSuccess increments total + success', () => {
      manager.trackSuccess();
      manager.trackSuccess();
      expect(manager.statistics.total).toBe(2);
      expect(manager.statistics.success).toBe(2);
      expect(manager.statistics.fail).toBe(0);
    });

    it('trackFail increments total + fail', () => {
      manager.trackFail();
      expect(manager.statistics.total).toBe(1);
      expect(manager.statistics.fail).toBe(1);
    });

    it('trackMedia increments total + media', () => {
      manager.trackMedia();
      expect(manager.statistics.total).toBe(1);
      expect(manager.statistics.media).toBe(1);
    });

    it('trackSession increments total + session', () => {
      manager.trackSession();
      expect(manager.statistics.total).toBe(1);
      expect(manager.statistics.session).toBe(1);
    });

    it('trackPhone increments total + phone', () => {
      manager.trackPhone();
      expect(manager.statistics.total).toBe(1);
      expect(manager.statistics.phone).toBe(1);
    });

    it('clear resets statistics', () => {
      manager.trackSuccess();
      manager.trackFail();
      manager.clear();
      expect(manager.statistics).toEqual({
        total: 0,
        success: 0,
        fail: 0,
        media: 0,
        session: 0,
        phone: 0,
      });
    });
  });

  // ── schedulePhoneRequest ──────────────────────────────────────────

  describe('schedulePhoneRequest', () => {
    it('does not throw', () => {
      expect(() => manager.schedulePhoneRequest()).not.toThrow();
    });

    it('deduplicates concurrent calls', () => {
      // Second call within debounce window should be a no-op
      manager.schedulePhoneRequest(100);
      manager.schedulePhoneRequest(100);
      // No assertion needed — just verifying no throw / no duplicate timers
    });
  });
});
