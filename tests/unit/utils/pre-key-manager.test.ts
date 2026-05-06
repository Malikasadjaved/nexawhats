import { describe, expect, it } from 'vitest';
import type { SignalDataSet, SignalKeyStore } from '../../../src/types/auth.js';
import { PreKeyManager, generatePreKeys } from '../../../src/utils/pre-key-manager.js';

function createMockStore(
  preKeys: Record<string, { public: Uint8Array; private: Uint8Array }> = {},
): {
  store: SignalKeyStore;
  getWrittenData: () => SignalDataSet[];
} {
  const written: SignalDataSet[] = [];
  return {
    store: {
      get: async <T extends keyof import('../../../src/types/auth.js').SignalDataTypeMap>(
        _type: T,
        ids: string[],
      ) => {
        const result: Record<string, unknown> = {};
        for (const id of ids) {
          if (preKeys[id]) result[id] = preKeys[id];
        }
        return result as Record<string, unknown>;
      },
      set: async (data: SignalDataSet) => {
        written.push(data);
      },
    },
    getWrittenData: () => written,
  };
}

describe('PreKeyManager', () => {
  describe('validateDeletions', () => {
    it('removes deletion markers for keys that do not exist', async () => {
      const { store } = createMockStore({
        '1': { public: new Uint8Array(32), private: new Uint8Array(32) },
      });
      const mgr = new PreKeyManager(store);

      const data: SignalDataSet = { 'pre-key': { '1': null, '2': null } };
      await mgr.validateDeletions(data, 'pre-key');

      // Key 2 does not exist — its deletion marker should be removed
      expect(data['pre-key']).toBeDefined();
      expect(data['pre-key']!['1']).toBeNull(); // exists, kept
      expect(data['pre-key']!['2']).toBeUndefined(); // doesn't exist, removed
    });

    it('keeps all deletion markers when all keys exist', async () => {
      const { store } = createMockStore({
        '1': { public: new Uint8Array(32), private: new Uint8Array(32) },
        '2': { public: new Uint8Array(32), private: new Uint8Array(32) },
      });
      const mgr = new PreKeyManager(store);

      const data: SignalDataSet = { 'pre-key': { '1': null, '2': null } };
      await mgr.validateDeletions(data, 'pre-key');

      expect(data['pre-key']!['1']).toBeNull();
      expect(data['pre-key']!['2']).toBeNull();
    });

    it('does nothing for data with no pre-key entries', async () => {
      const { store } = createMockStore();
      const mgr = new PreKeyManager(store);

      const data: SignalDataSet = { session: { session1: new Uint8Array(10) } };
      await mgr.validateDeletions(data, 'pre-key');
      // Should not throw
    });

    it('does nothing when data has only updates (no deletions)', async () => {
      const { store } = createMockStore();
      const mgr = new PreKeyManager(store);

      const data: SignalDataSet = {
        'pre-key': { '3': { public: new Uint8Array(32), private: new Uint8Array(32) } },
      };
      await mgr.validateDeletions(data, 'pre-key');
      // All entries should be preserved
      expect(data['pre-key']!['3']).toBeDefined();
    });
  });

  describe('processOperations', () => {
    it('merges updates into cache and mutations', async () => {
      const { store } = createMockStore();
      const mgr = new PreKeyManager(store);

      const cache: SignalDataSet = {};
      const mutations: SignalDataSet = {};
      const data: SignalDataSet = {
        'pre-key': { '1': { public: new Uint8Array(32), private: new Uint8Array(32) } },
      };

      await mgr.processOperations(data, 'pre-key', cache, mutations, false);

      expect(cache['pre-key']).toBeDefined();
      expect(cache['pre-key']!['1']).toBeDefined();
      expect(mutations['pre-key']!['1']).toBeDefined();
    });

    it('only deletes keys that exist in store (non-transaction)', async () => {
      const { store } = createMockStore({
        '1': { public: new Uint8Array(32), private: new Uint8Array(32) },
      });
      const mgr = new PreKeyManager(store);

      const cache: SignalDataSet = {};
      const mutations: SignalDataSet = {};
      const data: SignalDataSet = { 'pre-key': { '1': null, '2': null } };

      await mgr.processOperations(data, 'pre-key', cache, mutations, false);

      // Key 1 exists in store — should be marked for deletion
      expect(mutations['pre-key']!['1']).toBeNull();
      // Key 2 does not exist — should NOT be in mutations
      expect(mutations['pre-key']!['2']).toBeUndefined();
    });

    it('deletes keys present in transaction cache (in-transaction)', async () => {
      const { store } = createMockStore();
      const mgr = new PreKeyManager(store);

      const cache: SignalDataSet = {
        'pre-key': { '5': { public: new Uint8Array(32), private: new Uint8Array(32) } },
      };
      const mutations: SignalDataSet = {};
      const data: SignalDataSet = { 'pre-key': { '5': null, '6': null } };

      await mgr.processOperations(data, 'pre-key', cache, mutations, true);

      // Key 5 is in cache — should be deleted
      expect(mutations['pre-key']!['5']).toBeNull();
      // Key 6 is not in cache — should NOT be deleted
      expect(mutations['pre-key']!['6']).toBeUndefined();
    });

    it('does nothing for empty data', async () => {
      const { store } = createMockStore();
      const mgr = new PreKeyManager(store);

      const cache: SignalDataSet = {};
      const mutations: SignalDataSet = {};
      await mgr.processOperations({}, 'pre-key', cache, mutations, false);
      // Should not throw, should be no-op
    });

    it('queues operations per key type', async () => {
      const { store } = createMockStore();
      const mgr = new PreKeyManager(store);

      // Verify that the queue is created lazily
      const cache: SignalDataSet = {};
      const mutations: SignalDataSet = {};

      // These should run serialized, not in parallel-race
      await Promise.all([
        mgr.processOperations(
          { 'pre-key': { '10': { public: new Uint8Array(32), private: new Uint8Array(32) } } },
          'pre-key',
          cache,
          mutations,
          false,
        ),
        mgr.processOperations(
          { 'pre-key': { '11': { public: new Uint8Array(32), private: new Uint8Array(32) } } },
          'pre-key',
          cache,
          mutations,
          false,
        ),
      ]);

      // Both should be present (serialized execution prevented races)
      expect(mutations['pre-key']!['10']).toBeDefined();
      expect(mutations['pre-key']!['11']).toBeDefined();
    });
  });
});

describe('generatePreKeys', () => {
  it('generates the requested number of key pairs', () => {
    const { preKeys, lastId } = generatePreKeys(1, 5);

    expect(Object.keys(preKeys)).toHaveLength(5);
    expect(lastId).toBe(5);

    for (const id of [1, 2, 3, 4, 5]) {
      expect(preKeys[id]).toBeDefined();
      expect(preKeys[id]!.public).toBeInstanceOf(Buffer);
      expect(preKeys[id]!.private).toBeInstanceOf(Buffer);
      expect(preKeys[id]!.public.length).toBe(32);
      expect(preKeys[id]!.private.length).toBe(32);
    }
  });

  it('generates keys with sequential IDs from startId', () => {
    const { preKeys, lastId } = generatePreKeys(100, 3);

    expect(Object.keys(preKeys)).toEqual(['100', '101', '102']);
    expect(lastId).toBe(102);
  });

  it('generates unique keys', () => {
    const { preKeys } = generatePreKeys(1, 10);

    const publicKeys = Object.values(preKeys).map((kp) => kp.public.toString('hex'));
    const uniqueKeys = new Set(publicKeys);
    expect(uniqueKeys.size).toBe(10); // All keys should be unique
  });
});
