import { proto } from '../../proto/index.js';
import { CiphertextMessage } from './ciphertext-message.js';

/**
 * SenderKeyDistributionMessage — shared to group members so they can
 * decrypt the sender's future `SenderKeyMessage`s.
 *
 * Ported verbatim from Baileys `Signal/Group/sender-key-distribution-message.js`.
 *
 * Wire format:
 *   [1-byte version][protobuf-encoded SenderKeyDistributionMessage]
 *
 * Contains: keyId, iteration, chainKey seed, signing public key.
 */
export class SenderKeyDistributionMessage extends CiphertextMessage {
  readonly serialized: Buffer;
  readonly id: number;
  readonly iteration: number;
  readonly chainKey: Buffer;
  readonly signatureKey: Buffer;

  constructor(
    id: number | null,
    iteration: number | null,
    chainKey: Buffer | Uint8Array | null,
    signatureKey: Buffer | Uint8Array | null,
    serialized?: Buffer,
  ) {
    super();

    if (serialized) {
      try {
        const message = serialized.slice(1);
        const distributionMessage = proto.SenderKeyDistributionMessage.decode(message).toJSON();
        this.serialized = serialized;
        this.id = distributionMessage.id;
        this.iteration = distributionMessage.iteration;
        this.chainKey =
          typeof distributionMessage.chainKey === 'string'
            ? Buffer.from(distributionMessage.chainKey, 'base64')
            : distributionMessage.chainKey;
        this.signatureKey =
          typeof distributionMessage.signingKey === 'string'
            ? Buffer.from(distributionMessage.signingKey, 'base64')
            : distributionMessage.signingKey;
      } catch (e) {
        throw new Error(String(e));
      }
    } else {
      if (id === null || iteration === null || chainKey === null || signatureKey === null) {
        throw new Error(
          'SenderKeyDistributionMessage: id, iteration, chainKey, and signatureKey are required when constructing from fields',
        );
      }
      const version = this.intsToByteHighAndLow(this.CURRENT_VERSION, this.CURRENT_VERSION);
      this.id = id;
      this.iteration = iteration;
      this.chainKey = Buffer.from(chainKey);
      this.signatureKey = Buffer.from(signatureKey);
      const message = proto.SenderKeyDistributionMessage.encode(
        proto.SenderKeyDistributionMessage.create({
          id,
          iteration,
          chainKey: this.chainKey,
          signingKey: this.signatureKey,
        }),
      ).finish() as Buffer;
      this.serialized = Buffer.concat([Buffer.from([version]), message]);
    }
  }

  private intsToByteHighAndLow(highValue: number, lowValue: number): number {
    return (((highValue << 4) | lowValue) & 0xff) % 256;
  }

  serialize(): Buffer {
    return this.serialized;
  }

  getType(): number {
    return this.SENDERKEY_DISTRIBUTION_TYPE;
  }

  getIteration(): number {
    return this.iteration;
  }

  getChainKey(): Buffer {
    return this.chainKey;
  }

  getSignatureKey(): Buffer {
    return this.signatureKey;
  }

  getId(): number {
    return this.id;
  }
}
