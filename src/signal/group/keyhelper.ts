import * as nodeCrypto from 'node:crypto';
import { type KeyPair, generateKeyPair } from 'libsignal/src/curve.js';

/**
 * keyhelper — sender-key generation helpers.
 *
 * Ported verbatim from Baileys `Signal/Group/keyhelper.js`.
 */

export function generateSenderKey(): Buffer {
  return nodeCrypto.randomBytes(32);
}

export function generateSenderKeyId(): number {
  return nodeCrypto.randomInt(2147483647);
}

export interface SigningKeyPair {
  public: Buffer;
  private: Buffer;
}

export function generateSenderSigningKey(key?: KeyPair): SigningKeyPair {
  const kp = key ?? generateKeyPair();
  return {
    public: Buffer.from(kp.pubKey),
    private: Buffer.from(kp.privKey),
  };
}
