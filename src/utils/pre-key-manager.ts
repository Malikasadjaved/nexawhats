import PQueue from 'p-queue';
/**
 * Pre-Key Manager — validates pre-key deletions, serialises operations
 * per key type, and generates one-time pre-key batches.
 *
 * Ported from Baileys' `Utils/pre-key-manager.js`.
 */
import type { Logger } from 'pino';
import type { BinaryNode } from '../binary/index.js';
import { S_WHATSAPP_NET } from '../binary/jid.js';
import type {
  AuthenticationCreds,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from '../types/auth.js';
import { KEY_BUNDLE_TYPE } from './crypto.js';
import { encodeBigEndian } from '../proto/payload.js';
import { Curve, type RawKeyPair } from './crypto.js';

export class PreKeyManager {
  private store: SignalKeyStore;
  private queues = new Map<string, PQueue>();

  constructor(store: SignalKeyStore) {
    this.store = store;
  }

  private getQueue(keyType: string): PQueue {
    let q = this.queues.get(keyType);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.queues.set(keyType, q);
    }
    return q;
  }

  /**
   * Process a batch of pre-key operations — splits into updates (merged
   * immediately into the cache and mutations) and deletions (validated
   * before being committed).
   */
  async processOperations(
    data: SignalDataSet,
    keyType: keyof SignalDataTypeMap,
    transactionCache: SignalDataSet,
    mutations: SignalDataSet,
    isInTransaction: boolean,
  ): Promise<void> {
    const entries = data[keyType];
    if (!entries) return;

    const queue = this.getQueue(keyType);
    await queue.add(async () => {
      const updates: Record<string, unknown> = {};
      const deletions: string[] = [];

      for (const [id, value] of Object.entries(entries)) {
        if (value === null) {
          deletions.push(id);
        } else {
          updates[id] = value;
        }
      }

      if (Object.keys(updates).length > 0) {
        // The SignalDataSet mapped type is strict — narrow through
        // unknown so we can merge partial key-type batches.
        const cacheTarget = (transactionCache[keyType] ?? {}) as Record<string, unknown>;
        (transactionCache as Record<string, unknown>)[keyType] = cacheTarget;
        Object.assign(cacheTarget, updates);
        const mutTarget = (mutations[keyType] ?? {}) as Record<string, unknown>;
        (mutations as Record<string, unknown>)[keyType] = mutTarget;
        Object.assign(mutTarget, updates);
      }

      if (deletions.length > 0) {
        await this.processDeletions(
          keyType,
          deletions,
          transactionCache,
          mutations,
          isInTransaction,
        );
      }
    });
  }

  private async processDeletions(
    keyType: keyof SignalDataTypeMap,
    ids: string[],
    transactionCache: SignalDataSet,
    mutations: SignalDataSet,
    isInTransaction: boolean,
  ): Promise<void> {
    const validIds: string[] = [];

    if (isInTransaction) {
      const cache = transactionCache[keyType] as Record<string, unknown> | undefined;
      for (const id of ids) {
        if (cache?.[id] !== undefined) validIds.push(id);
      }
    } else {
      const existing = await this.store.get(keyType, ids);
      for (const id of ids) {
        if (existing[id] !== undefined) validIds.push(id);
      }
    }

    if (validIds.length > 0) {
      const deletionMap: Record<string, null> = {};
      for (const id of validIds) deletionMap[id] = null;
      const mutTarget = (mutations[keyType] ?? {}) as Record<string, null>;
      (mutations as Record<string, unknown>)[keyType] = mutTarget;
      Object.assign(mutTarget, deletionMap);
    }
  }

  /**
   * Validate pending pre-key deletions against the store.
   * Removes deletion markers for keys that don't exist.
   */
  async validateDeletions(data: SignalDataSet, keyType: keyof SignalDataTypeMap): Promise<void> {
    const entries = data[keyType];
    if (!entries) return;

    const deletionIds: string[] = [];
    for (const [id, value] of Object.entries(entries)) {
      if (value === null) deletionIds.push(id);
    }
    if (deletionIds.length === 0) return;

    const queue = this.getQueue(keyType);
    await queue.add(async () => {
      const existing = await this.store.get(keyType, deletionIds);
      for (const id of deletionIds) {
        if (existing[id] === undefined) delete entries[id];
      }
    });
  }
}

/**
 * Generate a batch of one-time Curve25519 pre-keys for upload to the
 * WhatsApp server. Returns them indexed by their numeric key ID.
 */
export function generatePreKeys(
  startId: number,
  count: number,
): { preKeys: Record<number, RawKeyPair>; lastId: number } {
  const preKeys: Record<number, RawKeyPair> = {};
  let id = startId;
  for (let i = 0; i < count; i++) {
    preKeys[id] = Curve.generateKeyPair();
    id++;
  }
  return { preKeys, lastId: id - 1 };
}

const INITIAL_PREKEY_COUNT = 30;
const MIN_PREKEY_COUNT = 5;

/**
 * Upload pre-keys to the WhatsApp server if the server count is low.
 * Called after a successful login to ensure the server has enough pre-keys
 * to allow other users to initiate sessions with us.
 *
 * CRITICAL: Pre-keys must be stored locally *before* uploading to the
 * server. Otherwise, when another user sends a pkmsg encrypted with one
 * of those pre-keys, libsignal's loadPreKey won't find the private key
 * and decryption will fail with MessageCounterError.
 */
