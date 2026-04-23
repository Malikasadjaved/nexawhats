/**
 * Unit tests for LIDMappingStore (Signal/lid-mapping.ts port).
 *
 * Verifies:
 * - Forward (PN→LID) + reverse (LID→PN) round-trip
 * - Device-id transfer semantics (PN device copied to LID output,
 *   LID device copied back to PN output)
 * - Hosted server handling (hosted ↔ hosted.lid)
 * - USync fallback invocation when the mapping is missing
 * - Invalid pairs are skipped with a warn
 * - Cache hit avoids the DB round-trip
 * - Storage batches forward + reverse entries in a single set() call
 */
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIDMappingStore, type PnToLidFunc } from '../../../src/signal/lid-mapping.js';
import type { SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../../../src/types/auth.js';

type Store = Record<string, string>;

function makeKeyStore(seed: Store = {}): {
  store: Store;
  keys: SignalKeyStore;
  getSpy: ReturnType<typeof vi.fn>;
  setSpy: ReturnType<typeof vi.fn>;
} {
  const store: Store = { ...seed };
  const getSpy = vi.fn(async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
    const out: Record<string, SignalDataTypeMap[T]> = {};
    if (type !== 'lid-mapping') return out;
    for (const id of ids) {
      if (id in store) {
        (out as Record<string, string>)[id] = store[id] as string;
      }
    }
    return out;
  });
  const setSpy = vi.fn(async (data: SignalDataSet) => {
    const lm = data['lid-mapping'];
    if (!lm) return;
    for (const [id, value] of Object.entries(lm)) {
      if (value === null) delete store[id];
      else store[id] = value as string;
    }
  });
  const keys: SignalKeyStore = {
    get: getSpy as unknown as SignalKeyStore['get'],
    set: setSpy as unknown as SignalKeyStore['set'],
  };
  return { store, keys, getSpy, setSpy };
}

function silentLogger(): Logger {
  const noop = () => {};
  const l = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => l,
    level: 'silent',
  };
  return l as unknown as Logger;
}

const PN = '923315244441@s.whatsapp.net';
const LID_USER = '197151900590225';
const LID = `${LID_USER}@lid`;

