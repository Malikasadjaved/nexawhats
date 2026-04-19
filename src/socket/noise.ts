/**
 * Noise protocol handshake (Noise_XX_25519_AESGCM_SHA256).
 *
 * Ported verbatim from Baileys' `lib/Utils/noise-handler.js` (v7.0.0-rc.9)
 * with strict TypeScript types. The logic is deterministic: XX
 * handshake + HKDF + AES-256-GCM framing. Two unit tests replay
 * captured byte sequences to prove we encrypt/decrypt identically to
 * Baileys.
 *
 * Critical behaviour the tests guard:
 * - Per-direction read/write counters reset on `finishInit()`
 * - `encodeFrame` prepends `NOISE_HEADER` on the first frame only
 *   (tracked via `sentIntro` flag)
 * - Certificate serial validation against `WA_CERT_DETAILS.SERIAL`
 *   (Baileys ships this as `0` — see `WA_CERT_DETAILS` below)
 */
import type { Logger } from 'pino';
import { proto } from '../proto/index.js';
import {
  Curve,
  type RawKeyPair,
  aesDecryptGCM,
  aesEncryptGCM,
  hkdf,
  sha256,
} from '../utils/crypto.js';

/** Noise protocol identifier — embedded into the handshake hash. */
export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0';

/** Default WA noise frame header (4 bytes: "WA" + 6 + dict version 3). */
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, 3]);

/**
 * WhatsApp cert details. Baileys ships `SERIAL: 0` with a TODO for
 * the real root CA — we mirror it. If Meta ever rotates the cert,
 * callers will see `CertificateMismatchError` from the handshake.
 */
export const WA_CERT_DETAILS = {
  SERIAL: 0,
};

/** Error thrown when the intermediate cert's issuer serial doesn't match. */
export class CertificateMismatchError extends Error {
  readonly statusCode = 400;
  constructor() {
    super('certification match failed');
    this.name = 'CertificateMismatchError';
  }
}

/**
 * Binary node (as produced by `decodeBinaryNode`). The noise handler
 * emits these to `onFrame`; we keep the type loose to avoid a cyclic
 * import on `binary/types`.
 */
// biome-ignore lint/suspicious/noExplicitAny: frames are heterogeneous
export type NoiseFrame = Buffer | any;

/** A raw minimal "routing info" blob injected into the first frame. */
export type RoutingInfo = Buffer;

export interface NoiseServerHello {
  ephemeral: Uint8Array;
  static: Uint8Array;
  payload: Uint8Array;
}

export interface NoiseHandshakeMessage {
  serverHello: NoiseServerHello;
}

export interface MakeNoiseHandlerOptions {
  keyPair: RawKeyPair;
  /** First-frame header — defaults to `NOISE_WA_HEADER`. */
  NOISE_HEADER?: Buffer;
  logger: Logger;
  /** Optional routing info prepended to the first frame. */
  routingInfo?: RoutingInfo;
}

export interface NoiseHandler {
  /** Mix data into the running handshake hash. No-op after init. */
  authenticate(data: Buffer | Uint8Array): void;
  /** Encrypt with current encKey; advances the write counter. */
  encrypt(plaintext: Buffer | Uint8Array): Buffer;
  /** Decrypt with current decKey; advances the appropriate counter. */
  decrypt(ciphertext: Buffer | Uint8Array): Buffer;
  /** HKDF-mix a DH output into the running salt+key chain. */
  mixIntoKey(data: Buffer | Uint8Array): Promise<void>;
  /** Finalise the handshake — split keys, reset counters. */
  finishInit(): Promise<void>;
  /**
   * Process the server's handshake message, returning the encrypted
   * client-static key the caller should include in its final auth
   * envelope.
   */
  processHandshake(msg: NoiseHandshakeMessage, noiseKey: RawKeyPair): Promise<Buffer>;
  /** Wrap a payload into a framed (and post-handshake, encrypted) frame. */
  encodeFrame(data: Buffer | Uint8Array): Buffer;
  /**
   * Feed bytes off the wire in; emits one callback per decoded frame.
   * Callbacks receive either a raw `Buffer` (pre-handshake) or a
   * `BinaryNode` (post-handshake, already decoded).
   */
  decodeFrame(newData: Buffer | Uint8Array, onFrame: (frame: NoiseFrame) => void): Promise<void>;
  /** True once `finishInit()` has been called. */
  readonly isFinished: () => boolean;
}

/** Build the 12-byte GCM IV from a 32-bit counter (big-endian tail). */
function generateIV(counter: number): Uint8Array {
  const iv = new ArrayBuffer(12);
  new DataView(iv).setUint32(8, counter);
  return new Uint8Array(iv);
}

/**
 * Factory — return a fresh Noise handler. Not shareable across
 * connections (mutable hash/counter state).
 */
