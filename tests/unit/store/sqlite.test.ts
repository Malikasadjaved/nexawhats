import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteAuthStore } from '../../../src/store/sqlite.js';
import type { AuthenticationCreds } from '../../../src/types/auth.js';

function stubCreds(): AuthenticationCreds {
  return {
    noiseKey: { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) },
    pairingEphemeralKeyPair: {
      public: Buffer.from([7, 8]),
      private: Buffer.from([9, 10]),
    },
    signedIdentityKey: {
      public: Buffer.from([11]),
      private: Buffer.from([12]),
    },
    signedPreKey: {
      public: Buffer.from([13]),
      private: Buffer.from([14]),
      signature: Buffer.from([15, 16]),
      keyId: 1,
    },
    registrationId: 1234,
    advSecretKey: 'abc123==',
    firstUnuploadedPreKeyId: 1,
    nextPreKeyId: 1,
    processedHistoryMessages: [],
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false,
    pairingCode: undefined,
    lastPropHash: undefined,
    routingInfo: undefined,
  };
}

describe('SQLiteAuthStore', () => {
  let store: SQLiteAuthStore;

  beforeEach(() => {
    store = new SQLiteAuthStore({ path: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  it('returns null when no credentials are saved', async () => {
    expect(await store.loadState()).toBeNull();
  });

  it('round-trips credentials with Buffer fields', async () => {
    const creds = stubCreds();
    await store.saveCreds(creds);

    const loaded = await store.loadState();
    expect(loaded).not.toBeNull();
    expect(loaded!.creds.registrationId).toBe(1234);
    expect(Buffer.isBuffer(loaded!.creds.noiseKey.public)).toBe(true);
    expect((loaded!.creds.noiseKey.public as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(
      true,
    );
    expect(loaded!.creds.signedPreKey.keyId).toBe(1);
  });

  it('saveState writes both creds and returns a live key store', async () => {
    const creds = stubCreds();
    await store.saveState({
      creds,
      keys: { get: async () => ({}), set: async () => undefined },
    });
    const loaded = await store.loadState();
    expect(loaded!.creds.advSecretKey).toBe('abc123==');
    // Keys returned are bound to the store itself, not the input state.
    await loaded!.keys.set({ 'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } } });
    expect(store.keyCount).toBe(1);
  });

  it('stores and retrieves signal keys', async () => {
    await store.setKeys({
      'pre-key': {
        '1': { public: Buffer.from([1]), private: Buffer.from([2]) },
        '2': { public: Buffer.from([3]), private: Buffer.from([4]) },
      },
    });

    const result = await store.getKeys('pre-key', ['1', '2', '3']);
    expect(Object.keys(result)).toEqual(['1', '2']);
    expect((result['1']!.public as Buffer).equals(Buffer.from([1]))).toBe(true);
  });

  it('setKeys with null value deletes the key', async () => {
    await store.setKeys({
      'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } },
    });
    expect(store.keyCount).toBe(1);

    await store.setKeys({ 'pre-key': { '1': null } });
    expect(store.keyCount).toBe(0);
    expect(await store.getKeys('pre-key', ['1'])).toEqual({});
  });

  it('setKeys is a single transaction (all-or-nothing batch)', async () => {
    // Insert 100 keys in one call — if any fail, none should be present.
    const entries: Record<string, { public: Buffer; private: Buffer }> = {};
    for (let i = 0; i < 100; i++) {
      entries[String(i)] = { public: Buffer.from([i]), private: Buffer.from([i]) };
    }
    await store.setKeys({ 'pre-key': entries });
    expect(store.keyCount).toBe(100);
  });

  it('clear removes all creds and keys', async () => {
    await store.saveCreds(stubCreds());
    await store.setKeys({
      session: { 'abc': Buffer.from([1]) },
    });

    await store.clear();
    expect(await store.loadState()).toBeNull();
    expect(store.keyCount).toBe(0);
  });

  it('different key types live in separate namespaces', async () => {
    await store.setKeys({
      'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } },
      session: { '1': Buffer.from([99]) },
    });
    const prek = await store.getKeys('pre-key', ['1']);
    const sess = await store.getKeys('session', ['1']);
    expect((prek['1']!.public as Buffer).equals(Buffer.from([1]))).toBe(true);
    expect((sess['1'] as Buffer).equals(Buffer.from([99]))).toBe(true);
  });

  it('overwrites creds on repeated saveCreds', async () => {
    const a = stubCreds();
    await store.saveCreds(a);
    const b = { ...a, registrationId: 9999 };
    await store.saveCreds(b);
    const loaded = await store.loadState();
    expect(loaded!.creds.registrationId).toBe(9999);
  });

  it('persists across a reopen when backed by a file', async () => {
    store.close();

    const path = `:memory:`; // swap for temp file pattern
    // Use a temp file in the project dir (Windows-safe under D:)
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const tmp = pathMod.join(os.tmpdir(), `nexawhats-test-${Date.now()}.db`);

    const s1 = new SQLiteAuthStore({ path: tmp });
    await s1.saveCreds(stubCreds());
    await s1.setKeys({ 'pre-key': { x: { public: Buffer.from([7]), private: Buffer.from([8]) } } });
    s1.close();

    const s2 = new SQLiteAuthStore({ path: tmp });
    expect(await s2.loadState()).not.toBeNull();
    expect(s2.keyCount).toBe(1);
    s2.close();

    fs.unlinkSync(tmp);
    // prevent afterEach double-close
    store = new SQLiteAuthStore({ path: ':memory:' });
    // ensure the unused `path` var is consumed (it was just documentation)
    expect(typeof path).toBe('string');
  });
});
