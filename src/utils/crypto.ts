import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * HKDF (HMAC-based Key Derivation Function) as used by WhatsApp.
 * Derives key material from input keying material.
 */
export function hkdf(ikm: Buffer, length: number, info: Buffer | string, salt?: Buffer): Buffer {
  const actualSalt = salt ?? Buffer.alloc(32, 0);
  const infoBuffer = typeof info === 'string' ? Buffer.from(info) : info;

  // Extract
  const prk = createHmac('sha256', actualSalt).update(ikm).digest();

  // Expand
  const n = Math.ceil(length / 32);
  const okm = Buffer.alloc(n * 32);
  let prev = Buffer.alloc(0);

  for (let i = 0; i < n; i++) {
    const hmac = createHmac('sha256', prk);
    hmac.update(prev);
    hmac.update(infoBuffer);
    hmac.update(Buffer.from([i + 1]));
    prev = hmac.digest();
    prev.copy(okm, i * 32);
  }

  return okm.subarray(0, length);
}

/** AES-256-CBC encrypt */
export function aesEncrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}

/** AES-256-CBC decrypt */
export function aesDecrypt(data: Buffer, key: Buffer): Buffer {
  const iv = data.subarray(0, 16);
  const encrypted = data.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/** HMAC-SHA256 */
export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Generate random bytes */
export function generateRandomBytes(length: number): Buffer {
  return randomBytes(length);
}

/** Generate a random message ID */
export function generateMessageId(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}
