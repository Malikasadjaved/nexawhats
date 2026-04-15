import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from '../types/auth.js';
import type { AuthStore } from './interface.js';

/**
 * In-memory auth store — no persistence.
 * Perfect for testing and ephemeral bots.
 */
export class MemoryAuthStore implements AuthStore {
  private creds: AuthenticationCreds | null = null;
  private keys = new Map<string, Map<string, unknown>>();

  async loadState(): Promise<AuthenticationState | null> {
    if (!this.creds) return null;

    const keyStore: SignalKeyStore = {
      get: async (type, ids) => this.getKeys(type, ids),
      set: async (data) => this.setKeys(data),
      clear: async () => this.clear(),
    };

    return { creds: this.creds, keys: keyStore };
  }

  async saveState(state: AuthenticationState): Promise<void> {
    this.creds = { ...state.creds };
  }

  async saveCreds(creds: AuthenticationCreds): Promise<void> {
    this.creds = { ...creds };
  }

  async getKeys<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<Record<string, SignalDataTypeMap[T]>> {
    const bucket = this.keys.get(type);
    const result: Record<string, SignalDataTypeMap[T]> = {};
    if (!bucket) return result;

    for (const id of ids) {
      const value = bucket.get(id);
      if (value !== undefined) {
        result[id] = value as SignalDataTypeMap[T];
      }
    }
    return result;
  }

  async setKeys(data: SignalDataSet): Promise<void> {
    for (const [type, entries] of Object.entries(data)) {
      if (!entries) continue;
      let bucket = this.keys.get(type);
      if (!bucket) {
        bucket = new Map();
        this.keys.set(type, bucket);
      }
      for (const [id, value] of Object.entries(entries)) {
        if (value === null) {
          bucket.delete(id);
        } else {
          bucket.set(id, value);
        }
      }
    }
  }

  async clear(): Promise<void> {
    this.creds = null;
    this.keys.clear();
  }

  /** Get the number of stored keys (for testing) */
  get keyCount(): number {
    let count = 0;
    for (const bucket of this.keys.values()) {
      count += bucket.size;
    }
    return count;
  }
}