export function makeNoiseHandler({
  keyPair: { private: privateKey, public: publicKey },
  NOISE_HEADER = NOISE_WA_HEADER,
  logger: parentLogger,
  routingInfo,
}: MakeNoiseHandlerOptions): NoiseHandler {
  const logger = parentLogger.child({ class: 'ns' });

  // ── Handshake state ─────────────────────────────────────────────
  const modeBytes = Buffer.from(NOISE_MODE);
  let hash: Buffer = modeBytes.byteLength === 32 ? modeBytes : sha256(modeBytes);
  let salt: Buffer = hash;
  let encKey: Buffer = hash;
  let decKey: Buffer = hash;
  let readCounter = 0;
  let writeCounter = 0;
  let isFinished = false;
  let sentIntro = false;
  let inBytes: Buffer = Buffer.alloc(0);

  const authenticate = (data: Buffer | Uint8Array): void => {
    if (!isFinished) {
      hash = sha256(Buffer.concat([hash, Buffer.from(data)]));
    }
  };

  const encrypt = (plaintext: Buffer | Uint8Array): Buffer => {
    const result = aesEncryptGCM(plaintext, encKey, generateIV(writeCounter), hash);
    writeCounter += 1;
    authenticate(result);
    return result;
  };

  const decrypt = (ciphertext: Buffer | Uint8Array): Buffer => {
    // Before the handshake is finished, we use the same counter for
    // both directions; after, they're independent.
    const iv = generateIV(isFinished ? readCounter : writeCounter);
    const result = aesDecryptGCM(ciphertext, decKey, iv, hash);
    if (isFinished) {
      readCounter += 1;
    } else {
      writeCounter += 1;
    }
    authenticate(ciphertext);
    return result;
  };

  const localHKDF = (data: Buffer | Uint8Array): [Buffer, Buffer] => {
    const key = hkdf(Buffer.from(data), 64, { salt, info: '' });
    return [key.subarray(0, 32), key.subarray(32)];
  };

  const mixIntoKey = async (data: Buffer | Uint8Array): Promise<void> => {
    const [write, read] = localHKDF(data);
    salt = write;
    encKey = read;
    decKey = read;
    readCounter = 0;
    writeCounter = 0;
  };

  const finishInit = async (): Promise<void> => {
    const [write, read] = localHKDF(new Uint8Array(0));
    encKey = write;
    decKey = read;
    hash = Buffer.from([]);
    readCounter = 0;
    writeCounter = 0;
    isFinished = true;
  };

  // Seed the hash with the header and our static public key — exactly
  // the order Baileys uses.
  authenticate(NOISE_HEADER);
  authenticate(publicKey);

  const processHandshake = async (
    { serverHello }: NoiseHandshakeMessage,
    noiseKey: RawKeyPair,
  ): Promise<Buffer> => {
    authenticate(serverHello.ephemeral);
    await mixIntoKey(Curve.sharedKey(privateKey, serverHello.ephemeral));

    const decStaticContent = decrypt(serverHello.static);
    await mixIntoKey(Curve.sharedKey(privateKey, decStaticContent));

    const certDecoded = decrypt(serverHello.payload);

    // Parse the cert chain via Baileys' WAProto. If baileys isn't
    // installed, `proto.CertChain` will throw a clear error — the
    // caller should ensure WAProto is loaded before running a
    // handshake (check with `isProtoAvailable()`).
    // biome-ignore lint/suspicious/noExplicitAny: protobuf runtime value
    const CertChain = (proto as any).CertChain;
    const { intermediate: certIntermediate } = CertChain.decode(certDecoded);
    const { issuerSerial } = CertChain.NoiseCertificate.Details.decode(certIntermediate.details);

    if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
      throw new CertificateMismatchError();
    }

    const keyEnc = encrypt(noiseKey.public);
    await mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello.ephemeral));
    return keyEnc;
  };

  const encodeFrame = (data: Buffer | Uint8Array): Buffer => {
    const payload = isFinished ? encrypt(data) : Buffer.from(data);

    let header: Buffer;
    if (routingInfo) {
      header = Buffer.alloc(7);
      header.write('ED', 0, 'utf8');
      header.writeUInt8(0, 2);
      header.writeUInt8(1, 3);
      header.writeUInt8(routingInfo.byteLength >> 16, 4);
      header.writeUInt16BE(routingInfo.byteLength & 0xffff, 5);
      header = Buffer.concat([header, routingInfo, NOISE_HEADER]);
    } else {
      header = Buffer.from(NOISE_HEADER);
    }

    const introSize = sentIntro ? 0 : header.length;
    const frame = Buffer.alloc(introSize + 3 + payload.byteLength);
    if (!sentIntro) {
      frame.set(header);
      sentIntro = true;
    }
    frame.writeUInt8(payload.byteLength >> 16, introSize);
    frame.writeUInt16BE(0xffff & payload.byteLength, introSize + 1);
    frame.set(payload, introSize + 3);
    return frame;
  };

  const decodeFrame = async (
    newData: Buffer | Uint8Array,
    onFrame: (frame: NoiseFrame) => void,
  ): Promise<void> => {
    // The binary protocol uses its own 3-byte length-prefixed framing
    // on top of the WS frames — we need to de-chunk and possibly
    // decrypt+decode each one.
    const getBytesSize = (): number | undefined => {
      if (inBytes.length >= 3) {
        return (inBytes.readUInt8(0) << 16) | inBytes.readUInt16BE(1);
      }
      return undefined;
    };

    inBytes = Buffer.concat([inBytes, Buffer.from(newData)]);
    logger.trace(`recv ${newData.length} bytes, total recv ${inBytes.length} bytes`);

    let size = getBytesSize();
    while (size !== undefined && inBytes.length >= size + 3) {
      let frame: NoiseFrame = inBytes.subarray(3, size + 3);
      inBytes = inBytes.subarray(size + 3);
      if (isFinished) {
        const plaintext = decrypt(frame);
        // Lazy-import to avoid a hard dep cycle with the binary codec.
        const { decodeBinaryNode } = await import('../binary/decoder.js');
        frame = await decodeBinaryNode(plaintext);
      }
      logger.trace({ msg: frame?.attrs?.id }, 'recv frame');
      onFrame(frame);
      size = getBytesSize();
    }
  };

  return {
    authenticate,
    encrypt,
    decrypt,
    mixIntoKey,
    finishInit,
    processHandshake,
    encodeFrame,
    decodeFrame,
    isFinished: () => isFinished,
  };
}
