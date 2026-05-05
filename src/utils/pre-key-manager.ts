/**
 * Pre-Key Manager — validates pre-key deletions, serialises operations
 * per key type, and generates one-time pre-key batches.
 *
 * Ported from Baileys' `Utils/pre-key-manager.js`.
 */
import PQueue from 'p-queue';
import type { SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../types/auth.js';
import { Curve } from './crypto.js';
import type { RawKeyPair } from './crypto.js';

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
  async validateDeletions(
    data: SignalDataSet,
    keyType: keyof SignalDataTypeMap,
  ): Promise<void> {
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
