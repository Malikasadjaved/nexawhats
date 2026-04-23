/**
 * BufferJSON — Baileys-compatible JSON serializer for Buffer/Uint8Array.
 *
 * Ported verbatim from Baileys' `Utils/generics.js` `BufferJSON`.
 *
 * Format: `{ type: 'Buffer', data: '<base64>' }`.
 *
 * This is the wire format used inside `SenderKeyRecord.serialize()` /
 * `SenderKeyRecord.deserialize()` and persisted via the auth store.
 * We must stay byte-identical to Baileys so captured fixtures decode
 * correctly in our tests.
 *
 * Note: this is **distinct** from nexawhats' internal auth-value
 * serializer (`src/store/serialize.ts`, tag `__nx_buf__`). The Group
 * Signal code interops with Baileys-shape data and uses this one.
 */

export const BufferJSON = {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  replacer: (_k: string, value: any): any => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return {
        type: 'Buffer',
        data: Buffer.from(value?.data || value).toString('base64'),
      };
    }
    return value;
  },

  // biome-ignore lint/suspicious/noExplicitAny: see above
  reviver: (_k: string, value: any): any => {
    if (
      typeof value === 'object' &&
      value !== null &&
      value.type === 'Buffer' &&
      typeof value.data === 'string'
    ) {
      return Buffer.from(value.data, 'base64');
    }
    // Handle the legacy shape where a Buffer was serialized as an
    // object of { "0": <byte>, "1": <byte>, ... }. Rebuild into a
    // Buffer when every value is numeric.
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length > 0 && keys.every((k) => !Number.isNaN(Number.parseInt(k, 10)))) {
        const values = Object.values(value);
        if (values.every((v) => typeof v === 'number')) {
          return Buffer.from(values as number[]);
        }
      }
    }
    return value;
  },
};
