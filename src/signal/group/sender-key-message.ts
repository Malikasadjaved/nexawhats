import { calculateSignature, verifySignature } from 'libsignal/src/curve.js';
import { proto } from '../../proto/index.js';
import { CiphertextMessage } from './ciphertext-message.js';

/**
 * SenderKeyMessage — a single encrypted group message.
 *
 * Ported verbatim from Baileys `Signal/Group/sender-key-message.js`.
 *
 * Wire format:
 *   [1-byte version][protobuf-encoded SenderKeyMessage][64-byte Ed25519 signature]
 *
 * The signature covers `[version][message]` — verified on decrypt
 * against the sender's signing public key. Tampering anywhere in the
 * frame invalidates the signature.
 */
export class SenderKeyMessage extends CiphertextMessage {
  readonly SIGNATURE_LENGTH = 64;

  readonly serialized: Buffer;
  readonly messageVersion: number;
  readonly keyId: number;
  readonly iteration: number;
  readonly ciphertext: Buffer;
  readonly signature: Buffer;

  constructor(
    keyId: number | null,
    iteration: number | null,
    ciphertext: Buffer | Uint8Array | null,
    signatureKey: Buffer | Uint8Array | null,
    serialized?: Buffer,
  ) {
    super();

    if (serialized) {
      const version = serialized[0];
      const message = serialized.slice(1, serialized.length - this.SIGNATURE_LENGTH);
      const signature = serialized.slice(-this.SIGNATURE_LENGTH);
      const senderKeyMessage = proto.SenderKeyMessage.decode(message).toJSON();

      this.serialized = serialized;
      this.messageVersion = (version & 0xff) >> 4;
      this.keyId = senderKeyMessage.id;
      this.iteration = senderKeyMessage.iteration;
      this.ciphertext =
        typeof senderKeyMessage.ciphertext === 'string'
          ? Buffer.from(senderKeyMessage.ciphertext, 'base64')
          : senderKeyMessage.ciphertext;
      this.signature = signature;
    } else {
      if (keyId === null || iteration === null || ciphertext === null || signatureKey === null) {
        throw new Error(
          'SenderKeyMessage: keyId, iteration, ciphertext, and signatureKey are required when constructing from fields',
        );
      }
      const version = (((this.CURRENT_VERSION << 4) | this.CURRENT_VERSION) & 0xff) % 256;
      const ciphertextBuffer = Buffer.from(ciphertext);
      const message = proto.SenderKeyMessage.encode(
        proto.SenderKeyMessage.create({
          id: keyId,
          iteration,
          ciphertext: ciphertextBuffer,
        }),
      ).finish() as Buffer;

      const signaturePayload = Buffer.concat([Buffer.from([version]), message]);
      const signature = this.getSignature(Buffer.from(signatureKey), signaturePayload);

      this.serialized = Buffer.concat([Buffer.from([version]), message, Buffer.from(signature)]);
      this.messageVersion = this.CURRENT_VERSION;
      this.keyId = keyId;
      this.iteration = iteration;
      this.ciphertext = ciphertextBuffer;
      this.signature = signature;
    }
  }

  getKeyId(): number {
    return this.keyId;
  }

  getIteration(): number {
    return this.iteration;
  }

  getCipherText(): Buffer {
    return this.ciphertext;
  }

  verifySignature(signatureKey: Buffer): void {
    const part1 = this.serialized.slice(0, this.serialized.length - this.SIGNATURE_LENGTH);
    const part2 = this.serialized.slice(-this.SIGNATURE_LENGTH);
    const res = verifySignature(signatureKey, part1, part2);
    if (!res) throw new Error('Invalid signature!');
  }

  getSignature(signatureKey: Buffer, serialized: Buffer): Buffer {
    return Buffer.from(calculateSignature(signatureKey, serialized));
  }

  serialize(): Buffer {
    return this.serialized;
  }

  getType(): number {
    return 4;
  }
}
