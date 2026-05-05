import { describe, expect, it } from 'vitest';
import { initAuthCreds } from '../../../src/utils/auth.js';
import { Curve } from '../../../src/utils/crypto.js';

describe('initAuthCreds', () => {
  it('produces a fresh credential bundle with valid key shapes', () => {
    const creds = initAuthCreds();

    expect(creds.noiseKey.public.length).toBe(32);
    expect(creds.noiseKey.private.length).toBe(32);
    expect(creds.pairingEphemeralKeyPair.public.length).toBe(32);
    expect(creds.signedIdentityKey.public.length).toBe(32);
    expect(creds.signedIdentityKey.private.length).toBe(32);

    expect(creds.signedPreKey.keyPair.public.length).toBe(32);
    expect(creds.signedPreKey.keyPair.private.length).toBe(32);
    expect(creds.signedPreKey.keyId).toBe(1);
    expect(creds.signedPreKey.signature.length).toBeGreaterThan(0);
  });

  it('produces a registration id in the 14-bit WhatsApp range', () => {
    for (let i = 0; i < 20; i++) {
      const { registrationId } = initAuthCreds();
      expect(Number.isInteger(registrationId)).toBe(true);
      expect(registrationId).toBeGreaterThanOrEqual(0);
      expect(registrationId).toBeLessThan(16384);
    }
  });

  it('signs the signed pre-key with the identity key', () => {
    const creds = initAuthCreds();
    const { keyPair, signature } = creds.signedPreKey;
    const prefixedPub = Buffer.concat([Buffer.from([0x05]), Buffer.from(keyPair.public)]);
    expect(
      Curve.verify(
        Buffer.from(creds.signedIdentityKey.public),
        prefixedPub,
        Buffer.from(signature),
      ),
    ).toBe(true);
  });

  it('seeds all counters and flags to registered=false defaults', () => {
    const creds = initAuthCreds();
    expect(creds.registered).toBe(false);
    expect(creds.nextPreKeyId).toBe(1);
    expect(creds.firstUnuploadedPreKeyId).toBe(1);
    expect(creds.accountSyncCounter).toBe(0);
    expect(creds.accountSettings.unarchiveChats).toBe(false);
    expect(creds.processedHistoryMessages).toEqual([]);
    expect(creds.me).toBeUndefined();
    expect(creds.pairingCode).toBeUndefined();
    expect(creds.routingInfo).toBeUndefined();
  });

  it('returns unique key material on each call', () => {
    const a = initAuthCreds();
    const b = initAuthCreds();
    expect(Buffer.from(a.noiseKey.private).equals(Buffer.from(b.noiseKey.private))).toBe(false);
  });
});
