import type { SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../types/auth.js';

/**
 * Cacheable Signal key store wrapper.
 * Wraps an underlying SignalKeyStore with an in-memory LRU cache
 * to reduce I/O operations during message encryption/decryption.
 *
 * This is equivalent to Baileys' makeCacheableSignalKeyStore but
 * with proper cache invalidation and memory bounds.
 */
export class CacheableSignalKeyStore implements SignalKeyStore {
  private cache = new Map<string, unknown>();
  private readonly inner: SignalKeyStore;
  private readonly maxCacheSize: number;

  constructor(inner: SignalKeyStore, maxCacheSize = 10000) {
    this.inner = inner;
    this.maxCacheSize = maxCacheSize;
  }

  private cacheKey(type: string, id: string): string {
    return `${type}:${id}`;
  }

  async get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<Record<string, SignalDataTypeMap[T]>> {
    const result: Record<string, SignalDataTypeMap[T]> = {};
    const uncachedIds: string[] = [];

    // Check cache first
    for (const id of ids) {
      const key = this.cacheKey(type, id);
      if (this.cache.has(key)) {
        result[id] = this.cache.get(key) as SignalDataTypeMap[T];
      } else {
        uncachedIds.push(id);
      }
    }

    // Fetch uncached from underlying store
    if (uncachedIds.length > 0) {
      const fetched = await this.inner.get(type, uncachedIds);
      for (const [id, value] of Object.entries(fetched)) {
        result[id] = value;
        this.cacheSet(this.cacheKey(type, id), value);
      }
    }

    return result;
  }

  async set(data: SignalDataSet): Promise<void> {
    // Update cache
    for (const [type, entries] of Object.entries(data)) {
      if (!entries) continue;
      for (const [id, value] of Object.entries(entries)) {
        const key = this.cacheKey(type, id);
        if (value === null) {
          this.cache.delete(key);
        } else {
          this.cacheSet(key, value);
        }
      }
    }

    // Write through to underlying store
    await this.inner.set(data);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    await this.inner.clear?.();
  }

  /** Current cache size */
  get cacheSize(): number {
    return this.cache.size;
  }

  private cacheSet(key: string, value: unknown): void {
    // Simple LRU: evict oldest entries when over capacity
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }
}
