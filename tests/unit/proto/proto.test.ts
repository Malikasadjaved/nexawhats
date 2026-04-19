import { describe, expect, it } from 'vitest';
import { isProtoAvailable, loadProto, proto, type protoTypes } from '../../../src/proto/index.js';

/**
 * These tests intentionally run against whatever environment is live
 * when the suite executes:
 *
 * - If `@whiskeysockets/baileys` is installed under any parent
 *   `node_modules`, the dynamic require will find it and `proto.*`
 *   should behave like the real WAProto.
 * - If it is NOT installed, `isProtoAvailable()` must return `false`
 *   and every access on `proto` must throw a clear error — the core
 *   primitives (stores, codec, queue, middleware) must remain usable.
 *
 * We branch on the first check so the suite passes in both scenarios
 * without requiring baileys as a hard dev dep.
 */
describe('WAProto integration', () => {
  const available = isProtoAvailable();

  it('reports a stable availability flag', () => {
    expect(typeof available).toBe('boolean');
  });

  it('matches isProtoAvailable() on repeated calls (memoised)', () => {
    expect(isProtoAvailable()).toBe(available);
    expect(isProtoAvailable()).toBe(available);
  });

  describe('when baileys IS installed', () => {
    it.skipIf(!available)('exposes a namespace object via loadProto()', () => {
      const ns = loadProto();
      expect(typeof ns).toBe('object');
      expect(ns).not.toBeNull();
    });

    it.skipIf(!available)('resolves at least one known WAProto class via the `proto` proxy', () => {
      // `Message` and `WebMessageInfo` are stable public types in
      // Baileys' WAProto — picking `Message` keeps the test tolerant
      // of upstream renames elsewhere.
      expect(proto.Message).toBeDefined();
      expect(proto.WebMessageInfo).toBeDefined();
    });

    it.skipIf(!available)('reports membership via `in` when available', () => {
      expect('Message' in proto).toBe(true);
    });
  });

  describe('when baileys is NOT installed', () => {
    it.skipIf(available)('returns false from isProtoAvailable()', () => {
      expect(isProtoAvailable()).toBe(false);
    });

    it.skipIf(available)('throws a helpful error from loadProto()', () => {
      expect(() => loadProto()).toThrowError(/@whiskeysockets\/baileys/);
    });

    it.skipIf(available)('throws when any `proto.X` is accessed', () => {
      expect(() => proto.Message).toThrowError(/@whiskeysockets\/baileys/);
    });

    it.skipIf(available)('reports false membership via `in`', () => {
      expect('Message' in proto).toBe(false);
    });
  });

  describe('structural fallback types', () => {
    it('exposes protoTypes for consumers that only need message shapes', () => {
      const key: protoTypes.IMessageKey = {
        remoteJid: '123@s.whatsapp.net',
        fromMe: false,
        id: 'ABC',
      };
      const info: protoTypes.IWebMessageInfo = {
        key,
        message: { conversation: 'hello' },
      };
      expect(info.key.remoteJid).toBe('123@s.whatsapp.net');
      expect(info.message?.conversation).toBe('hello');
    });
  });
});
