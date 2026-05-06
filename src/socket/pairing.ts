/**
 * Pairing-code device registration — builds the `link_code_companion_reg`
 * IQ stanza and processes the `pair-success` response.
 *
 * Ported from Baileys' socket.js `requestPairingCode` +
 * `configureSuccessfulPairing` (Utils/validate-connection.js).
 */
import { createRequire } from 'node:module';
import type { BinaryNode } from '../binary/index.js';
import { S_WHATSAPP_NET, jidEncode } from '../binary/jid.js';
import { proto } from '../proto/index.js';
import type { AuthenticationCreds } from '../types/auth.js';
import { aesEncryptCTR, generateRandomBytes, hmacSign } from '../utils/crypto.js';

const _require = createRequire(import.meta.url);

// ── ADV (Account/Device Verification) signature prefixes ────────────
const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0]);
const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1]);
const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5]);

// ── Crockford base32 ────────────────────────────────────────────────
const CROCKFORD_CHARS = '123456789ABCDEFGHJKLMNPQRSTVWXYZ';

/** Encode a buffer as a Crockford base32 string (used for pairing codes). */
export function bytesToCrockford(buffer: Buffer | Uint8Array): string {
  let value = 0;
  let bitCount = 0;
  const result: string[] = [];

  for (const byte of buffer) {
    value = (value << 8) | (byte & 0xff);
    bitCount += 8;
    while (bitCount >= 5) {
      result.push(CROCKFORD_CHARS.charAt((value >>> (bitCount - 5)) & 31));
      bitCount -= 5;
    }
  }
  if (bitCount > 0) {
    result.push(CROCKFORD_CHARS.charAt((value << (5 - bitCount)) & 31));
  }
  return result.join('');
}

// ── PBKDF2 pairing-code key derivation ──────────────────────────────

/**
 * Derive a 32-byte AES key from a pairing code and salt via PBKDF2
 * (SHA-256, 131072 iterations). Uses the Web Crypto API — same as Baileys.
 */
export async function derivePairingCodeKey(
  pairingCode: string,
  salt: Buffer | Uint8Array,
): Promise<Buffer> {
  const encoder = new TextEncoder();
  const pairingCodeBuf = encoder.encode(pairingCode);
  const saltBuf = salt instanceof Uint8Array ? new Uint8Array(salt) : new Uint8Array(salt);

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    pairingCodeBuf,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBuf,
      iterations: 2 << 16, // 131,072
      hash: 'SHA-256',
    },
    keyMaterial,
    32 * 8, // 256 bits
  );

  return Buffer.from(derivedBits);
}

// ── Pairing code generation ─────────────────────────────────────────

/** Generate an 8-character Crockford pairing code from 5 random bytes. */
export function generatePairingCode(): string {
  return bytesToCrockford(generateRandomBytes(5));
}

// ── Pairing key encryption ──────────────────────────────────────────

/**
 * Encrypt the pairing ephemeral public key with the pairing code, ready
 * for embedding in the `link_code_companion_reg` IQ.
 */
export async function generatePairingKey(
  pairingCode: string,
  pairingEphemeralPublicKey: Buffer | Uint8Array,
): Promise<Buffer> {
  const salt = generateRandomBytes(32);
  const randomIv = generateRandomBytes(16);
  const key = await derivePairingCodeKey(pairingCode, salt);
  const ciphered = aesEncryptCTR(pairingEphemeralPublicKey, key, randomIv);
  return Buffer.concat([salt, randomIv, ciphered]);
}

// ── Platform ID helper ──────────────────────────────────────────────

function getPlatformId(browser: string): string {
  const PlatformType = proto.DeviceProps?.PlatformType as Record<string, number> | undefined;
  const platformType = PlatformType?.[browser.toUpperCase()];
  return platformType !== undefined ? platformType.toString() : '1'; // CHROME default
}

// ── IQ builders ─────────────────────────────────────────────────────

export interface BuildPairDeviceIQOptions {
  phoneNumber: string;
  creds: Pick<AuthenticationCreds, 'noiseKey' | 'pairingEphemeralKeyPair' | 'pairingCode'>;
  browser: readonly [string, string, string];
}

