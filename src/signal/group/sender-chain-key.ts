import { calculateMAC } from 'libsignal/src/crypto.js';
import { SenderMessageKey } from './sender-message-key.js';

/**
 * SenderChainKey — ratchet state for a group sender.
 *
 * Ported verbatim from Baileys `Signal/Group/sender-chain-key.js`.
 *
 * Each iteration derives two HMAC outputs:
 *   - MESSAGE_KEY_SEED (0x01) → seed for the `SenderMessageKey`
 *   - CHAIN_KEY_SEED   (0x02) → next chain key for the ratchet
 *
 * The 1-byte seed constants are part of the Signal Group protocol
 * and MUST NOT change.
 */
export class SenderChainKey {
  private readonly MESSAGE_KEY_SEED = Buffer.from([0x01]);
  private readonly CHAIN_KEY_SEED = Buffer.from([0x02]);

  readonly iteration: number;
  readonly chainKey: Buffer;

  constructor(iteration: number, chainKey: Buffer | Uint8Array | number[]) {
    this.iteration = iteration;
    this.chainKey = Buffer.from(chainKey);
  }

  getIteration(): number {
    return this.iteration;
  }

  getSenderMessageKey(): SenderMessageKey {
    return new SenderMessageKey(
      this.iteration,
      this.getDerivative(this.MESSAGE_KEY_SEED, this.chainKey),
    );
  }

  getNext(): SenderChainKey {
    return new SenderChainKey(
      this.iteration + 1,
      this.getDerivative(this.CHAIN_KEY_SEED, this.chainKey),
    );
  }

  getSeed(): Buffer {
    return this.chainKey;
  }

  private getDerivative(seed: Buffer, key: Buffer): Buffer {
    return calculateMAC(key, seed);
  }
}