export async function uploadPreKeysToServer(
  sendNode: (node: BinaryNode) => Promise<void>,
  pendingQueries: Map<
    string,
    {
      resolve: (node: BinaryNode) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >,
  creds: AuthenticationCreds,
  keys: SignalKeyStore,
  logger: Logger,
): Promise<void> {
  // Query how many pre-keys the server has
  const countId = `pkcount-${Date.now()}`;
  let serverCount = 0;
  try {
    const countResult = await queryIQ(sendNode, pendingQueries, {
      tag: 'iq',
      attrs: { id: countId, to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' },
      content: [{ tag: 'count', attrs: {} }],
    });
    const countNode = findChildNode(countResult, 'count');
    serverCount = Number(countNode?.attrs?.value ?? 0);
  } catch {
    logger.warn('failed to query server pre-key count, assuming 0');
  }

  // Verify the current pre-key exists locally — if missing, we must
  // re-upload even if the server count looks healthy, otherwise we
  // won't be able to decrypt any incoming pkmsg messages.
  const currentPreKeyId = creds.nextPreKeyId - 1;
  let currentPreKeyExists = false;
  if (currentPreKeyId > 0) {
    const existing = await keys.get('pre-key', [currentPreKeyId.toString()]);
    currentPreKeyExists = !!existing[currentPreKeyId.toString()];
  }

  const needUpload = serverCount <= MIN_PREKEY_COUNT || !currentPreKeyExists;
  if (!needUpload) {
    logger.info({ serverCount }, 'pre-keys sufficient, skipping upload');
    return;
  }

  if (!currentPreKeyExists && serverCount > MIN_PREKEY_COUNT) {
    logger.warn(
      { serverCount, currentPreKeyId },
      'current pre-key missing locally — forcing re-upload',
    );
  }

  const count = serverCount === 0 ? INITIAL_PREKEY_COUNT : MIN_PREKEY_COUNT;
  logger.info({ serverCount, count }, 'uploading pre-keys to server');

  const nextId = creds.nextPreKeyId ?? 1;
  const { preKeys: newKeys, lastId } = generatePreKeys(nextId, count);

  // Store pre-keys locally BEFORE uploading — must be atomic so
  // we never upload a key we can't decrypt with.
  const preKeyEntries: Record<string, { private: Uint8Array; public: Uint8Array }> = {};
  for (const [id, kp] of Object.entries(newKeys)) {
    preKeyEntries[id] = { private: kp.private, public: kp.public };
  }
  await keys.set({ 'pre-key': preKeyEntries });
  logger.debug(
    { from: nextId, to: lastId },
    'stored pre-keys locally',
  );

  // Build XMPP key bundle (matches Baileys' getNextPreKeysNode format).
  // Each pre-key is sent as a <key> element with big-endian encoded IDs.
  const preKeyNodes = Object.entries(newKeys).map(([id, kp]) => ({
    tag: 'key',
    attrs: {},
    content: [
      { tag: 'id', attrs: {}, content: encodeBigEndian(Number(id), 3) },
      { tag: 'value', attrs: {}, content: Buffer.from(kp.public) },
    ],
  }));

  const bundleId = `pkbundle-${Date.now()}`;
  await queryIQ(sendNode, pendingQueries, {
    tag: 'iq',
    attrs: { id: bundleId, to: S_WHATSAPP_NET, type: 'set', xmlns: 'encrypt' },
    content: [
      {
        tag: 'registration',
        attrs: {},
        content: encodeBigEndian(creds.registrationId),
      },
      { tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
      {
        tag: 'identity',
        attrs: {},
        content: Buffer.from(creds.signedIdentityKey.public),
      },
      { tag: 'list', attrs: {}, content: preKeyNodes },
      {
        tag: 'skey',
        attrs: {},
        content: [
          {
            tag: 'id',
            attrs: {},
            content: encodeBigEndian(creds.signedPreKey.keyId, 3),
          },
          {
            tag: 'value',
            attrs: {},
            content: Buffer.from(creds.signedPreKey.keyPair.public),
          },
          {
            tag: 'signature',
            attrs: {},
            content: Buffer.from(creds.signedPreKey.signature),
          },
        ],
      },
    ],
  });

  // Update the next pre-key ID
  creds.nextPreKeyId = lastId + 1;
  creds.firstUnuploadedPreKeyId = lastId + 1;
  logger.info({ lastId, nextId: creds.nextPreKeyId }, 'pre-keys uploaded successfully');
}

function queryIQ(
  sendNode: (node: BinaryNode) => Promise<void>,
  pendingQueries: Map<
    string,
    {
      resolve: (node: BinaryNode) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >,
  node: BinaryNode,
): Promise<BinaryNode> {
  const id = node.attrs.id as string;
  return new Promise<BinaryNode>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingQueries.delete(id);
      reject(new Error(`IQ query timeout: ${id}`));
    }, 30_000);
    pendingQueries.set(id, { resolve, reject, timer });
    sendNode(node).catch((err) => {
      clearTimeout(timer);
      pendingQueries.delete(id);
      reject(err);
    });
  });
}

function findChildNode(parent: BinaryNode, tag: string): BinaryNode | undefined {
  if (!Array.isArray(parent.content)) return undefined;
  return (parent.content as BinaryNode[]).find(
    (c) => typeof c !== 'string' && !Buffer.isBuffer(c) && c.tag === tag,
  );
}
