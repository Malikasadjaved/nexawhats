import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AuthenticationCreds,
  SignalDataSet,
  SignalDataTypeMap,
} from '../types/auth.js';
import type { AuthStore } from './interface.js';

/**
 * Result of a migration run.
 */
export interface MigrationResult {
  credsLoaded: boolean;
  keysMigrated: number;
  skipped: string[];
}

/**
 * Baileys encodes Buffers as { type: 'Buffer', data: [..] } in its JSON files.
 * Its own `initAuthCreds`/`JSON.parse(_, BufferJSON.reviver)` relies on this.
 * We revive that shape back to Buffer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baileysReviver(_key: string, value: any): any {
  if (
    value &&
    typeof value === 'object' &&
    value.type === 'Buffer' &&
    Array.isArray(value.data)
  ) {
    return Buffer.from(value.data);
  }
  // Our own serializer shape — tolerate files already in NexaWhats format.
  if (value && typeof value === 'object' && typeof value.__nx_buf__ === 'string') {
    return Buffer.from(value.__nx_buf__, 'base64');
  }
  return value;
}

function readJsonBaileys(path: string): unknown {
  const raw = readFileSync(path, 'utf-8');
  // Try Baileys shape first; if no Buffer markers found the reviver is a no-op.
  return JSON.parse(raw, baileysReviver);
}

/**
 * Parse a Baileys auth filename like `pre-key-12.json` or
 * `session-923124166950.1@s.whatsapp.net.json` into (type, id).
 * Returns null for files we don't recognize (e.g. creds.json).
 */
function parseBaileysFilename(
  name: string,
): { type: keyof SignalDataTypeMap; id: string } | null {
  if (!name.endsWith('.json')) return null;
  if (name === 'creds.json') return null;

  const stem = name.slice(0, -'.json'.length);

  const knownTypes: Array<keyof SignalDataTypeMap> = [
    'pre-key',
    'session',
    'sender-key',
    'sender-key-memory',
    'app-state-sync-key',
    'app-state-sync-version',
    'lid-mapping',
    'device-list',
    'tctoken',
  ];
  // Sort longest first so 'sender-key-memory' matches before 'sender-key'.
  const ordered = [...knownTypes].sort((a, b) => b.length - a.length);

  for (const type of ordered) {
    const prefix = `${type}-`;
    if (stem.startsWith(prefix)) {
      return { type, id: stem.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Migrate a Baileys multi-file auth directory into any AuthStore.
 *
 * @param sourceDir  Path to Baileys' auth directory (contains creds.json + {type}-{id}.json)
 * @param target     Destination AuthStore (e.g. a SQLiteAuthStore instance)
 */
export async function migrateFromBaileys(
  sourceDir: string,
  target: AuthStore,
): Promise<MigrationResult> {
  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  const result: MigrationResult = {
    credsLoaded: false,
    keysMigrated: 0,
    skipped: [],
  };

  // 1. Migrate credentials.
  const credsPath = join(sourceDir, 'creds.json');
  if (existsSync(credsPath)) {
    const creds = readJsonBaileys(credsPath) as AuthenticationCreds;
    await target.saveCreds(creds);
    result.credsLoaded = true;
  }

  // 2. Migrate signal keys — batch per type to leverage store transactions.
  const buckets: SignalDataSet = {};
  for (const entry of readdirSync(sourceDir)) {
    const parsed = parseBaileysFilename(entry);
    if (!parsed) {
      if (entry !== 'creds.json') result.skipped.push(entry);
      continue;
    }
    const { type, id } = parsed;
    try {
      const value = readJsonBaileys(join(sourceDir, entry));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bucket = (buckets[type] ??= {} as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bucket as any)[id] = value;
      result.keysMigrated += 1;
    } catch (err) {
      result.skipped.push(`${entry} (${(err as Error).message})`);
    }
  }

  if (Object.keys(buckets).length > 0) {
    await target.setKeys(buckets);
  }

  return result;
}
