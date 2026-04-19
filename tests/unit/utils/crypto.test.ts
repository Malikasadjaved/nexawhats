import { describe, expect, it } from 'vitest';
import {
  Curve,
  aesDecryptGCM,
  aesEncryptGCM,
  hkdf,
  hmacSha256,
  hmacSign,
  md5,
  sha1,
  sha256,
} from '../../../src/utils/crypto.js';

describe('hkdf', () => {
  it('RFC 5869 vector A.1 (SHA-256)', () => {
    // IKM = 0x0b*22, salt = 0x00..0x0c, info = 0xf0..0xf9, L = 42
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
    const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
    const expected =
      '3cb25f25faacd57a90434f64d0362f2a' +
      '2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
      '34007208d5b887185865';
    const out = hkdf(ikm, 42, { salt, info });
    expect(out.toString('hex')).toBe(expected);
  });

  it('object-form and positional-form agree', () => {
    const ikm = Buffer.from('input keying material');
    const salt = Buffer.alloc(32, 0x11);
    const info = Buffer.from('nexawhats-test');

    const objForm = hkdf(ikm, 64, { salt, info });
    const posForm = hkdf(ikm, 64, info, salt);
    expect(objForm.equals(posForm)).toBe(true);
  });
});

describe('AES-GCM', () => {
  it('round-trips plaintext', () => {
    const key = Buffer.alloc(32, 0x42);
    const iv = Buffer.alloc(12, 0x24);
    const aad = Buffer.from('aad');
    const pt = Buffer.from('the quick brown fox jumps over the lazy dog');

    const ct = aesEncryptGCM(pt, key, iv, aad);
    const recovered = aesDecryptGCM(ct, key, iv, aad);
    expect(recovered.equals(pt)).toBe(true);
  });

  it('tampered ciphertext fails authentication', () => {
    const key = Buffer.alloc(32, 0x42);
    const iv = Buffer.alloc(12, 0x24);
    const aad = Buffer.from('aad');
    const pt = Buffer.from('secret');

    const ct = Buffer.from(aesEncryptGCM(pt, key, iv, aad));
    ct[0] ^= 0xff; // flip a plaintext byte
    expect(() => aesDecryptGCM(ct, key, iv, aad)).toThrow();
  });

  it('wrong AAD fails authentication', () => {
    const key = Buffer.alloc(32, 0x42);
    const iv = Buffer.alloc(12, 0x24);
    const pt = Buffer.from('secret');

    const ct = aesEncryptGCM(pt, key, iv, Buffer.from('aad-a'));
    expect(() => aesDecryptGCM(ct, key, iv, Buffer.from('aad-b'))).toThrow();
  });
});

describe('Hashes', () => {
  it('sha256 of empty buffer', () => {
    expect(sha256(Buffer.alloc(0)).toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('sha1 of "abc"', () => {
    expect(sha1(Buffer.from('abc')).toString('hex')).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
  });

  it('md5 of empty buffer', () => {
    expect(md5(Buffer.alloc(0)).toString('hex')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('hmacSha256 agrees with hmacSign default variant', () => {
    const key = Buffer.from('k');
    const data = Buffer.from('d');
    expect(hmacSha256(key, data).equals(hmacSign(data, key))).toBe(true);
  });
});

describe('Curve (X25519)', () => {
  it('generates 32-byte raw keypairs', () => {
    const kp = Curve.generateKeyPair();
    expect(kp.public.length).toBe(32);
    expect(kp.private.length).toBe(32);
  });

  it('shared secret is symmetric (Alice+Bob agree)', () => {
    const alice = Curve.generateKeyPair();
    const bob = Curve.generateKeyPair();
    const s1 = Curve.sharedKey(alice.private, bob.public);
    const s2 = Curve.sharedKey(bob.private, alice.public);
    expect(s1.equals(s2)).toBe(true);
  });

  it('strips 0x05 version byte from 33-byte public keys', () => {
    const alice = Curve.generateKeyPair();
    const bob = Curve.generateKeyPair();
    const bob33 = Buffer.concat([Buffer.from([5]), bob.public]);
    const s1 = Curve.sharedKey(alice.private, bob.public);
    const s2 = Curve.sharedKey(alice.private, bob33);
    expect(s1.equals(s2)).toBe(true);
  });
});
