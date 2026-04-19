/**
 * JSON serialization for auth store values.
 *
 * AuthenticationCreds and Signal key values contain Buffer/Uint8Array fields.
 * Two gotchas we need to handle:
 *
 *  1. Node's Buffer implements toJSON() → { type: 'Buffer', data: [..] }
 *     BEFORE the replacer runs, so a naive `instanceof Buffer` check in the
 *     replacer never fires for nested Buffers. We pre-walk the tree ourselves.
 *
 *  2. JSON.parse with a reviver gives us the already-parsed child, so we
 *     just match the tagged shape and rebuild the Buffer.
 */

const BUFFER_TAG = '__nx_buf__';

function encode(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { [BUFFER_TAG]: Buffer.from(value as Uint8Array).toString('base64') };
  }

  if (seen.has(value as object)) return undefined;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => encode(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = encode((value as Record<string, unknown>)[key], seen);
  }
  return out;
}

function decode(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => decode(item));
  }

  // Tagged Buffer
  const obj = value as Record<string, unknown>;
  if (typeof obj[BUFFER_TAG] === 'string') {
    return Buffer.from(obj[BUFFER_TAG] as string, 'base64');
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    out[key] = decode(obj[key]);
  }
  return out;
}

export function encodeAuthValue(value: unknown): string {
  return JSON.stringify(encode(value));
}

export function decodeAuthValue(raw: string): unknown {
  return decode(JSON.parse(raw));
}