describe('LIDMappingStore.storeLIDPNMappings', () => {
  let env: ReturnType<typeof makeKeyStore>;

  beforeEach(() => {
    env = makeKeyStore();
  });

  it('persists forward + reverse entries in one batched set() call', async () => {
    const store = new LIDMappingStore(env.keys, silentLogger());
    await store.storeLIDPNMappings([{ lid: LID, pn: PN }]);

    expect(env.setSpy).toHaveBeenCalledTimes(1);
    const args = env.setSpy.mock.calls[0]?.[0] as SignalDataSet;
    const lm = args['lid-mapping'] as Record<string, string>;
    expect(lm['923315244441']).toBe(LID_USER);
    expect(lm[`${LID_USER}_reverse`]).toBe('923315244441');
  });

  it('accepts the swapped ordering {lid: PN, pn: LID} (keys follow the pn arg)', async () => {
    // Baileys validates the pair in either direction but always indexes by
    // whichever arg was passed as `pn`. So passing {lid: PN, pn: LID} stores
    // the mapping keyed by the LID user — we preserve that faithfully.
    const store = new LIDMappingStore(env.keys, silentLogger());
    await store.storeLIDPNMappings([{ lid: PN, pn: LID }]);
    expect(env.setSpy).toHaveBeenCalledTimes(1);
    expect(env.store[LID_USER]).toBe('923315244441');
    expect(env.store['923315244441_reverse']).toBe(LID_USER);
  });

  it('skips invalid pairs (both sides PN, both sides LID, junk)', async () => {
    const warn = vi.fn();
    const logger = silentLogger();
    (logger as unknown as { warn: typeof warn }).warn = warn;
    const store = new LIDMappingStore(env.keys, logger);
    await store.storeLIDPNMappings([
      { lid: PN, pn: '923000000000@s.whatsapp.net' },
      { lid: '111@lid', pn: '222@lid' },
      { lid: 'not-a-jid', pn: 'also-not' },
    ]);
    expect(env.setSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('skips when an identical mapping is already cached', async () => {
    const store = new LIDMappingStore(env.keys, silentLogger());
    await store.storeLIDPNMappings([{ lid: LID, pn: PN }]);
    env.setSpy.mockClear();
    await store.storeLIDPNMappings([{ lid: LID, pn: PN }]);
    expect(env.setSpy).not.toHaveBeenCalled();
  });

  it('reads from DB on cache miss before deciding the mapping is new', async () => {
    const env2 = makeKeyStore({
      '923315244441': LID_USER,
      [`${LID_USER}_reverse`]: '923315244441',
    });
    const store = new LIDMappingStore(env2.keys, silentLogger());
    await store.storeLIDPNMappings([{ lid: LID, pn: PN }]);
    expect(env2.setSpy).not.toHaveBeenCalled();
    expect(env2.getSpy).toHaveBeenCalledWith('lid-mapping', ['923315244441']);
  });
});

describe('LIDMappingStore.getLIDForPN', () => {
  it('returns a device-specific LID JID for a plain PN', async () => {
    const env = makeKeyStore({ '923315244441': LID_USER });
    const store = new LIDMappingStore(env.keys, silentLogger());
    const lid = await store.getLIDForPN(PN);
    expect(lid).toBe(`${LID_USER}@lid`);
  });

  it('copies the PN device id onto the returned LID', async () => {
    const env = makeKeyStore({ '923315244441': LID_USER });
    const store = new LIDMappingStore(env.keys, silentLogger());
    const lid = await store.getLIDForPN('923315244441:3@s.whatsapp.net');
    expect(lid).toBe(`${LID_USER}:3@lid`);
  });

  it('returns hosted.lid for hosted PN input', async () => {
    const env = makeKeyStore({ '923315244441': LID_USER });
    const store = new LIDMappingStore(env.keys, silentLogger());
    const lid = await store.getLIDForPN('923315244441@hosted');
    expect(lid).toBe(`${LID_USER}@hosted.lid`);
  });

  it('returns null when no mapping and no USync resolver is configured', async () => {
    const env = makeKeyStore();
    const store = new LIDMappingStore(env.keys, silentLogger());
    const lid = await store.getLIDForPN(PN);
    expect(lid).toBeNull();
  });

  it('hits the cache on the second call (no second DB read)', async () => {
    const env = makeKeyStore({ '923315244441': LID_USER });
    const store = new LIDMappingStore(env.keys, silentLogger());
    await store.getLIDForPN(PN);
    env.getSpy.mockClear();
    await store.getLIDForPN(PN);
    expect(env.getSpy).not.toHaveBeenCalled();
  });

  it('invokes the USync resolver on miss and stores returned pairs', async () => {
    const env = makeKeyStore();
    const resolver: PnToLidFunc = vi.fn(async () => [{ lid: LID, pn: PN }]);
    const store = new LIDMappingStore(env.keys, silentLogger(), resolver);
    const lid = await store.getLIDForPN(PN);
    expect(resolver).toHaveBeenCalledOnce();
    expect(lid).toBe(`${LID_USER}@lid`);
    // subsequent lookup is a cache hit
    env.getSpy.mockClear();
    const again = await store.getLIDForPN(PN);
    expect(again).toBe(`${LID_USER}@lid`);
    expect(env.getSpy).not.toHaveBeenCalled();
  });

  it('ignores non-PN inputs in batch resolution', async () => {
    const env = makeKeyStore({ '923315244441': LID_USER });
    const store = new LIDMappingStore(env.keys, silentLogger());
    const result = await store.getLIDsForPNs([PN, LID, 'not-a-jid']);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.lid).toBe(`${LID_USER}@lid`);
  });
});

describe('LIDMappingStore.getPNForLID', () => {
  it('returns a device-specific PN JID for a plain LID', async () => {
    const env = makeKeyStore({ [`${LID_USER}_reverse`]: '923315244441' });
    const store = new LIDMappingStore(env.keys, silentLogger());
    const pn = await store.getPNForLID(LID);
    expect(pn).toBe('923315244441:0@s.whatsapp.net');
  });

  it('copies the LID device id onto the returned PN', async () => {
    const env = makeKeyStore({ [`${LID_USER}_reverse`]: '923315244441' });
    const store = new LIDMappingStore(env.keys, silentLogger());
    const pn = await store.getPNForLID(`${LID_USER}:5@lid`);
    expect(pn).toBe('923315244441:5@s.whatsapp.net');
  });

  it('rejects hosted.lid input (Baileys isLidUser matches @lid only)', async () => {
    // "foo@hosted.lid".endsWith("@lid") === false, so hosted.lid JIDs are
    // not reverse-resolvable via this path — matches Baileys exactly.
    const env = makeKeyStore({ [`${LID_USER}_reverse`]: '923315244441' });
    const store = new LIDMappingStore(env.keys, silentLogger());
    const pn = await store.getPNForLID(`${LID_USER}@hosted.lid`);
    expect(pn).toBeNull();
  });

  it('returns null for non-LID input', async () => {
    const env = makeKeyStore();
    const store = new LIDMappingStore(env.keys, silentLogger());
    expect(await store.getPNForLID(PN)).toBeNull();
  });

  it('returns null when no reverse mapping is stored', async () => {
    const env = makeKeyStore();
    const store = new LIDMappingStore(env.keys, silentLogger());
    expect(await store.getPNForLID(LID)).toBeNull();
  });

  it('caches the reverse mapping after the first read', async () => {
    const env = makeKeyStore({ [`${LID_USER}_reverse`]: '923315244441' });
    const store = new LIDMappingStore(env.keys, silentLogger());
    await store.getPNForLID(LID);
    env.getSpy.mockClear();
    await store.getPNForLID(`${LID_USER}:7@lid`);
    expect(env.getSpy).not.toHaveBeenCalled();
  });
});

describe('LIDMappingStore round-trip', () => {
  it('store → getLIDForPN → getPNForLID returns the original user', async () => {
    const env = makeKeyStore();
    const store = new LIDMappingStore(env.keys, silentLogger());
    await store.storeLIDPNMappings([{ lid: LID, pn: PN }]);
    const lid = await store.getLIDForPN(PN);
    expect(lid).toBe(`${LID_USER}@lid`);
    const pn = await store.getPNForLID(lid as string);
    expect(pn).toBe('923315244441:0@s.whatsapp.net');
  });
});
