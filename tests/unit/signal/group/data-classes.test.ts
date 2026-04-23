import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BufferJSON,
  SenderChainKey,
  SenderKeyName,
  SenderKeyRecord,
  SenderKeyState,
  SenderMessageKey,
  generateSenderKey,
  generateSenderKeyId,
  generateSenderSigningKey,
} from '../../../../src/signal/group/index.js';

describe('BufferJSON', () => {
  it('round-trips a Buffer via replacer→reviver', () => {
    const original = { key: Buffer.from([1, 2, 3, 4, 5]) };
    const json = JSON.stringify(original, BufferJSON.replacer);
    const restored = JSON.parse(json, BufferJSON.reviver);
    expect(Buffer.isBuffer(restored.key)).toBe(true);
    expect(restored.key.equals(original.key)).toBe(true);
  });

  it('produces the Baileys wire shape', () => {
    const v = Buffer.from('hello');
    const json = JSON.stringify({ v }, BufferJSON.replacer);
    const parsed = JSON.parse(json);
    expect(parsed.v.type).toBe('Buffer');
    expect(parsed.v.data).toBe(v.toString('base64'));
  });

  it('reviver rebuilds legacy numeric-key Buffer objects', () => {
    const legacy = JSON.stringify({ b: { 0: 1, 1: 2, 2: 3 } });
    const out = JSON.parse(legacy, BufferJSON.reviver);
    expect(Buffer.isBuffer(out.b)).toBe(true);
    expect(out.b.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });
});

describe('SenderKeyName', () => {
  const addr = { id: '923315244441', deviceId: 22, toString: () => '923315244441.22' };

  it('serializes with the ::-delimited format', () => {
    const skn = new SenderKeyName('group-abc', addr);
    expect(skn.serialize()).toBe('group-abc::923315244441::22');
    expect(skn.toString()).toBe('group-abc::923315244441::22');
  });

  it('getGroupId and getSender return constructor inputs', () => {
    const skn = new SenderKeyName('G', addr);
    expect(skn.getGroupId()).toBe('G');
    expect(skn.getSender()).toBe(addr);
  });

  it('equals compares groupId and sender.toString()', () => {
    const a = new SenderKeyName('G', addr);
    const b = new SenderKeyName('G', {
      id: 'anything',
      deviceId: 99,
      toString: () => '923315244441.22',
    });
    const c = new SenderKeyName('H', addr);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals(null)).toBe(false);
  });

  it('hashCode is stable for identical inputs and clamps to 32-bit', () => {
    const a = new SenderKeyName('G', addr);
    const b = new SenderKeyName('G', addr);
    expect(a.hashCode()).toBe(b.hashCode());
    const long = new SenderKeyName(
      'a-very-long-group-id-that-overflows-int32-AAAAAAAAAAAAAAAAAAA',
      addr,
    );
    const hc = long.hashCode();
    expect(hc).toBeGreaterThanOrEqual(-0x80000000);
    expect(hc).toBeLessThanOrEqual(0x7fffffff);
    expect(Number.isInteger(hc)).toBe(true);
  });
});

describe('SenderMessageKey', () => {
  it('derives a deterministic (iv, cipherKey) pair from seed', () => {
    const seed = Buffer.alloc(32, 0x07);
    const k1 = new SenderMessageKey(5, seed);
    const k2 = new SenderMessageKey(5, seed);
    expect(k1.getIv().equals(k2.getIv())).toBe(true);
    expect(k1.getCipherKey().equals(k2.getCipherKey())).toBe(true);
    expect(k1.getIteration()).toBe(5);
    expect(k1.getSeed().equals(seed)).toBe(true);
  });

  it('iv is 16 bytes and cipherKey is 32 bytes', () => {
    const k = new SenderMessageKey(0, Buffer.alloc(32, 0x42));
    expect(k.getIv().length).toBe(16);
    expect(k.getCipherKey().length).toBe(32);
  });

  it('different seeds produce different keys', () => {
    const a = new SenderMessageKey(0, Buffer.alloc(32, 0x01));
    const b = new SenderMessageKey(0, Buffer.alloc(32, 0x02));
    expect(a.getCipherKey().equals(b.getCipherKey())).toBe(false);
  });
});

