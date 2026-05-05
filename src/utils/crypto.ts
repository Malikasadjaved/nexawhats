import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';

/**
 * HKDF (HMAC-based Key Derivation Function) as used by WhatsApp.
 *
 * Matches Baileys' signature: accepts `info` as an object with
 * optional `salt` (Uint8Array) and optional `info` (string). The
 * legacy positional signature (`hkdf(buffer, len, info: string|Buffer,
 * salt?)`) is preserved via overloads so existing callers don't break.
 *
 * Returns a `Buffer` of exactly `length` bytes.
 */
export function hkdf(
  ikm: Buffer | Uint8Array,
  length: number,
  options: { salt?: Buffer | Uint8Array; info?: string | Buffer | Uint8Array },
): Buffer;
export function hkdf(
  ikm: Buffer | Uint8Array,
  length: number,
  info: string | Buffer,
  salt?: Buffer,
): Buffer;
export function hkdf(
  ikm: Buffer | Uint8Array,
  length: number,
  infoOrOptions:
    | string
    | Buffer
    | Uint8Array
    | { salt?: Buffer | Uint8Array; info?: string | Buffer | Uint8Array },
  maybeSalt?: Buffer,
): Buffer {
  let saltBuf: Buffer;
  let infoBuf: Buffer;

  if (
    infoOrOptions !== null &&
    typeof infoOrOptions === 'object' &&
    !Buffer.isBuffer(infoOrOptions) &&
    !(infoOrOptions instanceof Uint8Array)
  ) {
    saltBuf = infoOrOptions.salt ? Buffer.from(infoOrOptions.salt) : Buffer.alloc(0);
    const infoVal = infoOrOptions.info ?? '';
    infoBuf = typeof infoVal === 'string' ? Buffer.from(infoVal) : Buffer.from(infoVal);
  } else {
    // Legacy positional signature. Default salt is a 32-byte zero
    // vector (the behaviour the existing nexawhats callers relied on).
    saltBuf = maybeSalt ?? Buffer.alloc(32, 0);
    infoBuf =
      typeof infoOrOptions === 'string'
        ? Buffer.from(infoOrOptions)
        : Buffer.from(infoOrOptions as Buffer | Uint8Array);
  }

  const ikmBuf = Buffer.from(ikm);

  // Extract
  const prk = createHmac('sha256', saltBuf).update(ikmBuf).digest();

  // Expand
  const n = Math.ceil(length / 32);
  const okm = Buffer.alloc(n * 32);
  let prev = Buffer.alloc(0);

  for (let i = 0; i < n; i++) {
    const hmac = createHmac('sha256', prk);
    hmac.update(prev);
    hmac.update(infoBuf);
    hmac.update(Buffer.from([i + 1]));
    prev = hmac.digest();
    prev.copy(okm, i * 32);
  }

  return okm.subarray(0, length);
}

/** AES-256-CBC encrypt (random IV prefixed to output). */
export function aesEncrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

