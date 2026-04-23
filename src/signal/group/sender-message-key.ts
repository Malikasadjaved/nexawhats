import { deriveSecrets } from 'libsignal/src/crypto.js';

/**
 * SenderMessageKey — derived per-message key material.
 *
 * Ported verbatim from Baileys `Signal/Group/sender-message-key.js`.
 *
 * Given a `seed` (the chain key's message-key derivative), splits it
 * into (iv, cipherKey) via HKDF with info=`"WhisperGroup"`. The slice
 * boundaries are part of the Signal Group protocol and MUST NOT change.
 */
export class SenderMessageKey {
  readonly iteration: number;
  readonly seed: Buffer;
  readonly iv: Buffer;
  readonly cipherKey: Buffer;

  constructor(iteration: number, seed: Buffer) {
    const derivative = deriveSecrets(seed, Buffer.alloc(32), Buffer.from('WhisperGroup'));
    const keys = new Uint8Array(32);
    keys.set(new Uint8Array(derivative[0].slice(16)));
    keys.set(new Uint8Array(derivative[1].slice(0, 16)), 16);

    this.iv = Buffer.from(derivative[0].slice(0, 16));
    this.cipherKey = Buffer.from(keys.buffer);
    this.iteration = iteration;
    this.seed = seed;
  }

  getIteration(): number {
    return this.iteration;
  }

  getIv(): Buffer {
    return this.iv;
  }

  getCipherKey(): Buffer {
    return this.cipherKey;
  }

  getSeed(): Buffer {
    return this.seed;
  }
}
