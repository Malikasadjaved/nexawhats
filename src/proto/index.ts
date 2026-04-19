/**
 * WAProto integration — re-exports Baileys' compiled protobuf definitions
 * as an optional peer dependency.
 *
 * Rationale: regenerating ~97k lines of protobufjs output from
 * `WAProto.proto` adds a heavy build step for zero functional benefit.
 * Baileys already ships the compiled statics under
 * `@whiskeysockets/baileys/WAProto`. We dynamically require that module
 * at runtime; if Baileys is not installed, the `proto` proxy throws
 * on access so stores, codec, queue, and middleware still work without
 * WAProto.
 *
 * Callers that need the full WAProto (e.g. message send/receive) must
 * install `@whiskeysockets/baileys` as a direct dependency and check
 * {@link isProtoAvailable} before using `proto` at runtime.
 */
import { createRequire } from 'node:module';

// `createRequire` needs a base URL/path to resolve from. Prefer
// `import.meta.url` under ESM; fall back to CWD when tsup re-emits
// this file as CJS (where `import.meta` is not available).
function buildRequire(): NodeRequire {
  let metaUrl: string | undefined;
  try {
    // Wrapping in `new Function` keeps this file parseable under both
    // ESM and CJS output — the probe runs only in ESM, where
    // `import.meta.url` is a real binding.
    metaUrl = new Function('try { return import.meta.url; } catch { return undefined; }')() as
      | string
      | undefined;
  } catch {
    metaUrl = undefined;
  }
  if (metaUrl) return createRequire(metaUrl);
  return createRequire(`${process.cwd()}/`);
}

const _require = buildRequire();

/** Loaded WAProto module (or `null` if baileys is not installed). */
let _loaded: { proto: Record<string, unknown> } | null = null;

/** Error captured the last time we tried to load WAProto, if any. */
let _loadError: Error | null = null;

function tryLoad(): { proto: Record<string, unknown> } | null {
  if (_loaded !== null) return _loaded;
  if (_loadError !== null) return null;

  // Try several resolution strategies — the compiled statics live at a
  // sub-path and module resolution differs between ESM/CJS callers.
  const candidates = [
    '@whiskeysockets/baileys/WAProto/index.js',
    '@whiskeysockets/baileys/WAProto',
    '@whiskeysockets/baileys',
  ];

  for (const spec of candidates) {
    try {
      const mod = _require(spec) as unknown as
        | { proto?: Record<string, unknown> }
        | { default?: { proto?: Record<string, unknown> } };

      const maybeProto =
        (mod as { proto?: Record<string, unknown> }).proto ??
        (mod as { default?: { proto?: Record<string, unknown> } }).default?.proto;

      if (maybeProto && typeof maybeProto === 'object') {
        _loaded = { proto: maybeProto };
        return _loaded;
      }
    } catch (err) {
      // Record only the most recent failure — we surface it if all
      // candidates fail.
      _loadError = err instanceof Error ? err : new Error(String(err));
    }
  }
  return null;
}

/** Returns `true` if `@whiskeysockets/baileys`'s WAProto is available. */
export function isProtoAvailable(): boolean {
  return tryLoad() !== null;
}

/**
 * Load the full WAProto namespace. Throws if
 * `@whiskeysockets/baileys` is not installed — callers that can live
 * without it should gate on {@link isProtoAvailable} first.
 */
export function loadProto(): Record<string, unknown> {
  const loaded = tryLoad();
  if (loaded) return loaded.proto;
  throw new Error(
    `WAProto is unavailable: install \`@whiskeysockets/baileys\` as a dependency. Last load error: ${_loadError?.message ?? 'unknown'}`,
  );
}

/**
 * The `proto` namespace — typed as `any` at runtime since the real
 * definitions come from Baileys' 3-megabyte `.d.ts`. Consumers that
 * want strict typing should `import type { proto } from '@whiskeysockets/baileys'`
 * directly.
 *
 * Accessing `proto.X` on this proxy when Baileys is not installed will
 * throw with a clear error message.
 */
// biome-ignore lint/suspicious/noExplicitAny: protobuf types come from baileys
export const proto: any = new Proxy(
  {},
  {
    get(_target, prop: string | symbol) {
      const loaded = tryLoad();
      if (!loaded) {
        throw new Error(
          `WAProto.${String(prop)} requested but \`@whiskeysockets/baileys\` is not installed. Add it to your dependencies to enable send/receive features.`,
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: see namespace comment
      return (loaded.proto as any)[prop as string];
    },
    has(_target, prop: string | symbol) {
      const loaded = tryLoad();
      if (!loaded) return false;
      return prop in loaded.proto;
    },
  },
);

/**
 * Minimal structural types for cases where consumers only need to
 * describe message shapes (e.g. the queue payload) without pulling in
 * the full WAProto definitions. Kept deliberately lean — the canonical
 * runtime types live in Baileys.
 */
export interface ProtoMessageKey {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
}

export interface ProtoMessage {
  conversation?: string | null;
  // Deliberately loose — use Baileys' real types for precise shapes.
  [key: string]: unknown;
}

export interface ProtoWebMessageInfo {
  key: ProtoMessageKey;
  message?: ProtoMessage | null;
  messageTimestamp?: number | null;
  pushName?: string | null;
  status?: number | null;
  participant?: string | null;
  broadcast?: boolean | null;
}

/** Namespace-style alias so callers can write `protoTypes.IMessageKey`. */
export const protoTypes = {} as const;

export namespace protoTypes {
  export type IMessageKey = ProtoMessageKey;
  export type IMessage = ProtoMessage;
  export type IWebMessageInfo = ProtoWebMessageInfo;
}