/**
 * Build the `link_code_companion_reg` IQ stanza. The caller should encode
 * this via `encodeBinaryNode`, wrap it in a noise frame, and send it over
 * the transport.
 */
export async function buildPairDeviceIQ({
  phoneNumber,
  creds,
  browser,
}: BuildPairDeviceIQOptions): Promise<BinaryNode> {
  const jid = jidEncode(phoneNumber, 's.whatsapp.net');
  const pairingKey = await generatePairingKey(
    creds.pairingCode ?? '',
    creds.pairingEphemeralKeyPair.public,
  );

  return {
    tag: 'iq',
    attrs: {
      to: S_WHATSAPP_NET,
      type: 'set',
      id: generateRandomBytes(8).toString('hex').toUpperCase(),
      xmlns: 'md',
    },
    content: [
      {
        tag: 'link_code_companion_reg',
        attrs: {
          jid,
          stage: 'companion_hello',
          should_show_push_notification: 'true',
        },
        content: [
          {
            tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
            attrs: {},
            content: pairingKey,
          },
          {
            tag: 'companion_server_auth_key_pub',
            attrs: {},
            content: creds.noiseKey.public,
          },
          {
            tag: 'companion_platform_id',
            attrs: {},
            content: getPlatformId(browser[1]),
          },
          {
            tag: 'companion_platform_display',
            attrs: {},
            content: `${browser[1]} (${browser[0]})`,
          },
          {
            tag: 'link_code_pairing_nonce',
            attrs: {},
            content: '0',
          },
        ],
      },
    ],
  };
}

// ── Pair-success processing ─────────────────────────────────────────

export interface ProcessPairSuccessResult {
  /** Updated credential fields to merge into auth state. */
  creds: Partial<AuthenticationCreds> & {
    me: NonNullable<AuthenticationCreds['me']>;
    signalIdentities: NonNullable<AuthenticationCreds['signalIdentities']>;
  };
  /** The `pair-device-sign` reply IQ to send back to the server. */
  reply: BinaryNode;
}

/**
 * Process a `pair-success` stanza, verifying the server's HMAC and
 * the account signature chain. Returns the credential updates and the
 * reply IQ the caller must send back.
 */