describe('SenderChainKey', () => {
  const seed = Buffer.alloc(32, 0x11);

  it('getIteration + getSeed echo the constructor values', () => {
    const ck = new SenderChainKey(3, seed);
    expect(ck.getIteration()).toBe(3);
    expect(ck.getSeed().equals(seed)).toBe(true);
  });

  it('getNext() advances iteration by 1 and changes the seed', () => {
    const ck = new SenderChainKey(0, seed);
    const next = ck.getNext();
    expect(next.getIteration()).toBe(1);
    expect(next.getSeed().equals(seed)).toBe(false);
    expect(next.getSeed().length).toBe(32);
  });

  it('getSenderMessageKey() returns a SenderMessageKey at the same iteration', () => {
    const ck = new SenderChainKey(7, seed);
    const mk = ck.getSenderMessageKey();
    expect(mk).toBeInstanceOf(SenderMessageKey);
    expect(mk.getIteration()).toBe(7);
  });

  it('advancing the chain is deterministic — two runs match', () => {
    const a = new SenderChainKey(0, seed).getNext().getNext().getNext();
    const b = new SenderChainKey(0, seed).getNext().getNext().getNext();
    expect(a.getSeed().equals(b.getSeed())).toBe(true);
  });
});

describe('SenderKeyState', () => {
  it('builds from primitives when no structure is supplied', () => {
    const signingPub = randomBytes(33);
    const signingPriv = randomBytes(32);
    const chainKey = randomBytes(32);
    const state = new SenderKeyState(42, 0, chainKey, null, signingPub, signingPriv);
    expect(state.getKeyId()).toBe(42);
    expect(state.getSenderChainKey().getIteration()).toBe(0);
    expect(state.getSigningKeyPublic().equals(signingPub)).toBe(true);
    expect(state.getSigningKeyPrivate().equals(signingPriv)).toBe(true);
  });

  it('accepts a keypair object in place of public/private', () => {
    const keyPair = { public: randomBytes(33), private: randomBytes(32) };
    const state = new SenderKeyState(1, 0, Buffer.alloc(32), keyPair);
    expect(state.getSigningKeyPublic().equals(keyPair.public)).toBe(true);
  });

  it('32-byte signing public key is prefixed with 0x05 to reach 33 bytes', () => {
    const pub32 = randomBytes(32);
    const state = new SenderKeyState(1, 0, Buffer.alloc(32), null, pub32, randomBytes(32));
    const out = state.getSigningKeyPublic();
    expect(out.length).toBe(33);
    expect(out[0]).toBe(0x05);
    expect(out.slice(1).equals(pub32)).toBe(true);
  });

  it('addSenderMessageKey / hasSenderMessageKey / removeSenderMessageKey', () => {
    const state = new SenderKeyState(
      1,
      0,
      Buffer.alloc(32),
      null,
      Buffer.alloc(33),
      Buffer.alloc(32),
    );
    expect(state.hasSenderMessageKey(5)).toBe(false);

    const mk = new SenderMessageKey(5, Buffer.alloc(32, 0x09));
    state.addSenderMessageKey(mk);
    expect(state.hasSenderMessageKey(5)).toBe(true);

    const removed = state.removeSenderMessageKey(5);
    expect(removed).not.toBeNull();
    expect(removed?.getIteration()).toBe(5);
    expect(state.hasSenderMessageKey(5)).toBe(false);
    expect(state.removeSenderMessageKey(99)).toBeNull();
  });

  it('setSenderChainKey swaps the chain key', () => {
    const state = new SenderKeyState(
      1,
      0,
      Buffer.alloc(32),
      null,
      Buffer.alloc(33),
      Buffer.alloc(32),
    );
    const nextCk = new SenderChainKey(7, Buffer.alloc(32, 0xff));
    state.setSenderChainKey(nextCk);
    const got = state.getSenderChainKey();
    expect(got.getIteration()).toBe(7);
    expect(got.getSeed().equals(Buffer.alloc(32, 0xff))).toBe(true);
  });

  it('getStructure exposes the internal serializable shape', () => {
    const state = new SenderKeyState(
      1,
      0,
      Buffer.alloc(32),
      null,
      Buffer.alloc(33),
      Buffer.alloc(32),
    );
    const s = state.getStructure();
    expect(s.senderKeyId).toBe(1);
    expect(Array.isArray(s.senderMessageKeys)).toBe(true);
  });

  it('rebuilds from a serialized structure', () => {
    const src = new SenderKeyState(
      1,
      0,
      Buffer.alloc(32),
      null,
      Buffer.alloc(33),
      Buffer.alloc(32),
    );
    src.addSenderMessageKey(new SenderMessageKey(1, Buffer.alloc(32, 0xab)));
    const structure = src.getStructure();
    const rebuilt = new SenderKeyState(null, null, null, null, null, null, structure);
    expect(rebuilt.getKeyId()).toBe(1);
    expect(rebuilt.hasSenderMessageKey(1)).toBe(true);
  });
});

