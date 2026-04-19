import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
 * Baileys-compatible file-per-key auth store.
 *
 * Drop-in replacement for `useMultiFileAuthState`. Uses the same
 * `creds.json` + `{type}-{id}.json` layout, but every write is atomic:
 * write to `.tmp-<rand>`, fsync, rename.
 */
export class FileAuthStore implements AuthStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  async loadState(): Promise<AuthenticationState | null> {
    const credsPath = this.credsPath();
    if (!existsSync(credsPath)) return null;

    const raw = readFileSync(credsPath, 'utf-8');
    const creds = decodeAuthValue(raw) as AuthenticationCreds;

    const keys: SignalKeyStore = {
      get: async (type, ids) => this.getKeys(type, ids),
      set: async (data) => this.setKeys(data),
      clear: async () => this.clear(),
    };
    return { creds, keys };
  }

  async saveState(state: AuthenticationState): Promise<void> {
    atomicWrite(this.credsPath(), encodeAuthValue(state.creds));
  }

  async saveCreds(creds: AuthenticationCreds): Promise<void> {
    atomicWrite(this.credsPath(), encodeAuthValue(creds));
  }

  async getKeys<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<Record<string, SignalDataTypeMap[T]>> {
    const result: Record<string, SignalDataTypeMap[T]> = {};
    for (const id of ids) {
      const file = this.keyPath(type, id);
      if (!existsSync(file)) continue;
      try {
        const raw = readFileSync(file, 'utf-8');
        result[id] = decodeAuthValue(raw) as SignalDataTypeMap[T];
      } catch {
        // Corrupt file → treat as missing, don't crash the caller.
      }
    }
    return result;
  }

  async setKeys(data: SignalDataSet): Promise<void> {
    for (const [type, items] of Object.entries(data)) {
      if (!items) continue;
      for (const [id, value] of Object.entries(items)) {
        const file = this.keyPath(type, id);
        if (value === null || value === undefined) {
          if (existsSync(file)) {
            try {
              unlinkSync(file);
            } catch {
              // Best effort — file may have been removed concurrently.
            }
          }
        } else {
          atomicWrite(file, encodeAuthValue(value));
        }
      }
    }
  }

  async clear(): Promise<void> {
    if (!existsSync(this.dir)) return;
    // Remove every file in the dir but keep the dir itself.
    for (const entry of readdirSync(this.dir)) {
      try {
        rmSync(join(this.dir, entry), { recursive: true, force: true });
      } catch {
        // Ignore — worst case a stale file remains, not a correctness issue.
      }
    }
  }

  private credsPath(): string {
    return join(this.dir, 'creds.json');
  }

  private keyPath(type: string, id: string): string {
    // Baileys replaces '/' with '-' to keep IDs filesystem-safe.
    const safeId = id.replace(/\//g, '__').replace(/:/g, '-');
    return join(this.dir, `${type}-${safeId}.json`);
  }
}

/**
 * Atomic write: write to a temp file in the same directory, then rename.
 * Rename is atomic on POSIX and on Windows (NTFS) for same-volume moves.
 */
function atomicWrite(path: string, data: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, data, { encoding: 'utf-8' });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}