export function processPairSuccess(
  stanza: BinaryNode,
  creds: Pick<AuthenticationCreds, 'advSecretKey' | 'signedIdentityKey' | 'signalIdentities'>,
): ProcessPairSuccessResult {
  const msgId = stanza.attrs.id;

  // Extract child nodes from the pair-success stanza
  const pairSuccessNode = findChild(stanza, 'pair-success');
  if (!pairSuccessNode) throw new Error('pair-success: missing pair-success child');

  const deviceIdentityNode = findChild(pairSuccessNode, 'device-identity');
  const platformNode = findChild(pairSuccessNode, 'platform');
  const deviceNode = findChild(pairSuccessNode, 'device');
  const businessNode = findChild(pairSuccessNode, 'biz');

  if (!deviceIdentityNode || !deviceNode) {
    throw new Error('pair-success: missing device-identity or device');
  }

  const bizName = businessNode?.attrs.name as string | undefined;
  const jid = deviceNode.attrs.jid as string;
  const lid = deviceNode.attrs.lid as string;

  // Decode the ADVSignedDeviceIdentityHMAC
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const ADVSignedDeviceIdentityHMAC = (proto as any).ADVSignedDeviceIdentityHMAC;
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const ADVEncryptionType = (proto as any).ADVEncryptionType;

  const identityContent = deviceIdentityNode.content as Uint8Array;
  const { details, hmac, accountType } = ADVSignedDeviceIdentityHMAC.decode(identityContent);

  let hmacPrefix = Buffer.from([]);
  if (accountType !== undefined && accountType === ADVEncryptionType?.HOSTED) {
    hmacPrefix = WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX;
  }

  const advSign = hmacSign(
    Buffer.concat([hmacPrefix, details as Uint8Array]),
    Buffer.from(creds.advSecretKey, 'base64'),
  );
  if (Buffer.compare(hmac as Buffer, advSign) !== 0) {
    throw new Error('pair-success: invalid account signature');
  }

  // Decode ADVSignedDeviceIdentity
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const ADVSignedDeviceIdentity = (proto as any).ADVSignedDeviceIdentity;
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const ADVDeviceIdentity = (proto as any).ADVDeviceIdentity;

  const account = ADVSignedDeviceIdentity.decode(details) as {
    accountSignatureKey: Uint8Array;
    accountSignature: Uint8Array;
    details: Uint8Array;
    deviceSignature?: Uint8Array;
  };
  const { accountSignatureKey, accountSignature, details: deviceDetails } = account;

  const deviceIdentity = ADVDeviceIdentity.decode(deviceDetails) as {
    deviceType?: number;
    keyIndex: number;
  };

  const sigPrefix =
    deviceIdentity.deviceType === ADVEncryptionType?.HOSTED
      ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
      : WA_ADV_ACCOUNT_SIG_PREFIX;

  const accountMsg = Buffer.concat([
    sigPrefix,
    deviceDetails as Uint8Array,
    Buffer.from(creds.signedIdentityKey.public),
  ]);

  const curve = _require('libsignal/src/curve.js') as {
    verifySignature(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): void;
  };
  try {
    curve.verifySignature(
      generateSignalPubKeyForVerify(accountSignatureKey),
      accountMsg,
      accountSignature,
    );
  } catch {
    throw new Error('pair-success: failed to verify account signature');
  }

  // Sign the device message with our identity key
  const deviceMsg = Buffer.concat([
    WA_ADV_DEVICE_SIG_PREFIX,
    deviceDetails as Uint8Array,
    Buffer.from(creds.signedIdentityKey.public),
    accountSignatureKey as Uint8Array,
  ]);

  const signCurve = _require('libsignal/src/curve.js') as {
    calculateSignature(priv: Uint8Array, msg: Uint8Array): Uint8Array;
  };
  account.deviceSignature = Buffer.from(
    signCurve.calculateSignature(creds.signedIdentityKey.private, deviceMsg),
  );

  // Build the signal identity
  const identity = createSignalIdentityField(lid, accountSignatureKey);

  // Encode the signed device identity for the reply
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const encodeSigned = (proto as any).ADVSignedDeviceIdentity.encode;
  // Omit accountSignatureKey if empty (matches Baileys)
  const accountEnc = encodeSigned({
    ...account,
    accountSignatureKey:
      !accountSignatureKey || (accountSignatureKey as Uint8Array).length === 0
        ? null
        : accountSignatureKey,
  }).finish();

  const reply: BinaryNode = {
    tag: 'iq',
    attrs: {
      to: S_WHATSAPP_NET,
      type: 'result',
      id: msgId,
    },
    content: [
      {
        tag: 'pair-device-sign',
        attrs: {},
        content: [
          {
            tag: 'device-identity',
            attrs: { 'key-index': deviceIdentity.keyIndex.toString() },
            content: accountEnc,
          },
        ],
      },
    ],
  };

  return {
    creds: {
      account: account as unknown as Record<string, unknown>,
      me: { id: jid, name: bizName, lid },
      signalIdentities: [...(creds.signalIdentities ?? []), identity],
      platform: platformNode?.attrs.name as string | undefined,
    },
    reply,
  };
}

// ── Internal helpers ────────────────────────────────────────────────

function findChild(node: BinaryNode, tag: string): BinaryNode | undefined {
  if (!Array.isArray(node.content)) return undefined;
  return (node.content as BinaryNode[]).find(
    (child) => typeof child !== 'string' && !Buffer.isBuffer(child) && child.tag === tag,
  );
}

const KEY_BUNDLE_TYPE = Buffer.from([5]);

function generateSignalPubKeyForVerify(pubKey: Buffer | Uint8Array): Buffer {
  const buf = Buffer.from(pubKey);
  return buf.length === 33 ? buf : Buffer.concat([KEY_BUNDLE_TYPE, buf]);
}

function createSignalIdentityField(
  wid: string,
  accountSignatureKey: Uint8Array,
): NonNullable<AuthenticationCreds['signalIdentities']>[number] {
  return {
    identifier: { name: wid, deviceId: 0 },
    identifierKey: generateSignalPubKeyForVerify(accountSignatureKey),
  };
}
