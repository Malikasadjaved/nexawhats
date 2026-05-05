/**
 * Pairing module unit tests — Crockford encoding, pairing code
 * generation, pairing key encryption, and IQ building.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPairDeviceIQ,
  bytesToCrockford,
  derivePairingCodeKey,
  generatePairingCode,
  generatePairingKey,
} from '../../../src/socket/pairing.js';

// ── bytesToCrockford ────────────────────────────────────────────────
describe('bytesToCrockford', () => {
  it('encodes 5 zero bytes to all 1s', () => {
    const result = bytesToCrockford(Buffer.alloc(5, 0));
    expect(result.length).toBe(8);
    expect(result).toBe('11111111');
  });

  it('encodes a known buffer deterministically', () => {
    const result = bytesToCrockford(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    expect(result.length).toBe(8);
    // Verify round-trip determinism: same input → same output
    const r2 = bytesToCrockford(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    expect(result).toBe(r2);
  });

  it('encodes a single byte to 2 chars', () => {
    // 0xFF = 11111111 → grouped: 11111 11100 → 31 28 → Z D... wait
    // Actually: value=255, bitCount=8. 8 >= 5: shift right 3 = 31 = Z. bitCount=3.
    // Then: value << 2 = 255 << 2 = 1020. 1020 & 31 = 28. → C (wait, C is not in Crockford)
    // Crockford: 123456789ABCDEFGHJKLMNPQRSTVWXYZ → position 28 is X or Y?
    // Let me count: 0=1, 1=2, 2=3, 3=4, 4=5, 5=6, 6=7, 7=8, 8=9, 9=A, 10=B, 11=C, 12=D, 13=E, 14=F, 15=G, 16=H, 17=J, 18=K, 19=L, 20=M, 21=N, 22=P, 23=Q, 24=R, 25=S, 26=T, 27=V, 28=W, 29=X, 30=Y, 31=Z
    // So position 28 = W. 255 = 0xFF should be 'ZW'
    expect(bytesToCrockford(Buffer.from([0xff]))).toBe('ZW');
  });

  it('return length is ceil(bytes * 8 / 5)', () => {
    for (const len of [1, 2, 3, 4, 5, 10]) {
      const buf = Buffer.alloc(len, 0xab);
      const result = bytesToCrockford(buf);
      expect(result.length).toBe(Math.ceil((len * 8) / 5));
    }
  });
});

// ── generatePairingCode ─────────────────────────────────────────────
describe('generatePairingCode', () => {
  it('generates an 8-character string', () => {
    const code = generatePairingCode();
    expect(code.length).toBe(8);
    expect(typeof code).toBe('string');
  });

  it('generates only Crockford characters', () => {
    const validChars = new Set('123456789ABCDEFGHJKLMNPQRSTVWXYZ');
    const code = generatePairingCode();
    for (const ch of code) {
      expect(validChars.has(ch)).toBe(true);
    }
  });

  it('generates different codes on each call (probabilistic)', () => {
    const codes = new Set(Array.from({ length: 10 }, () => generatePairingCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ── derivePairingCodeKey ────────────────────────────────────────────
describe('derivePairingCodeKey', () => {
  it('derives a 32-byte key', async () => {
    const key = await derivePairingCodeKey('12345678', Buffer.alloc(32, 0x42));
    expect(key.length).toBe(32);
  });

  it('derives different keys for different codes', async () => {
    const salt = Buffer.alloc(32, 0x42);
    const k1 = await derivePairingCodeKey('12345678', salt);
    const k2 = await derivePairingCodeKey('87654321', salt);
    expect(k1.equals(k2)).toBe(false);
  });

  it('derives different keys for different salts', async () => {
    const k1 = await derivePairingCodeKey('12345678', Buffer.alloc(32, 0x42));
    const k2 = await derivePairingCodeKey('12345678', Buffer.alloc(32, 0x77));
    expect(k1.equals(k2)).toBe(false);
  });

  it('is deterministic — same inputs → same key', async () => {
    const code = '12345678';
    const salt = Buffer.alloc(32, 0x99);
    const k1 = await derivePairingCodeKey(code, salt);
    const k2 = await derivePairingCodeKey(code, salt);
    expect(k1.equals(k2)).toBe(true);
  });
});

// ── generatePairingKey ──────────────────────────────────────────────
describe('generatePairingKey', () => {
  it('returns a buffer with salt(32) + iv(16) + ciphertext(len)', async () => {
    const pubKey = Buffer.alloc(32, 0xcc);
    const result = await generatePairingKey('12345678', pubKey);

    // 32 salt + 16 iv + 32 plaintext (aligned, no padding in CTR mode)
    expect(result.length).toBe(32 + 16 + 32);
  });

  it('produces different results on each call (random salt + iv)', async () => {
    const pubKey = Buffer.alloc(32, 0xcc);
    const r1 = await generatePairingKey('12345678', pubKey);
    const r2 = await generatePairingKey('12345678', pubKey);
    expect(r1.equals(r2)).toBe(false);
  });

  it('can round-trip decrypt the public key', async () => {
    const pubKey = Buffer.alloc(32, 0xde);
    const result = await generatePairingKey('12345678', pubKey);

    const salt = result.subarray(0, 32);
    const iv = result.subarray(32, 48);
    const ciphertext = result.subarray(48);

    const key = await derivePairingCodeKey('12345678', salt);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createDecipheriv } = require('node:crypto') as {
      createDecipheriv(
        algo: string,
        key: Uint8Array,
        iv: Uint8Array,
      ): {
        update(data: Uint8Array): Buffer;
        final(): Buffer;
      };
    };
    const decipher = createDecipheriv('aes-256-ctr', key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    expect(decrypted.equals(pubKey)).toBe(true);
  });
});

// ── buildPairDeviceIQ ───────────────────────────────────────────────
describe('buildPairDeviceIQ', () => {
  const mockCreds = {
    noiseKey: { public: Buffer.alloc(32, 0x11), private: Buffer.alloc(32, 0x22) },
    pairingEphemeralKeyPair: {
      public: Buffer.alloc(32, 0x33),
      private: Buffer.alloc(32, 0x44),
    },
    pairingCode: 'ABCDEFGH',
  };

  it('builds an IQ stanza with correct attrs', async () => {
    const iq = await buildPairDeviceIQ({
      phoneNumber: '1234567890',
      creds: mockCreds,
      browser: ['Ubuntu', 'Chrome', '22.04.4'] as const,
    });

    expect(iq.tag).toBe('iq');
    expect(iq.attrs.to).toBe('@s.whatsapp.net');
    expect(iq.attrs.type).toBe('set');
    expect(iq.attrs.xmlns).toBe('md');
    expect(typeof iq.attrs.id).toBe('string');
  });

  it('contains link_code_companion_reg with correct child tags', async () => {
    const iq = await buildPairDeviceIQ({
      phoneNumber: '1234567890',
      creds: mockCreds,
      browser: ['Ubuntu', 'Chrome', '22.04.4'] as const,
    });

    const content = iq.content as Array<{ tag: string }>;
    const reg = content.find((c) => c.tag === 'link_code_companion_reg');
    expect(reg).toBeDefined();

    const regContent = (reg as { content: Array<{ tag: string }> }).content;
    const childTags = regContent.map((c) => c.tag);
    expect(childTags).toContain('link_code_pairing_wrapped_companion_ephemeral_pub');
    expect(childTags).toContain('companion_server_auth_key_pub');
    expect(childTags).toContain('companion_platform_id');
    expect(childTags).toContain('companion_platform_display');
    expect(childTags).toContain('link_code_pairing_nonce');
  });
});
