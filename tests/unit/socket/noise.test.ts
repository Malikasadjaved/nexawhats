import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNoiseHandler } from '../../../src/socket/noise.js';

// A Pino-shaped no-op logger. The noise handler calls
// `parentLogger.child({ class: 'ns' })` once, so we return self.
// biome-ignore lint/suspicious/noExplicitAny: minimal pino stub
const silentLogger: any = {
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  level: 'silent',
};

interface FixtureStep {
  op: 'authenticate' | 'mixIntoKey' | 'encrypt' | 'encodeFrame' | 'finishInit';
  data?: string;
  plaintext?: string;
  ciphertext?: string;
  frame?: string;
}

interface NoiseFixture {
  keyPair: { private: string; public: string };
  steps: FixtureStep[];
}

function loadFixture(name: string): NoiseFixture {
  const path = resolve(__dirname, '../../fixtures/noise', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as NoiseFixture;
}

describe('makeNoiseHandler — byte-identical replay of Baileys fixtures', () => {
  it('matches every step in basic.json', async () => {
    const fixture = loadFixture('basic');

    const handler = makeNoiseHandler({
      keyPair: {
        private: Buffer.from(fixture.keyPair.private, 'hex'),
        public: Buffer.from(fixture.keyPair.public, 'hex'),
      },
      logger: silentLogger,
    });

    for (const [index, step] of fixture.steps.entries()) {
      switch (step.op) {
        case 'authenticate': {
          const data = Buffer.from(step.data ?? '', 'hex');
          handler.authenticate(data);
          break;
        }
        case 'mixIntoKey': {
          const data = Buffer.from(step.data ?? '', 'hex');
          await handler.mixIntoKey(data);
          break;
        }
        case 'encrypt': {
          const plain = Buffer.from(step.plaintext ?? '', 'hex');
          const expected = Buffer.from(step.ciphertext ?? '', 'hex');
          const actual = handler.encrypt(plain);
          expect(
            actual.equals(expected),
            `step ${index} (encrypt): expected ${expected.toString('hex')}, got ${actual.toString('hex')}`,
          ).toBe(true);
          break;
        }
        case 'encodeFrame': {
          const data = Buffer.from(step.data ?? '', 'hex');
          const expected = Buffer.from(step.frame ?? '', 'hex');
          const actual = handler.encodeFrame(data);
          expect(
            actual.equals(expected),
            `step ${index} (encodeFrame): expected ${expected.toString('hex')}, got ${actual.toString('hex')}`,
          ).toBe(true);
          break;
        }
        case 'finishInit': {
          await handler.finishInit();
          expect(handler.isFinished()).toBe(true);
          break;
        }
      }
    }
  });
});

describe('makeNoiseHandler — self-consistent encrypt/decrypt round-trip', () => {
  it('pre-handshake encrypt then decrypt returns the original plaintext', () => {
    const key: { private: Buffer; public: Buffer } = {
      private: Buffer.alloc(32, 0x07),
      public: Buffer.alloc(32, 0x09),
    };
    const a = makeNoiseHandler({ keyPair: key, logger: silentLogger });

    // Build a "peer" handler whose starting state is forced to match by
    // replaying the same public-key authenticate() sequence — noise
    // handshake hash begins with NOISE_MODE, NOISE_HEADER, publicKey.
    // Since both handlers are seeded with identical key + defaults,
    // their hash/keys are identical before any mixIntoKey call.
    const b = makeNoiseHandler({ keyPair: key, logger: silentLogger });

    const plaintext = Buffer.from('nexawhats round-trip');
    const ct = a.encrypt(plaintext);
    // B's decrypt uses writeCounter (pre-handshake). Same starting
    // state means the same IV and same key — B must be able to decrypt.
    const recovered = b.decrypt(ct);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('finishInit flips the handler into the finished state', async () => {
    const key = { private: Buffer.alloc(32, 0x07), public: Buffer.alloc(32, 0x09) };
    const h = makeNoiseHandler({ keyPair: key, logger: silentLogger });
    expect(h.isFinished()).toBe(false);

    const dh = Buffer.alloc(32, 0x42);
    await h.mixIntoKey(dh);
    await h.finishInit();
    expect(h.isFinished()).toBe(true);

    // After finishInit the hash is cleared to zero length (the AAD
    // becomes empty) and counters reset — encrypting a known message
    // yields a deterministic output that round-trips through decrypt
    // only when read/write counters stay in lockstep. We simulate the
    // peer by having a mirror-image handler drive its own decrypt
    // using the same enc key: since finishInit splits into distinct
    // write/read keys (initiator != responder), we cannot cross-
    // decrypt. Instead we check that encrypting the same plaintext
    // twice yields DIFFERENT ciphertexts (counter advances).
    const msg = Buffer.from('post-handshake msg');
    const ct1 = h.encrypt(msg);
    const ct2 = h.encrypt(msg);
    expect(ct1.equals(ct2)).toBe(false);
  });
});

describe('makeNoiseHandler — framing behaviour', () => {
  it('prepends NOISE_HEADER only on the first frame', () => {
    const key = { private: Buffer.alloc(32, 0x07), public: Buffer.alloc(32, 0x09) };
    const handler = makeNoiseHandler({ keyPair: key, logger: silentLogger });

    const first = handler.encodeFrame(Buffer.from('x'));
    const second = handler.encodeFrame(Buffer.from('x'));

    // First frame length = 4 (NOISE_WA_HEADER) + 3 (size) + 1 (payload) = 8
    expect(first.length).toBe(8);
    // Second frame length = 3 (size) + 1 (payload) = 4
    expect(second.length).toBe(4);

    // Header is the first 4 bytes of the first frame.
    expect(first.subarray(0, 4)).toEqual(Buffer.from([87, 65, 6, 3]));
  });

  it('writes a 24-bit big-endian length prefix', () => {
    const key = { private: Buffer.alloc(32, 0x07), public: Buffer.alloc(32, 0x09) };
    const handler = makeNoiseHandler({ keyPair: key, logger: silentLogger });

    // Burn off the intro on the first call.
    handler.encodeFrame(Buffer.from([]));

    const payload = Buffer.alloc(300, 0xab);
    const framed = handler.encodeFrame(payload);
    // No intro on the second frame, so bytes 0..3 are the 24-bit length.
    const hi = framed.readUInt8(0);
    const lo = framed.readUInt16BE(1);
    expect((hi << 16) | lo).toBe(300);
  });
});
