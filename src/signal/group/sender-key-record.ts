import { BufferJSON } from './buffer-json.js';
import { SenderKeyState, type SenderKeyStateStructure } from './sender-key-state.js';

/**
 * SenderKeyRecord — bounded list of sender-key states (versions).
 *
 * Ported verbatim from Baileys `Signal/Group/sender-key-record.js`.
 *
 * Holds up to `MAX_STATES` (5) past states so out-of-order messages
 * under an older key can still be decrypted. The oldest state is
 * dropped once the cap is reached.
 *
 * `deserialize()` accepts the raw JSON blob persisted by Baileys —
 * `JSON.parse(utf8, BufferJSON.reviver)` → array of
 * `SenderKeyStateStructure`. This is the on-wire shape stored in
 * the auth store's `sender-key` slot.
 */
export class SenderKeyRecord {
  private readonly MAX_STATES = 5;
  private readonly senderKeyStates: SenderKeyState[] = [];

  constructor(serialized?: SenderKeyStateStructure[] | null) {
    if (serialized) {
      for (const structure of serialized) {
        this.senderKeyStates.push(
          new SenderKeyState(null, null, null, null, null, null, structure),
        );
      }
    }
  }

  isEmpty(): boolean {
    return this.senderKeyStates.length === 0;
  }

  getSenderKeyState(keyId?: number): SenderKeyState | undefined {
    if (keyId === undefined && this.senderKeyStates.length) {
      return this.senderKeyStates[this.senderKeyStates.length - 1];
    }
    return this.senderKeyStates.find((state) => state.getKeyId() === keyId);
  }

  addSenderKeyState(
    id: number,
    iteration: number,
    chainKey: Buffer | Uint8Array | number[],
    signatureKey: Buffer | Uint8Array | number[],
  ): void {
    this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, null, signatureKey));
    if (this.senderKeyStates.length > this.MAX_STATES) {
      this.senderKeyStates.shift();
    }
  }

  setSenderKeyState(
    id: number,
    iteration: number,
    chainKey: Buffer | Uint8Array | number[],
    keyPair: { public: Buffer | Uint8Array; private: Buffer | Uint8Array },
  ): void {
    this.senderKeyStates.length = 0;
    this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, keyPair));
  }

  serialize(): SenderKeyStateStructure[] {
    return this.senderKeyStates.map((state) => state.getStructure());
  }

  static deserialize(data: Buffer | Uint8Array): SenderKeyRecord {
    const str = Buffer.from(data).toString('utf-8');
    const parsed = JSON.parse(str, BufferJSON.reviver) as SenderKeyStateStructure[];
    return new SenderKeyRecord(parsed);
  }
}
