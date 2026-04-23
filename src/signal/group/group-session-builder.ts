import type { SenderKeyStore } from './group-cipher.js';
import { generateSenderKey, generateSenderKeyId, generateSenderSigningKey } from './keyhelper.js';
import { SenderKeyDistributionMessage } from './sender-key-distribution-message.js';
import type { SenderKeyName } from './sender-key-name.js';

/**
 * GroupSessionBuilder — manage sender-key state for a group.
 *
 * Ported verbatim from Baileys `Signal/Group/group-session-builder.js`.
 *
 *   - `process()` ingests an incoming `SenderKeyDistributionMessage`
 *     and adds it to the peer's record (so we can decrypt their
 *     future group messages).
 *   - `create()` generates OUR sender-key state if absent, and
 *     returns a `SenderKeyDistributionMessage` to share with the
 *     group.
 */
export class GroupSessionBuilder {
  readonly senderKeyStore: SenderKeyStore;

  constructor(senderKeyStore: SenderKeyStore) {
    this.senderKeyStore = senderKeyStore;
  }

  async process(
    senderKeyName: SenderKeyName,
    senderKeyDistributionMessage: SenderKeyDistributionMessage,
  ): Promise<void> {
    const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName);
    senderKeyRecord.addSenderKeyState(
      senderKeyDistributionMessage.getId(),
      senderKeyDistributionMessage.getIteration(),
      senderKeyDistributionMessage.getChainKey(),
      senderKeyDistributionMessage.getSignatureKey(),
    );
    await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord);
  }

  async create(senderKeyName: SenderKeyName): Promise<SenderKeyDistributionMessage> {
    const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName);
    if (senderKeyRecord.isEmpty()) {
      const keyId = generateSenderKeyId();
      const senderKey = generateSenderKey();
      const signingKey = generateSenderSigningKey();
      senderKeyRecord.setSenderKeyState(keyId, 0, senderKey, signingKey);
      await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord);
    }
    const state = senderKeyRecord.getSenderKeyState();
    if (!state) {
      throw new Error('No session state available');
    }
    return new SenderKeyDistributionMessage(
      state.getKeyId(),
      state.getSenderChainKey().getIteration(),
      state.getSenderChainKey().getSeed(),
      state.getSigningKeyPublic(),
    );
  }
}
