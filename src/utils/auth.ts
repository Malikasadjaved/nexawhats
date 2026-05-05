import { randomBytes } from 'node:crypto';
import type { AuthenticationCreds } from '../types/auth.js';
import { Curve, generateRegistrationId, signedKeyPair } from './crypto.js';

/**
 * Generate a fresh set of authentication credentials for a new device.
 *
 * Port of Baileys' `initAuthCreds()` from `Utils/auth-utils.js`. Produces
 * the minimum state needed to drive the Noise handshake and companion
 * pairing for a first-time connection. After a successful `pair-success`
 * the server-provided `me`, `account`, `signalIdentities`, and `platform`
 * fields are merged in (see `src/socket/pairing.ts`).
 */
export function initAuthCreds(): AuthenticationCreds {
  const identityKey = Curve.generateKeyPair();
  return {
    noiseKey: Curve.generateKeyPair(),
    pairingEphemeralKeyPair: Curve.generateKeyPair(),
    signedIdentityKey: identityKey,
    signedPreKey: signedKeyPair(identityKey, 1),
    registrationId: generateRegistrationId(),
    advSecretKey: randomBytes(32).toString('base64'),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false,
    pairingCode: undefined,
    lastPropHash: undefined,
    routingInfo: undefined,
  };
}
