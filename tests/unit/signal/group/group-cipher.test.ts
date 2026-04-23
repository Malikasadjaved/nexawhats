import { describe, expect, it } from 'vitest';
import { isProtoAvailable } from '../../../../src/proto/index.js';
import {
  GroupCipher,
  GroupSessionBuilder,
  SenderKeyDistributionMessage,
  SenderKeyName,
  SenderKeyRecord,
  type SenderKeyStore,
} from '../../../../src/signal/group/index.js';

const haveProto = isProtoAvailable();
const describeIf = haveProto ? describe : describe.skip;

/**
 * In-memory sender-key store for tests. Mirrors the Baileys
 * `senderKeyStore` shape: `loadSenderKey` returns an existing
 * `SenderKeyRecord` or a fresh one; `storeSenderKey` persists it.
 */
function makeStore(): SenderKeyStore {
  const map = new Map<string, SenderKeyRecord>();
  return {
    async loadSenderKey(name) {
      return map.get(name.serialize()) ?? new SenderKeyRecord();
    },
    async storeSenderKey(name, record) {
      map.set(name.serialize(), record);
    },
  };
}

const addr = {
  id: '923315244441',
  deviceId: 0,
  toString: () => '923315244441.0',
};

/**
 * Signal Group protocol end-to-end flow:
 *   1. Sender calls `builder.create(name)` → installs full keypair
 *      in senderStore and returns an SKDM to broadcast.
 *   2. Receiver parses the wire SKDM and calls `builder.process()`
 *      → installs sender's chainKey + PUBLIC signing key in
 *      receiverStore (no private key; receivers can only decrypt).
 *   3. Sender encrypts with its senderStore (has privkey).
 *   4. Receiver decrypts with its receiverStore (verifies sig with
 *      pubkey, advances a mirrored chain).
 *
 * The sender itself cannot decrypt its own sent messages because
 * the encrypt path advances the chain without caching the consumed
 * message key. That's intentional — the Signal Group sender is a
 * forward-only ratchet.
 */
describeIf('GroupCipher + GroupSessionBuilder — full sender→receiver round-trip', () => {
  async function setupPair(groupId: string) {
    const senderStore = makeStore();
    const receiverStore = makeStore();
    const name = new SenderKeyName(groupId, addr);

    const senderBuilder = new GroupSessionBuilder(senderStore);
    const skdm = await senderBuilder.create(name);

    const receiverBuilder = new GroupSessionBuilder(receiverStore);
    // Simulate wire transmission: serialize, transmit, re-parse.
    const parsed = new SenderKeyDistributionMessage(
      null,
      null,
      null,
      null,
      Buffer.from(skdm.serialize()),
    );
    await receiverBuilder.process(name, parsed);

    return {
      senderCipher: new GroupCipher(senderStore, name),
      receiverCipher: new GroupCipher(receiverStore, name),
    };
  }

  it('sender encrypt → receiver decrypt recovers the plaintext', async () => {
    const { senderCipher, receiverCipher } = await setupPair('group-rt-1@g.us');
    const plaintext = Buffer.from('hello group whisper — padded test payload 🔒');
    const ciphertext = await senderCipher.encrypt(plaintext);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length);
    const recovered = await receiverCipher.decrypt(ciphertext);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('sender chain advances — two encrypts of the same payload produce distinct ciphertexts', async () => {
    const { senderCipher } = await setupPair('group-rt-2@g.us');
    const data = Buffer.from('same payload');
    const c1 = await senderCipher.encrypt(data);
    const c2 = await senderCipher.encrypt(data);
    expect(c1.equals(c2)).toBe(false);
  });

  it('receiver replay of the same ciphertext fails (iteration consumed)', async () => {
    const { senderCipher, receiverCipher } = await setupPair('group-rt-3@g.us');
    const ct = await senderCipher.encrypt(Buffer.from('once'));
    const pt = await receiverCipher.decrypt(ct);
    expect(pt.toString()).toBe('once');
    await expect(receiverCipher.decrypt(ct)).rejects.toThrow(/old counter|sender message key/i);
  });

  it('out-of-order decrypt works via the cached message-key ring buffer', async () => {
    // Sender encrypts 3 messages; receiver decrypts them in order
    // [3, 1, 2]. The Signal Group ratchet caches skipped message
    // keys so (1) and (2) are still decryptable after (3) bumps
    // the chain ahead.
    const { senderCipher, receiverCipher } = await setupPair('group-rt-4@g.us');
    const m1 = await senderCipher.encrypt(Buffer.from('one'));
    const m2 = await senderCipher.encrypt(Buffer.from('two'));
    const m3 = await senderCipher.encrypt(Buffer.from('three'));

    expect((await receiverCipher.decrypt(m3)).toString()).toBe('three');
    expect((await receiverCipher.decrypt(m1)).toString()).toBe('one');
    expect((await receiverCipher.decrypt(m2)).toString()).toBe('two');
  });

  it('SKDM wire format survives serialize → parse → process', async () => {
    const { senderCipher, receiverCipher } = await setupPair('group-rt-5@g.us');
    // setupPair already round-trips the SKDM through bytes; prove
    // the pair can then exchange a message successfully.
    const ct = await senderCipher.encrypt(Buffer.from('cross-store hello'));
    const pt = await receiverCipher.decrypt(ct);
    expect(pt.toString()).toBe('cross-store hello');
  });
});