/** AES-256-CBC decrypt (expects IV prefixed). */
export function aesDecrypt(data: Buffer, key: Buffer): Buffer {
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

const GCM_TAG_LENGTH = 16;

/**
 * AES-256-GCM encrypt — the authentication tag is appended to the
 * ciphertext to match WhatsApp's Noise framing.
 */
export function aesEncryptGCM(
  plaintext: Buffer | Uint8Array,
  key: Buffer,
  iv: Buffer | Uint8Array,
  additionalData: Buffer | Uint8Array,
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/**
 * AES-256-GCM decrypt — the authentication tag is expected to be
 * appended to the ciphertext (last 16 bytes).
 */
export function aesDecryptGCM(
  ciphertext: Buffer | Uint8Array,
  key: Buffer,
  iv: Buffer | Uint8Array,
  additionalData: Buffer | Uint8Array,
): Buffer {
  const cipherBuf = Buffer.from(ciphertext);
  const enc = cipherBuf.subarray(0, cipherBuf.length - GCM_TAG_LENGTH);
  const tag = cipherBuf.subarray(cipherBuf.length - GCM_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(additionalData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/** AES-256-CTR encrypt. Used for pairing code key wrapping. */
export function aesEncryptCTR(
  plaintext: Buffer | Uint8Array,
  key: Buffer | Uint8Array,
  iv: Buffer | Uint8Array,
): Buffer {
  const cipher = createCipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** HMAC-SHA256. */
export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HMAC with arbitrary variant (default SHA-256). */
export function hmacSign(
  buffer: Buffer | Uint8Array,
  key: Buffer | Uint8Array,
  variant: 'sha256' | 'sha512' = 'sha256',
): Buffer {
  return createHmac(variant, key).update(buffer).digest();
}

/** SHA-256. */
export function sha256(buffer: Buffer | Uint8Array): Buffer {
  return createHash('sha256').update(buffer).digest();
}

/** SHA-1. */
export function sha1(buffer: Buffer | Uint8Array): Buffer {
  return createHash('sha1').update(buffer).digest();
}

/** MD5 (WhatsApp media hashes use this). */
export function md5(buffer: Buffer | Uint8Array): Buffer {
  return createHash('md5').update(buffer).digest();
}

/** Cryptographically strong random bytes. */
export function generateRandomBytes(length: number): Buffer {
  return randomBytes(length);
}

/** Generate a random message ID — 8 random bytes as uppercase hex. */
export function generateMessageId(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}

// ────────────────────────────────────────────────────────────────────
// X25519 Curve — raw 32-byte keypair + Diffie-Hellman agreement.
//
// Node's `crypto` module supports X25519 natively (since Node 18), but
// only via DER-encoded KeyObject. The Noise handshake and the Signal
// protocol both operate on raw 32-byte keys — we wrap Node's API to
// present that shape.
// ────────────────────────────────────────────────────────────────────

/** SPKI (SubjectPublicKeyInfo) prefix for an X25519 public key. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** PKCS#8 prefix for an X25519 private key. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** Wrap a raw 32-byte X25519 public key into a Node `KeyObject`. */
function rawToPublicKey(raw: Buffer | Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new Error(`X25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

/** Wrap a raw 32-byte X25519 private key into a Node `KeyObject`. */
function rawToPrivateKey(raw: Buffer | Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new Error(`X25519 private key must be 32 bytes, got ${raw.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Raw 32-byte key pair (public + private, no SPKI/PKCS8 framing). */
export interface RawKeyPair {
  /** 32 random bytes. */
  private: Buffer;
  /** X25519 public key derived from `private`, 32 bytes. */
  public: Buffer;
}

/**
 * X25519 Curve helpers — a drop-in for Baileys' `libsignal` Curve.
 *
 * Baileys' Curve returns 32-byte raw keys but Baileys also prefixes
 * public keys with a version byte (0x05) in many contexts. We keep
 * the same convention: `public` here is the RAW 32 bytes (no version
 * byte) — add the prefix at the call site if needed (the Signal
 * protocol needs it; the Noise handshake does NOT).
 */
export const Curve = {
  generateKeyPair(): RawKeyPair {
    const kp = generateKeyPairSync('x25519');
    const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
    const privDer = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
    return {
      public: Buffer.from(pubDer.subarray(pubDer.length - 32)),
      private: Buffer.from(privDer.subarray(privDer.length - 32)),
    };
  },

  sharedKey(privateKey: Buffer | Uint8Array, publicKey: Buffer | Uint8Array): Buffer {
    // Some callers pass 33-byte keys (with the 0x05 version prefix) —
    // strip it so raw DH works.
    const pubRaw = publicKey.length === 33 ? publicKey.subarray(1) : publicKey;
    return Buffer.from(
      diffieHellman({
        privateKey: rawToPrivateKey(privateKey),
        publicKey: rawToPublicKey(pubRaw),
      }),
    );
  },

  sign(privateKey: Buffer | Uint8Array, message: Buffer | Uint8Array): Buffer {
    // libsignal's curve.calculateSignature is the Ed25519-on-Curve25519
    // variant WhatsApp uses — identity key signatures + signed pre-keys
    // all go through this. Baileys delegates to the same function.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const curve = require('libsignal/src/curve.js') as {
      calculateSignature(priv: Uint8Array, msg: Uint8Array): Uint8Array;
    };
    return Buffer.from(curve.calculateSignature(privateKey, message));
  },

  verify(
    publicKey: Buffer | Uint8Array,
    message: Buffer | Uint8Array,
    signature: Buffer | Uint8Array,
  ): boolean {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const curve = require('libsignal/src/curve.js') as {
      verifySignature(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): void;
    };
    try {
      curve.verifySignature(generateSignalPubKey(publicKey), message, signature);
      return true;
    } catch {
      return false;
    }
  },
};

/** Sign a freshly generated pre-key with the identity key. */
export function signedKeyPair(
  identityKeyPair: RawKeyPair,
  keyId: number,
): { keyPair: RawKeyPair; signature: Buffer; keyId: number } {
  const preKey = Curve.generateKeyPair();
  const pubKey = generateSignalPubKey(preKey.public);
  const signature = Curve.sign(identityKeyPair.private, pubKey);
  return { keyPair: preKey, signature, keyId };
}

/** Random 14-bit WhatsApp registration id (same shape as Baileys). */
export function generateRegistrationId(): number {
  return Uint16Array.from(generateRandomBytes(2))[0] & 16383;
}

/**
 * Signal protocol version byte prefixed to public keys in several
 * contexts (pre-key bundles, sender-key distribution messages).
 * Baileys calls this KEY_BUNDLE_TYPE and uses the single byte 0x05.
 */
export const KEY_BUNDLE_TYPE = Buffer.from([5]);

/**
 * Prefix the Signal version byte to a raw 32-byte public key, producing
 * the 33-byte form libsignal expects. If the input is already 33 bytes,
 * it is returned unchanged.
 *
 * Ported verbatim from Baileys' generateSignalPubKey helper.
 */
export const generateSignalPubKey = (pubKey: Buffer | Uint8Array): Buffer =>
  pubKey.length === 33
    ? Buffer.from(pubKey)
    : Buffer.concat([KEY_BUNDLE_TYPE, Buffer.from(pubKey)]);
