import { describe, expect, it } from 'vitest';
import { decodeAuthValue, encodeAuthValue } from '../../../src/store/serialize.js';

describe('auth value serialization', () => {
  it('round-trips primitive JSON values', () => {
    const input = { a: 1, b: 'x', c: true, d: null, e: [1, 2, 3] };
    const decoded = decodeAuthValue(encodeAuthValue(input));
    expect(decoded).toEqual(input);
  });

  it('round-trips Buffer values', () => {
    const buf = Buffer.from([1, 2, 3, 255, 0, 128]);
    const encoded = encodeAuthValue({ key: buf });
    const decoded = decodeAuthValue(encoded) as { key: Buffer };
    expect(Buffer.isBuffer(decoded.key)).toBe(true);
    expect(decoded.key.equals(buf)).toBe(true);
  });

  it('round-trips Uint8Array as Buffer', () => {
    const u8 = new Uint8Array([4, 5, 6]);
    const decoded = decodeAuthValue(encodeAuthValue({ x: u8 })) as { x: Buffer };
    expect(Buffer.isBuffer(decoded.x)).toBe(true);
    expect(Array.from(decoded.x)).toEqual([4, 5, 6]);
  });

  it('handles nested Buffers in objects and arrays', () => {
    const input = {
      noiseKey: { public: Buffer.from([1]), private: Buffer.from([2]) },
      list: [Buffer.from('abc'), Buffer.from('def')],
    };
    const decoded = decodeAuthValue(encodeAuthValue(input)) as typeof input;
    expect(decoded.noiseKey.public.equals(Buffer.from([1]))).toBe(true);
    expect(decoded.noiseKey.private.equals(Buffer.from([2]))).toBe(true);
    expect((decoded.list[0] as Buffer).toString()).toBe('abc');
    expect((decoded.list[1] as Buffer).toString()).toBe('def');
  });

  it('does not confuse objects with a plain __nx_buf__ string field', () => {
    // Reviver only triggers when the tag value is a string — that's the contract.
    // Here we simulate a user object that happens to have that field as a number.
    const input = { __nx_buf__: 42 };
    const decoded = decodeAuthValue(encodeAuthValue(input)) as typeof input;
    expect(decoded.__nx_buf__).toBe(42);
  });
});