describe('SenderKeyRecord', () => {
  function makeRecord(id = 1, chainSeed = 0xaa, signPub = 0xbb): SenderKeyRecord {
    const r = new SenderKeyRecord();
    r.setSenderKeyState(id, 0, Buffer.alloc(32, chainSeed), {
      public: Buffer.alloc(33, signPub),
      private: Buffer.alloc(32, signPub),
    });
    return r;
  }

  it('starts empty', () => {
    expect(new SenderKeyRecord().isEmpty()).toBe(true);
  });

  it('setSenderKeyState replaces all states with one', () => {
    const r = new SenderKeyRecord();
    r.setSenderKeyState(1, 0, Buffer.alloc(32), {
      public: Buffer.alloc(33),
      private: Buffer.alloc(32),
    });
    r.setSenderKeyState(2, 0, Buffer.alloc(32), {
      public: Buffer.alloc(33),
      private: Buffer.alloc(32),
    });
    expect(r.getSenderKeyState()?.getKeyId()).toBe(2);
    expect(r.serialize().length).toBe(1);
  });

  it('addSenderKeyState appends and caps at MAX_STATES (5)', () => {
    const r = new SenderKeyRecord();
    for (let i = 1; i <= 7; i++) {
      r.addSenderKeyState(i, 0, Buffer.alloc(32, i), Buffer.alloc(33, i));
    }
    expect(r.serialize().length).toBe(5);
    // Oldest (1, 2) dropped; newest (7) at tail
    expect(r.getSenderKeyState()?.getKeyId()).toBe(7);
    expect(r.getSenderKeyState(1)).toBeUndefined();
    expect(r.getSenderKeyState(3)?.getKeyId()).toBe(3);
  });

  it('getSenderKeyState() with no args returns the most recent', () => {
    const r = new SenderKeyRecord();
    r.addSenderKeyState(10, 0, Buffer.alloc(32), Buffer.alloc(33));
    r.addSenderKeyState(11, 0, Buffer.alloc(32), Buffer.alloc(33));
    expect(r.getSenderKeyState()?.getKeyId()).toBe(11);
  });

  it('serialize → JSON → deserialize round-trip via BufferJSON', () => {
    const r = makeRecord(99, 0xcc, 0xdd);
    const json = JSON.stringify(r.serialize(), BufferJSON.replacer);
    const rebuilt = SenderKeyRecord.deserialize(Buffer.from(json, 'utf-8'));
    expect(rebuilt.isEmpty()).toBe(false);
    const state = rebuilt.getSenderKeyState(99);
    expect(state).toBeDefined();
    expect(state?.getKeyId()).toBe(99);
    expect(state?.getSenderChainKey().getSeed().equals(Buffer.alloc(32, 0xcc))).toBe(true);
  });

  it('deserialize handles empty array', () => {
    const r = SenderKeyRecord.deserialize(Buffer.from('[]', 'utf-8'));
    expect(r.isEmpty()).toBe(true);
  });
});

describe('keyhelper', () => {
  it('generateSenderKey returns 32 random bytes', () => {
    const k = generateSenderKey();
    expect(Buffer.isBuffer(k)).toBe(true);
    expect(k.length).toBe(32);
    const k2 = generateSenderKey();
    expect(k.equals(k2)).toBe(false);
  });

  it('generateSenderKeyId returns a positive 31-bit int', () => {
    for (let i = 0; i < 10; i++) {
      const id = generateSenderKeyId();
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(2147483647);
    }
  });

  it('generateSenderSigningKey returns Buffers for public + private', () => {
    const k = generateSenderSigningKey();
    expect(Buffer.isBuffer(k.public)).toBe(true);
    expect(Buffer.isBuffer(k.private)).toBe(true);
    expect(k.public.length).toBeGreaterThan(0);
    expect(k.private.length).toBeGreaterThan(0);
  });

  it('generateSenderSigningKey passes through an existing key pair', () => {
    const pub = randomBytes(33);
    const priv = randomBytes(32);
    const k = generateSenderSigningKey({ pubKey: pub, privKey: priv });
    expect(k.public.equals(pub)).toBe(true);
    expect(k.private.equals(priv)).toBe(true);
  });
});
