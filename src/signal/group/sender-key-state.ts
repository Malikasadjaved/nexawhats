import { SenderChainKey } from './sender-chain-key.js';
import { SenderMessageKey } from './sender-message-key.js';

/**
 * Serialized form of a `SenderKeyState` — matches Baileys' wire shape
 * verbatim so captured fixtures round-trip.
 */
export interface SenderKeyStateStructure {
  senderKeyId: number;
  senderChainKey: {
    iteration: number;
    seed: Buffer;
  };
  senderSigningKey: {
    public: Buffer;
    private: Buffer;
  };
  senderMessageKeys: Array<{ iteration: number; seed: Buffer }>;
}

export interface KeyPairLike {
  public: Buffer | Uint8Array;
  private: Buffer | Uint8Array;
}

/**
 * SenderKeyState — a single version of the group sender's ratchet
 * (chain key + signing key + cached message keys).
 *
 * Ported verbatim from Baileys `Signal/Group/sender-key-state.js`.
 *
 * MAX_MESSAGE_KEYS (2000) is the cache bound — older keys are
 * dropped. Baileys' value; do not change without confirming
 * cross-version compatibility.
 */
export class SenderKeyState {
  private readonly MAX_MESSAGE_KEYS = 2000;
  private senderKeyStateStructure!: SenderKeyStateStructure;

  constructor(
    id?: number | null,
    iteration?: number | null,
    chainKey?: Buffer | Uint8Array | number[] | null,
    signatureKeyPair?: KeyPairLike | null,
    signatureKeyPublic?: Buffer | Uint8Array | number[] | null,
    signatureKeyPrivate?: Buffer | Uint8Array | number[] | null,
    senderKeyStateStructure?: SenderKeyStateStructure | null,
  ) {
    if (senderKeyStateStructure) {
      this.senderKeyStateStructure = {
        ...senderKeyStateStructure,
        senderMessageKeys: Array.isArray(senderKeyStateStructure.senderMessageKeys)
          ? senderKeyStateStructure.senderMessageKeys
          : [],
      };
    } else {
      let pub = signatureKeyPublic;
      let priv = signatureKeyPrivate;
      if (signatureKeyPair) {
        pub = signatureKeyPair.public;
        priv = signatureKeyPair.private;
      }
      this.senderKeyStateStructure = {
        senderKeyId: id ?? 0,
        senderChainKey: {
          iteration: iteration ?? 0,
          seed: Buffer.from(chainKey ?? []),
        },
        senderSigningKey: {
          public: Buffer.from(pub ?? []),
          private: Buffer.from(priv ?? []),
        },
        senderMessageKeys: [],
      };
    }
  }

  getKeyId(): number {
    return this.senderKeyStateStructure.senderKeyId;
  }

  getSenderChainKey(): SenderChainKey {
    return new SenderChainKey(
      this.senderKeyStateStructure.senderChainKey.iteration,
      this.senderKeyStateStructure.senderChainKey.seed,
    );
  }

  setSenderChainKey(chainKey: SenderChainKey): void {
    this.senderKeyStateStructure.senderChainKey = {
      iteration: chainKey.getIteration(),
      seed: chainKey.getSeed(),
    };
  }

  getSigningKeyPublic(): Buffer {
    const publicKey = Buffer.from(this.senderKeyStateStructure.senderSigningKey.public);
    if (publicKey.length === 32) {
      const fixed = Buffer.alloc(33);
      fixed[0] = 0x05;
      publicKey.copy(fixed, 1);
      return fixed;
    }
    return publicKey;
  }

  getSigningKeyPrivate(): Buffer {
    const privateKey = this.senderKeyStateStructure.senderSigningKey.private;
    return Buffer.from(privateKey ?? []);
  }

  hasSenderMessageKey(iteration: number): boolean {
    return this.senderKeyStateStructure.senderMessageKeys.some(
      (key) => key.iteration === iteration,
    );
  }

  addSenderMessageKey(senderMessageKey: SenderMessageKey): void {
    this.senderKeyStateStructure.senderMessageKeys.push({
      iteration: senderMessageKey.getIteration(),
      seed: senderMessageKey.getSeed(),
    });
    if (this.senderKeyStateStructure.senderMessageKeys.length > this.MAX_MESSAGE_KEYS) {
      this.senderKeyStateStructure.senderMessageKeys.shift();
    }
  }

  removeSenderMessageKey(iteration: number): SenderMessageKey | null {
    const index = this.senderKeyStateStructure.senderMessageKeys.findIndex(
      (key) => key.iteration === iteration,
    );
    if (index !== -1) {
      const messageKey = this.senderKeyStateStructure.senderMessageKeys[index];
      this.senderKeyStateStructure.senderMessageKeys.splice(index, 1);
      return new SenderMessageKey(messageKey.iteration, messageKey.seed);
    }
    return null;
  }

  getStructure(): SenderKeyStateStructure {
    return this.senderKeyStateStructure;
  }
}
