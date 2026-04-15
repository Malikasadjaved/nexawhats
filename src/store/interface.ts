import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from '../types/auth.js';

/**
 * Pluggable auth store interface.
 *
 * Implementations handle credential persistence. NexaWhats ships three:
 * - `SQLiteAuthStore` — production default (atomic writes, WAL mode)
 * - `MemoryAuthStore` — for testing (no persistence)
 * - `FileAuthStore` — Baileys-compatible (JSON files with atomic writes)
 */
export interface AuthStore {
  /** Load saved authentication state, or null if none exists */
  loadState(): Promise<AuthenticationState | null>;

  /** Save complete authentication state */
  saveState(state: AuthenticationState): Promise<void>;

  /** Save credentials only (called on every creds.update event) */
  saveCreds(creds: AuthenticationCreds): Promise<void>;

  /** Get Signal protocol keys by type and IDs */
  getKeys<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<Record<string, SignalDataTypeMap[T]>>;

  /** Set Signal protocol keys (batch) */
  setKeys(data: SignalDataSet): Promise<void>;

  /** Clear all stored data */
  clear(): Promise<void>;
}

/**
 * Adapt an AuthStore into Baileys-compatible AuthenticationState + saveCreds.
 * This allows NexaWhats stores to work with Baileys' makeWASocket too.
 */
export async function storeToAuthState(
  store: AuthStore,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const existing = await store.loadState();

  const keys: SignalKeyStore = {
    get: async (type, ids) => store.getKeys(type, ids),
    set: async (data) => store.setKeys(data),
    clear: async () => store.clear(),
  };

  const state: AuthenticationState = existing ?? {
    creds: {} as AuthenticationCreds,
    keys,
  };

  // Ensure keys always point to our store adapter
  state.keys = keys;

  const saveCreds = async () => {
    await store.saveCreds(state.creds);
  };

  return { state, saveCreds };
}
