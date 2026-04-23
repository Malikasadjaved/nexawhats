import { decrypt, encrypt } from 'libsignal/src/crypto.js';
import { SenderKeyMessage } from './sender-key-message.js';
import type { SenderKeyName } from './sender-key-name.js';
import type { SenderKeyRecord } from './sender-key-record.js';
import type { SenderKeyState } from './sender-key-state.js';
import type { SenderMessageKey } from './sender-message-key.js';

/**
 * Store interface consumed by the group cipher. Matches Baileys'
 * `senderKeyStore` shape — `loadSenderKey` returns an
 * existing record or a fresh empty one.
 */
export interface SenderKeyStore {
  loadSenderKey(senderKeyName: SenderKeyName): Promise<SenderKeyRecord>;
  storeSenderKey(senderKeyName: SenderKeyName, record: SenderKeyRecord): Promise<void>;
}

/**
 * GroupCipher — encrypt/decrypt a single group message under a
 * known `SenderKeyRecord`.
 *
 * Ported verbatim from Baileys `Signal/Group/group_cipher.js`.
 *
 * Ratchet behaviour:
 *   - On encrypt: advance chain by 1 and derive message key from
 *     `iteration + 1` (unless iteration is 0, meaning fresh state).
 *   - On decrypt: fast-forward the chain up to the message's
 *     iteration, caching skipped message keys in the state's
 *     `senderMessageKeys` ring buffer (max 2000).
 *   - Old messages: if `iteration` is already in the cache, consume
 *     the cached key; otherwise reject with "old counter".
 *   - Messages more than 2000 iterations in the future are rejected.
 */
export class GroupCipher {
  readonly senderKeyStore: SenderKeyStore;
  readonly senderKeyName: SenderKeyName;

  constructor(senderKeyStore: SenderKeyStore, senderKeyName: SenderKeyName) {
    this.senderKeyStore = senderKeyStore;
    this.senderKeyName = senderKeyName;
  }

  async encrypt(paddedPlaintext: Buffer | Uint8Array): Promise<Buffer> {
    const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName);
    if (!record) {
      throw new Error('No SenderKeyRecord found for encryption');
    }
    const senderKeyState = record.getSenderKeyState();
    if (!senderKeyState) {
      throw new Error('No session to encrypt message');
    }
    const iteration = senderKeyState.getSenderChainKey().getIteration();
    const senderKey = this.getSenderKey(senderKeyState, iteration === 0 ? 0 : iteration + 1);

    const ciphertext = await this.getCipherText(
      senderKey.getIv(),
      senderKey.getCipherKey(),
      Buffer.from(paddedPlaintext),
    );

    const senderKeyMessage = new SenderKeyMessage(
      senderKeyState.getKeyId(),
      senderKey.getIteration(),
      ciphertext,
      senderKeyState.getSigningKeyPrivate(),
    );

    await this.senderKeyStore.storeSenderKey(this.senderKeyName, record);
    return senderKeyMessage.serialize();
  }

  async decrypt(senderKeyMessageBytes: Buffer): Promise<Buffer> {
    const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName);
    if (!record) {
      throw new Error('No SenderKeyRecord found for decryption');
    }
    const senderKeyMessage = new SenderKeyMessage(null, null, null, null, senderKeyMessageBytes);
    const senderKeyState = record.getSenderKeyState(senderKeyMessage.getKeyId());
    if (!senderKeyState) {
      throw new Error('No session found to decrypt message');
    }
    senderKeyMessage.verifySignature(senderKeyState.getSigningKeyPublic());

    const senderKey = this.getSenderKey(senderKeyState, senderKeyMessage.getIteration());
    const plaintext = await this.getPlainText(
      senderKey.getIv(),
      senderKey.getCipherKey(),
      senderKeyMessage.getCipherText(),
    );

    await this.senderKeyStore.storeSenderKey(this.senderKeyName, record);
    return plaintext;
  }

  private getSenderKey(senderKeyState: SenderKeyState, iteration: number): SenderMessageKey {
    let senderChainKey = senderKeyState.getSenderChainKey();
    if (senderChainKey.getIteration() > iteration) {
      if (senderKeyState.hasSenderMessageKey(iteration)) {
        const messageKey = senderKeyState.removeSenderMessageKey(iteration);
        if (!messageKey) {
          throw new Error('No sender message key found for iteration');
        }
        return messageKey;
      }
      throw new Error(
        `Received message with old counter: ${senderChainKey.getIteration()}, ${iteration}`,
      );
    }
    if (iteration - senderChainKey.getIteration() > 2000) {
      throw new Error('Over 2000 messages into the future!');
    }
    while (senderChainKey.getIteration() < iteration) {
      senderKeyState.addSenderMessageKey(senderChainKey.getSenderMessageKey());
      senderChainKey = senderChainKey.getNext();
    }
    senderKeyState.setSenderChainKey(senderChainKey.getNext());
    return senderChainKey.getSenderMessageKey();
  }

  private async getPlainText(iv: Buffer, key: Buffer, ciphertext: Buffer): Promise<Buffer> {
    try {
      return decrypt(key, ciphertext, iv);
    } catch {
      throw new Error('InvalidMessageException');
    }
  }

  private async getCipherText(iv: Buffer, key: Buffer, plaintext: Buffer): Promise<Buffer> {
    try {
      return encrypt(key, plaintext, iv);
    } catch {
      throw new Error('InvalidMessageException');
    }
  }
}
