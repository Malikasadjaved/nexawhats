import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from '../types/auth.js';
import type { AuthStore } from './interface.js';
import { decodeAuthValue, encodeAuthValue } from './serialize.js';

/**
 * Dynamically load better-sqlite3. It's an optional peer dependency, so we
 * only require it when the store is actually instantiated — that way the
 * library works without native deps for memory/file users.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadBetterSqlite(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('better-sqlite3');
  } catch (err) {
    throw new Error(
      'SQLiteAuthStore requires better-sqlite3. Install with: npm install better-sqlite3',
    );
  }
}

export interface SQLiteAuthStoreOptions {
  /** Path to the SQLite database file. Use ':memory:' for ephemeral DB. */
  path: string;
  /** If true (default), enables WAL mode for safer concurrent writes. */
  wal?: boolean;
  /** Optional pragma overrides. */
  pragmas?: Record<string, string | number>;
}

/**
 * Production-grade SQLite auth store.
 *
 * - Atomic writes via transactions
 * - WAL mode for durability under crashes
 * - No file corruption (unlike Baileys' JSON files)
 *
 * Schema:
 *   credentials(id PRIMARY KEY, data BLOB)       -- single row (id=1)
 *   signal_keys(type, id, data, PRIMARY KEY(type, id))
 */
export class SQLiteAuthStore implements AuthStore {
  private readonly db: BetterSqliteDatabase;
  private readonly stmts: {
    getCreds: import('better-sqlite3').Statement;
    setCreds: import('better-sqlite3').Statement;
    getKey: import('better-sqlite3').Statement;
    setKey: import('better-sqlite3').Statement;
    deleteKey: import('better-sqlite3').Statement;
    clearCreds: import('better-sqlite3').Statement;
    clearKeys: import('better-sqlite3').Statement;
  };

  constructor(options: SQLiteAuthStoreOptions) {
    const Database = loadBetterSqlite();
    this.db = new Database(options.path);

    if (options.wal !== false && options.path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    for (const [key, value] of Object.entries(options.pragmas ?? {})) {
      this.db.pragma(`${key} = ${value}`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signal_keys (
        type TEXT NOT NULL,
        id   TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (type, id)
      );
    `);

    this.stmts = {
      getCreds: this.db.prepare('SELECT data FROM credentials WHERE id = 1'),
      setCreds: this.db.prepare(
        'INSERT INTO credentials (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      ),
      getKey: this.db.prepare('SELECT data FROM signal_keys WHERE type = ? AND id = ?'),
      setKey: this.db.prepare(
        'INSERT INTO signal_keys (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data',
      ),
      deleteKey: this.db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
      clearCreds: this.db.prepare('DELETE FROM credentials'),
      clearKeys: this.db.prepare('DELETE FROM signal_keys'),
    };
  }

  async loadState(): Promise<AuthenticationState | null> {
    const row = this.stmts.getCreds.get() as { data: string } | undefined;
    if (!row) return null;

    const creds = decodeAuthValue(row.data) as AuthenticationCreds;
    const keys: SignalKeyStore = {
      get: async (type, ids) => this.getKeys(type, ids),
      set: async (data) => this.setKeys(data),
      clear: async () => this.clear(),
    };
    return { creds, keys };
  }

  async saveState(state: AuthenticationState): Promise<void> {
    this.stmts.setCreds.run(encodeAuthValue(state.creds));
  }

  async saveCreds(creds: AuthenticationCreds): Promise<void> {
    this.stmts.setCreds.run(encodeAuthValue(creds));
  }

  async getKeys<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<Record<string, SignalDataTypeMap[T]>> {
    const result: Record<string, SignalDataTypeMap[T]> = {};
    for (const id of ids) {
      const row = this.stmts.getKey.get(type, id) as { data: string } | undefined;
      if (row) {
        result[id] = decodeAuthValue(row.data) as SignalDataTypeMap[T];
      }
    }
    return result;
  }

  async setKeys(data: SignalDataSet): Promise<void> {
    const tx = this.db.transaction((entries: SignalDataSet) => {
      for (const [type, items] of Object.entries(entries)) {
        if (!items) continue;
        for (const [id, value] of Object.entries(items)) {
          if (value === null || value === undefined) {
            this.stmts.deleteKey.run(type, id);
          } else {
            this.stmts.setKey.run(type, id, encodeAuthValue(value));
          }
        }
      }
    });
    tx(data);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction(() => {
      this.stmts.clearCreds.run();
      this.stmts.clearKeys.run();
    });
    tx();
  }

  /** Close the database connection. Call during shutdown. */
  close(): void {
    this.db.close();
  }

  /** Key count for testing/observability. */
  get keyCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM signal_keys').get() as { n: number };
    return row.n;
  }
}
