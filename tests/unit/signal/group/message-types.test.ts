import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CiphertextMessage,
  SenderKeyDistributionMessage,
  SenderKeyMessage,
} from '../../../../src/signal/group/index.js';

const fixturePath = resolve(__dirname, '../../../fixtures/signal/senderkey.local.json');
const haveFixture = existsSync(fixturePath);

// These tests require the Baileys-captured fixture. In environments
// that lack it the suite skips cleanly.
const describeIf = haveFixture ? describe : describe.skip;

describe('CiphertextMessage protocol constants', () => {
  it('matches the Signal protocol wire-format type IDs', () => {
    const c = new CiphertextMessage();
    expect(c.CURRENT_VERSION).toBe(3);
    expect(c.WHISPER_TYPE).toBe(2);
    expect(c.PREKEY_TYPE).toBe(3);
    expect(c.SENDERKEY_TYPE).toBe(4);
    expect(c.SENDERKEY_DISTRIBUTION_TYPE).toBe(5);
  });
});

describeIf('SenderKeyDistributionMessage — parse Baileys senderkey fixture', () => {
  // The capture script records the raw axolotl bytes directly (version
  // byte 0x33 + protobuf body). No envelope unwrapping required.
  function readAxolotlBytes(): Buffer {
    const fx = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    return Buffer.from(fx.input.axolotlSenderKeyDistributionMessage, 'hex');
  }
  const bytes = haveFixture ? readAxolotlBytes() : Buffer.alloc(0);

  it('decodes version byte + protobuf body without throwing', () => {
    expect(bytes.length).toBeGreaterThan(0);
    // First byte encodes (CURRENT_VERSION << 4) | CURRENT_VERSION = 0x33
    expect(bytes[0]).toBe(0x33);
    const m = new SenderKeyDistributionMessage(null, null, null, null, bytes);
    expect(m.serialize().equals(bytes)).toBe(true);
  });

  it('exposes integer id + iteration', () => {
    const m = new SenderKeyDistributionMessage(null, null, null, null, bytes);
    expect(Number.isInteger(m.getId())).toBe(true);
    expect(Number.isInteger(m.getIteration())).toBe(true);
    expect(m.getIteration()).toBeGreaterThanOrEqual(0);
  });

  it('chainKey is a 32-byte Buffer', () => {
    const m = new SenderKeyDistributionMessage(null, null, null, null, bytes);
    const ck = m.getChainKey();
    expect(Buffer.isBuffer(ck)).toBe(true);
    expect(ck.length).toBe(32);
  });

  it('signatureKey is a Buffer (33 bytes — compressed Ed25519)', () => {
    const m = new SenderKeyDistributionMessage(null, null, null, null, bytes);
    const sk = m.getSignatureKey();
    expect(Buffer.isBuffer(sk)).toBe(true);
    expect(sk.length).toBe(33);
  });

  it('getType returns SENDERKEY_DISTRIBUTION_TYPE (5)', () => {
    const m = new SenderKeyDistributionMessage(null, null, null, null, bytes);
    expect(m.getType()).toBe(5);
  });
});

describeIf('SenderKeyMessage + SenderKeyDistributionMessage — construct from fields', () => {
  // Build a synthetic distribution message from fields and verify that
  // parsing its serialized form reproduces the same values. No libsignal
  // keys required — protobuf + version byte only.
  it('round-trips SenderKeyDistributionMessage construct → parse', () => {
    const id = 424242;
    const iteration = 7;
    const chainKey = Buffer.alloc(32, 0xcd);
    const signingKey = Buffer.alloc(33, 0x05);
    const built = new SenderKeyDistributionMessage(id, iteration, chainKey, signingKey);
    const parsed = new SenderKeyDistributionMessage(null, null, null, null, built.serialize());
    expect(parsed.getId()).toBe(id);
    expect(parsed.getIteration()).toBe(iteration);
    expect(parsed.getChainKey().equals(chainKey)).toBe(true);
    expect(parsed.getSignatureKey().equals(signingKey)).toBe(true);
  });

  // For SenderKeyMessage we need a libsignal keypair to sign. Keep the
  // test minimal and check that (a) construction from fields produces
  // a well-formed frame, and (b) parsing that frame recovers the
  // integer + ciphertext fields.
  it('round-trips SenderKeyMessage construct → parse (field fidelity)', async () => {
    const { generateKeyPair } = await import('libsignal/src/curve.js');
    const kp = generateKeyPair();
    const keyId = 99;
    const iteration = 3;
    const ciphertext = Buffer.from('hello-ciphertext-bytes');

    const built = new SenderKeyMessage(keyId, iteration, ciphertext, kp.privKey);
    expect(built.getType()).toBe(4);
    expect(built.serialize().length).toBeGreaterThan(
      1 + ciphertext.length + built.SIGNATURE_LENGTH,
    );

    const parsed = new SenderKeyMessage(null, null, null, null, built.serialize());
    expect(parsed.getKeyId()).toBe(keyId);
    expect(parsed.getIteration()).toBe(iteration);
    expect(parsed.getCipherText().equals(ciphertext)).toBe(true);

    // Verify signature with the public key (prefixed with 0x05 as a
    // compressed curve25519 key — libsignal accepts either form via
    // `verifySignature`).
    const pub =
      kp.pubKey.length === 33 ? kp.pubKey : Buffer.concat([Buffer.from([0x05]), kp.pubKey]);
    expect(() => parsed.verifySignature(pub)).not.toThrow();
  });

  it('SenderKeyMessage.verifySignature throws on tampered signature', async () => {
    const { generateKeyPair } = await import('libsignal/src/curve.js');
    const kp = generateKeyPair();
    const built = new SenderKeyMessage(1, 0, Buffer.from('aaaa'), kp.privKey);
    const tampered = Buffer.from(built.serialize());
    // Flip one byte in the 64-byte signature at the tail — this
    // keeps the protobuf body parseable so the check fails at
    // verifySignature (not at decode).
    tampered[tampered.length - 1] ^= 0xff;
    const parsed = new SenderKeyMessage(null, null, null, null, tampered);
    const pub =
      kp.pubKey.length === 33 ? kp.pubKey : Buffer.concat([Buffer.from([0x05]), kp.pubKey]);
    expect(() => parsed.verifySignature(pub)).toThrow('Invalid signature!');
  });
});
