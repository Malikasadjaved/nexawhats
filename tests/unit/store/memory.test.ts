import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuthStore } from '../../../src/store/memory.js';
import type { AuthenticationCreds } from '../../../src/types/auth.js';

describe('MemoryAuthStore', () => {
  let store: MemoryAuthStore;

  beforeEach(() => {
    store = new MemoryAuthStore();
  });

  describe('loadState', () => {
    it('should return null when no state saved', async () => {
      const state = await store.loadState();
      expect(state).toBeNull();
    });

    it('should return saved state', async () => {
      const creds = { registered: true } as AuthenticationCreds;
      await store.saveCreds(creds);
      const state = await store.loadState();
      expect(state).not.toBeNull();
      expect(state?.creds.registered).toBe(true);
    });
  });

  describe('saveCreds / saveCreds', () => {
    it('should persist creds', async () => {
      const creds = { registered: true, platform: 'test' } as AuthenticationCreds;
      await store.saveCreds(creds);
      const state = await store.loadState();
      expect(state?.creds.platform).toBe('test');
    });

    it('should overwrite existing creds', async () => {
      await store.saveCreds({ platform: 'first' } as AuthenticationCreds);
      await store.saveCreds({ platform: 'second' } as AuthenticationCreds);
      const state = await store.loadState();
      expect(state?.creds.platform).toBe('second');
    });
  });

  describe('getKeys / setKeys', () => {
    it('should return empty object for missing keys', async () => {
      const result = await store.getKeys('pre-key', ['1', '2']);
      expect(result).toEqual({});
    });

    it('should store and retrieve keys', async () => {
      const keyPair = { public: new Uint8Array([1, 2, 3]), private: new Uint8Array([4, 5, 6]) };
      await store.setKeys({ 'pre-key': { '1': keyPair } });
      const result = await store.getKeys('pre-key', ['1']);
      expect(result['1']).toEqual(keyPair);
    });

    it('should handle multiple key types', async () => {
      await store.setKeys({
        'pre-key': { '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } },
        session: { abc: new Uint8Array([3, 4, 5]) },
      });
      const preKeys = await store.getKeys('pre-key', ['1']);
      const sessions = await store.getKeys('session', ['abc']);
      expect(preKeys['1']).toBeDefined();
      expect(sessions.abc).toBeDefined();
    });

    it('should delete keys when value is null', async () => {
      await store.setKeys({
        'pre-key': { '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } },
      });
      await store.setKeys({ 'pre-key': { '1': null } });
      const result = await store.getKeys('pre-key', ['1']);
      expect(result['1']).toBeUndefined();
    });

    it('should only return requested IDs', async () => {
      await store.setKeys({
        'pre-key': {
          '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) },
          '2': { public: new Uint8Array([3]), private: new Uint8Array([4]) },
        },
      });
      const result = await store.getKeys('pre-key', ['1']);
      expect(Object.keys(result)).toEqual(['1']);
    });
  });

  describe('clear', () => {
    it('should clear all data', async () => {
      await store.saveCreds({ registered: true } as AuthenticationCreds);
      await store.setKeys({
        'pre-key': { '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } },
      });
      await store.clear();
      expect(await store.loadState()).toBeNull();
      expect(await store.getKeys('pre-key', ['1'])).toEqual({});
    });
  });

  describe('keyCount', () => {
    it('should report correct key count', async () => {
      expect(store.keyCount).toBe(0);
      await store.setKeys({
        'pre-key': { '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } },
        session: { a: new Uint8Array([3]) },
      });
      expect(store.keyCount).toBe(2);
    });
  });
});
