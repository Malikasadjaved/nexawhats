import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAuthStore } from '../../../src/store/file.js';
import type { AuthenticationCreds } from '../../../src/types/auth.js';

function stubCreds(): AuthenticationCreds {
  return {
    noiseKey: { public: Buffer.from([1]), private: Buffer.from([2]) },
    pairingEphemeralKeyPair: {
      public: Buffer.from([3]),
      private: Buffer.from([4]),
    },
    signedIdentityKey: { public: Buffer.from([5]), private: Buffer.from([6]) },
    signedPreKey: {
      public: Buffer.from([7]),
      private: Buffer.from([8]),
      signature: Buffer.from([9]),
      keyId: 42,
    },
    registrationId: 77,
    advSecretKey: 'secret==',
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

describe('FileAuthStore', () => {
  let dir: string;
  let store: FileAuthStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexawhats-file-'));
    store = new FileAuthStore(dir);
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('creates the directory if missing', () => {
    const nested = join(dir, 'deep', 'nested');
    new FileAuthStore(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('returns null when there are no creds', async () => {
    expect(await store.loadState()).toBeNull();
  });

  it('round-trips credentials including Buffers', async () => {
    await store.saveCreds(stubCreds());
    const loaded = await store.loadState();
    expect(loaded).not.toBeNull();
    expect(loaded!.creds.registrationId).toBe(77);
    expect((loaded!.creds.noiseKey.public as Buffer).equals(Buffer.from([1]))).toBe(
      true,
    );
    expect(loaded!.creds.signedPreKey.keyId).toBe(42);
  });

  it('writes creds to creds.json atomically (no .tmp leftovers)', async () => {
    await store.saveCreds(stubCreds());
    const entries = readdirSync(dir);
    expect(entries).toContain('creds.json');
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });

  it('stores and retrieves signal keys as individual files', async () => {
    await store.setKeys({
      'pre-key': {
        '1': { public: Buffer.from([1]), private: Buffer.from([2]) },
        '2': { public: Buffer.from([3]), private: Buffer.from([4]) },
      },
    });
    const files = readdirSync(dir).filter((f) => f.startsWith('pre-key-'));
    expect(files).toHaveLength(2);

    const keys = await store.getKeys('pre-key', ['1', '2']);
    expect((keys['1']!.public as Buffer).equals(Buffer.from([1]))).toBe(true);
    expect((keys['2']!.public as Buffer).equals(Buffer.from([3]))).toBe(true);
  });

  it('setKeys with null deletes the file', async () => {
    await store.setKeys({
      'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } },
    });
    expect(readdirSync(dir).filter((f) => f.startsWith('pre-key-'))).toHaveLength(1);

    await store.setKeys({ 'pre-key': { '1': null } });
    expect(readdirSync(dir).filter((f) => f.startsWith('pre-key-'))).toHaveLength(0);
  });

  it('replaces unsafe characters in key IDs', async () => {
    const id = 'user/host:1';
    await store.setKeys({
      session: { [id]: Buffer.from([9]) },
    });
    const files = readdirSync(dir);
    const sessionFile = files.find((f) => f.startsWith('session-'));
    expect(sessionFile).toBeDefined();
    expect(sessionFile).not.toContain('/');
    expect(sessionFile).not.toContain(':');

    const result = await store.getKeys('session', [id]);
    expect((result[id] as Buffer).equals(Buffer.from([9]))).toBe(true);
  });

  it('tolerates corrupt key files (returns empty rather than throwing)', async () => {
    // Write a bogus file where a session is expected.
    writeFileSync(join(dir, 'session-broken.json'), 'not json{{');
    const result = await store.getKeys('session', ['broken']);
    expect(result).toEqual({});
  });

  it('clear removes everything under the directory', async () => {
    await store.saveCreds(stubCreds());
    await store.setKeys({
      'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } },
    });
    await store.clear();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('concurrent saveCreds calls do not corrupt the file', async () => {
    // Fire 50 overlapping writes — every one must leave a valid JSON on disk.
    const creds = stubCreds();
    const writes = Array.from({ length: 50 }, (_, i) =>
      store.saveCreds({ ...creds, registrationId: i }),
    );
    await Promise.all(writes);

    const loaded = await store.loadState();
    expect(loaded).not.toBeNull();
    expect(typeof loaded!.creds.registrationId).toBe('number');
    // No stray .tmp files from races.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });
});
