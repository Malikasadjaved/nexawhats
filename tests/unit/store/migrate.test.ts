import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuthStore } from '../../../src/store/memory.js';
import { migrateFromBaileys } from '../../../src/store/migrate.js';
import { SQLiteAuthStore } from '../../../src/store/sqlite.js';

/** Write a Baileys-style JSON file (Buffers serialized as {type:'Buffer',data:[...]}) */
function writeBaileysJson(path: string, value: unknown): void {
  const replacer = (_key: string, v: unknown): unknown => {
    if (Buffer.isBuffer(v)) return { type: 'Buffer', data: Array.from(v) };
    return v;
  };
  writeFileSync(path, JSON.stringify(value, replacer), 'utf-8');
}

describe('migrateFromBaileys', () => {
  let src: string;

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'baileys-src-'));
  });

  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
  });

  it('throws if source directory is missing', async () => {
    await expect(
      migrateFromBaileys('/nonexistent/path/xyz', new MemoryAuthStore()),
    ).rejects.toThrow(/does not exist/);
  });

  it('returns credsLoaded=false on empty directory', async () => {
    const target = new MemoryAuthStore();
    const result = await migrateFromBaileys(src, target);
    expect(result.credsLoaded).toBe(false);
    expect(result.keysMigrated).toBe(0);
  });

  it('migrates creds.json with Buffer fields', async () => {
    writeBaileysJson(join(src, 'creds.json'), {
      noiseKey: { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) },
      registrationId: 555,
      advSecretKey: 'x==',
    });

    const target = new MemoryAuthStore();
    const result = await migrateFromBaileys(src, target);
    expect(result.credsLoaded).toBe(true);

    const loaded = await target.loadState();
    expect(loaded).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = loaded!.creds as any;
    expect(Buffer.isBuffer(c.noiseKey.public)).toBe(true);
    expect((c.noiseKey.public as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(c.registrationId).toBe(555);
  });

  it('migrates signal keys by type', async () => {
    writeBaileysJson(join(src, 'pre-key-1.json'), {
      public: Buffer.from([10]),
      private: Buffer.from([20]),
    });
    writeBaileysJson(join(src, 'pre-key-2.json'), {
      public: Buffer.from([30]),
      private: Buffer.from([40]),
    });
    writeBaileysJson(join(src, 'session-923124166950.1@s.whatsapp.net.json'), Buffer.from([99]));

    const target = new MemoryAuthStore();
    const result = await migrateFromBaileys(src, target);
    expect(result.keysMigrated).toBe(3);

    const prek = await target.getKeys('pre-key', ['1', '2']);
    expect(Object.keys(prek)).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((prek['1'] as any).public as Buffer).equals(Buffer.from([10]))).toBe(true);

    const sess = await target.getKeys('session', ['923124166950.1@s.whatsapp.net']);
    expect(Object.keys(sess)).toHaveLength(1);
  });

  it('matches longest type prefix first (sender-key-memory over sender-key)', async () => {
    writeBaileysJson(join(src, 'sender-key-memory-group1.json'), {
      member1: true,
    });
    writeBaileysJson(join(src, 'sender-key-group1.json'), Buffer.from([1]));

    const target = new MemoryAuthStore();
    const result = await migrateFromBaileys(src, target);
    expect(result.keysMigrated).toBe(2);

    const mem = await target.getKeys('sender-key-memory', ['group1']);
    const sk = await target.getKeys('sender-key', ['group1']);
    expect(mem['group1']).toEqual({ member1: true });
    expect(sk['group1']).toBeDefined();
  });

  it('records unrecognized files in skipped[]', async () => {
    writeBaileysJson(join(src, 'something-weird.json'), { x: 1 });
    writeBaileysJson(join(src, 'random.txt'), 'hello');

    const target = new MemoryAuthStore();
    const result = await migrateFromBaileys(src, target);
    // .txt is skipped because parseBaileysFilename requires .json,
    // and .json with unknown type is skipped.
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('migrates into SQLiteAuthStore end-to-end', async () => {
    writeBaileysJson(join(src, 'creds.json'), {
      noiseKey: { public: Buffer.from([1]), private: Buffer.from([2]) },
      registrationId: 1,
      advSecretKey: 'a==',
    });
    writeBaileysJson(join(src, 'pre-key-7.json'), {
      public: Buffer.from([77]),
      private: Buffer.from([88]),
    });

    const target = new SQLiteAuthStore({ path: ':memory:' });
    try {
      const result = await migrateFromBaileys(src, target);
      expect(result.credsLoaded).toBe(true);
      expect(result.keysMigrated).toBe(1);
      expect(target.keyCount).toBe(1);

      const loaded = await target.loadState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = loaded!.creds as any;
      expect(c.registrationId).toBe(1);
    } finally {
      target.close();
    }
  });
});
