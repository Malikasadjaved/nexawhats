/**
 * Ambient type declarations for `libsignal/src/crypto.js`.
 *
 * The installed `libsignal` package (git tarball from whiskeysockets)
 * publishes `index.d.ts` for its top-level API (`SessionCipher`,
 * `SessionBuilder`, etc.) but NOT for the internal crypto helpers
 * that the Group/ code imports directly. Baileys imports these via
 * deep paths like `libsignal/src/crypto.js` and `libsignal/src/curve.js`.
 *
 * We mirror that here rather than re-implementing the primitives —
 * the Signal Group protocol's correctness hinges on bit-identical
 * derivation, and libsignal's implementations are the reference.
 */

declare module 'libsignal/src/crypto.js' {
  /**
   * Compute HMAC-SHA256 of `data` under `key`. Returns the full
   * 32-byte digest.
   */
  export function calculateMAC(key: Buffer, data: Buffer): Buffer;

  /**
   * Verify an HMAC-SHA256 tag against `data` under `key`. Throws
   * on mismatch.
   */
  export function verifyMAC(data: Buffer, key: Buffer, mac: Buffer, length: number): void;

  /**
   * HKDF-SHA256 expand: derives two 32-byte keys from `input` using
   * `salt` and `info`. Returns `[firstHalf, secondHalf, thirdHalf?]`
   * — Baileys pulls slices out of these for IV + cipher key.
   */
  export function deriveSecrets(
    input: Buffer,
    salt: Buffer,
    info: Buffer,
    chunks?: number,
  ): Buffer[];

  /** AES-256-CBC encrypt with PKCS7 padding. */
  export function encrypt(key: Buffer, data: Buffer, iv: Buffer): Buffer;

  /** AES-256-CBC decrypt with PKCS7 unpadding. */
  export function decrypt(key: Buffer, data: Buffer, iv: Buffer): Buffer;

  /** SHA-512 digest. */
  export function hash(data: Buffer): Buffer;
}

declare module 'libsignal/src/curve.js' {
  export interface KeyPair {
    pubKey: Buffer;
    privKey: Buffer;
  }

  export function generateKeyPair(): KeyPair;
  export function calculateAgreement(pubKey: Buffer, privKey: Buffer): Buffer;
  export function calculateSignature(privKey: Buffer, message: Buffer): Buffer;
  export function verifySignature(pubKey: Buffer, message: Buffer, sig: Buffer): boolean;
}
