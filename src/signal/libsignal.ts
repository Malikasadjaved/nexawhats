/**
 * Signal repository — the orchestrator that wires our `AuthStore` into
 * the libsignal-node `SessionCipher` / `SessionBuilder` primitives and
 * the in-tree Group cipher.
 *
 * Ported from Baileys' `Signal/libsignal.js`. This is the surface the
 * rest of the client talks to: whole-message encrypt/decrypt for 1:1,
 * sender-key distribution + group encrypt/decrypt, E2E session injection,
 * and bulk PN→LID session migration.
 *
 * Differences from the Baileys reference:
 * - `SignalKeyStore` has no `transaction()`. Baileys wraps every mutation
 *   in `keys.transaction(work, key)` for batching + retry; we call
 *   `work()` directly and rely on SQLite WAL for atomicity — same
 *   approach already established in `lid-mapping.ts`.
 * - Everything else is a faithful line-by-line port.
 */
import libsignal from 'libsignal';
import { LRUCache } from 'lru-cache';
import type { Logger } from 'pino';
import {
  WAJIDDomains,
  isHostedLidUser,
  isHostedPnUser,
  isLidUser,
  isPnUser,
  jidDecode,
  transferDevice,
} from '../binary/jid.js';
import type { AuthenticationState, SignalKeyStore } from '../types/auth.js';
import { generateSignalPubKey } from '../utils/crypto.js';
import {
  GroupCipher,
  GroupSessionBuilder,
  SenderKeyDistributionMessage,
  SenderKeyName,
  SenderKeyRecord,
} from './group/index.js';
import { LIDMappingStore, type PnToLidFunc } from './lid-mapping.js';

export interface SignalSessionCiphertext {
  type: 'pkmsg' | 'msg';
  ciphertext: Buffer;
}

export interface E2ESession {
  registrationId: number;
  identityKey: Uint8Array;
  signedPreKey: {
    keyId: number;
    publicKey: Uint8Array;
    signature: Uint8Array;
  };
  preKey: {
    keyId: number;
    publicKey: Uint8Array;
  };
}

export interface SenderKeyDistributionItem {
  groupId?: string | null;
  axolotlSenderKeyDistributionMessage: Buffer | Uint8Array;
}

export interface SessionValidationResult {
  exists: boolean;
  reason?: string;
}

export interface SessionMigrationResult {
  migrated: number;
  skipped: number;
  total: number;
}

export interface SignalRepository {
  decryptGroupMessage(args: { group: string; authorJid: string; msg: Buffer }): Promise<Buffer>;
  processSenderKeyDistributionMessage(args: {
    item: SenderKeyDistributionItem;
    authorJid: string;
  }): Promise<void>;
  decryptMessage(args: {
    jid: string;
    type: 'pkmsg' | 'msg';
    ciphertext: Buffer | Uint8Array;
  }): Promise<Buffer>;
  encryptMessage(args: {
    jid: string;
    data: Buffer | Uint8Array;
  }): Promise<SignalSessionCiphertext>;
  encryptGroupMessage(args: {
    group: string;
    meId: string;
    data: Buffer | Uint8Array;
  }): Promise<{ ciphertext: Buffer; senderKeyDistributionMessage: Buffer }>;
  injectE2ESession(args: { jid: string; session: E2ESession }): Promise<void>;
  jidToSignalProtocolAddress(jid: string): string;
  lidMapping: LIDMappingStore;
  validateSession(jid: string): Promise<SessionValidationResult>;
  deleteSession(jids: string[]): Promise<void>;
  migrateSession(fromJid: string, toJid: string): Promise<SessionMigrationResult>;
}

const MIGRATED_SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function makeLibSignalRepository(
  auth: AuthenticationState,
  logger: Logger,
  pnToLIDFunc?: PnToLidFunc,
): SignalRepository {
  const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc);
  const storage = signalStorage(auth, lidMapping);
  const parsedKeys = auth.keys;
  const migratedSessionCache = new LRUCache<string, boolean>({
    ttl: MIGRATED_SESSION_TTL_MS,
    ttlAutopurge: true,
    updateAgeOnGet: true,
  });

  const repository: SignalRepository = {
    async decryptGroupMessage({ group, authorJid, msg }) {
      const senderName = jidToSignalSenderKeyName(group, authorJid);
      const cipher = new GroupCipher(storage, senderName);
      return cipher.decrypt(msg);
    },

    async processSenderKeyDistributionMessage({ item, authorJid }) {
      const builder = new GroupSessionBuilder(storage);
      if (!item.groupId) {
        throw new Error('Group ID is required for sender key distribution message');
      }
      const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
      const senderMsg = new SenderKeyDistributionMessage(
        null,
        null,
        null,
        null,
        Buffer.from(item.axolotlSenderKeyDistributionMessage),
      );
      const senderNameStr = senderName.toString();
      const existing = await auth.keys.get('sender-key', [senderNameStr]);
      if (!existing[senderNameStr]) {
        await storage.storeSenderKey(senderName, new SenderKeyRecord());
      }
      await builder.process(senderName, senderMsg);
    },

    async decryptMessage({ jid, type, ciphertext }) {
      const addr = jidToSignalProtocolAddress(jid);
      const session = new libsignal.SessionCipher(storage, addr);
      const bytes = Buffer.from(ciphertext);
      switch (type) {
        case 'pkmsg':
          return session.decryptPreKeyWhisperMessage(bytes);
        case 'msg':
          return session.decryptWhisperMessage(bytes);
        default:
          throw new Error(`Unknown message type: ${type}`);
      }
    },

    async encryptMessage({ jid, data }) {
      const addr = jidToSignalProtocolAddress(jid);
      const cipher = new libsignal.SessionCipher(storage, addr);
      const { type: sigType, body } = await cipher.encrypt(Buffer.from(data));
      const type: 'pkmsg' | 'msg' = sigType === 3 ? 'pkmsg' : 'msg';
      return { type, ciphertext: Buffer.from(body, 'binary') };
    },

    async encryptGroupMessage({ group, meId, data }) {
      const senderName = jidToSignalSenderKeyName(group, meId);
      const builder = new GroupSessionBuilder(storage);
      const senderNameStr = senderName.toString();
      const existing = await auth.keys.get('sender-key', [senderNameStr]);
      if (!existing[senderNameStr]) {
        await storage.storeSenderKey(senderName, new SenderKeyRecord());
      }
      const senderKeyDistributionMessage = await builder.create(senderName);
      const session = new GroupCipher(storage, senderName);
      const ciphertext = await session.encrypt(Buffer.from(data));
      return {
        ciphertext,
        senderKeyDistributionMessage: senderKeyDistributionMessage.serialize(),
      };
    },

    async injectE2ESession({ jid, session }) {
      logger.trace({ jid }, 'injecting E2EE session');
      const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid));
      await cipher.initOutgoing(session);
    },

    jidToSignalProtocolAddress(jid) {
      return jidToSignalProtocolAddress(jid).toString();
    },

    lidMapping,

    async validateSession(jid) {
      try {
        const addr = jidToSignalProtocolAddress(jid);
        const session = await storage.loadSession(addr.toString());
        if (!session) {
          return { exists: false, reason: 'no session' };
        }
        if (!session.haveOpenSession()) {
          return { exists: false, reason: 'no open session' };
        }
        return { exists: true };
      } catch {
        return { exists: false, reason: 'validation error' };
      }
    },

    async deleteSession(jids) {
      if (!jids.length) return;
      const sessionUpdates: Record<string, null> = {};
      for (const jid of jids) {
        const addr = jidToSignalProtocolAddress(jid);
        sessionUpdates[addr.toString()] = null;
      }
      await auth.keys.set({ session: sessionUpdates });
    },

    async migrateSession(fromJid, toJid) {
      // TODO: use usync to handle this entire mess
      if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) {
        return { migrated: 0, skipped: 0, total: 0 };
      }
      if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) {
        return { migrated: 0, skipped: 0, total: 1 };
      }
      const fromDecoded = jidDecode(fromJid);
      if (!fromDecoded) {
        return { migrated: 0, skipped: 0, total: 0 };
      }
      const { user } = fromDecoded;
      logger.debug({ fromJid }, 'bulk device migration - loading all user devices');

      const deviceLookup = await parsedKeys.get('device-list', [user]);
      const userDevices = deviceLookup[user];
      if (!userDevices) {
        return { migrated: 0, skipped: 0, total: 0 };
      }
      const fromDeviceStr = fromDecoded.device?.toString() ?? '0';
      if (!userDevices.includes(fromDeviceStr)) {
        userDevices.push(fromDeviceStr);
      }

      const uncachedDevices = userDevices.filter((device) => {
        const deviceKey = `${user}.${device}`;
        return !migratedSessionCache.has(deviceKey);
      });

      const deviceSessionKeys = uncachedDevices.map((device) => `${user}.${device}`);
      const existingSessions = await parsedKeys.get('session', deviceSessionKeys);

      const deviceJids: string[] = [];
      for (const [sessionKey, sessionData] of Object.entries(existingSessions)) {
        if (!sessionData) continue;
        const deviceStr = sessionKey.split('.')[1];
        if (!deviceStr) continue;
        const deviceNum = Number.parseInt(deviceStr, 10);
        let jid =
          deviceNum === 0 ? `${user}@s.whatsapp.net` : `${user}:${deviceNum}@s.whatsapp.net`;
        if (deviceNum === 99) {
          jid = `${user}:99@hosted`;
        }
        deviceJids.push(jid);
      }

      logger.debug(
        {
          fromJid,
          totalDevices: userDevices.length,
          devicesWithSessions: deviceJids.length,
          devices: deviceJids,
        },
        'bulk device migration complete - all user devices processed',
      );

      const migrationOps = deviceJids.map((jid) => {
        const lidWithDevice = transferDevice(jid, toJid);
        const fromDec = jidDecode(jid);
        const toDec = jidDecode(lidWithDevice);
        return {
          fromJid: jid,
          toJid: lidWithDevice,
          pnUser: fromDec?.user ?? '',
          lidUser: toDec?.user ?? '',
          deviceId: fromDec?.device ?? 0,
          fromAddr: jidToSignalProtocolAddress(jid),
          toAddr: jidToSignalProtocolAddress(lidWithDevice),
        };
      });
      const totalOps = migrationOps.length;
      let migratedCount = 0;

      const pnAddrStrings = Array.from(new Set(migrationOps.map((op) => op.fromAddr.toString())));
      const pnSessions = await parsedKeys.get('session', pnAddrStrings);

      const sessionUpdates: Record<string, Uint8Array | null> = {};
      for (const op of migrationOps) {
        const pnAddrStr = op.fromAddr.toString();
        const lidAddrStr = op.toAddr.toString();
        const pnSession = pnSessions[pnAddrStr];
        if (pnSession) {
          const fromSession = libsignal.SessionRecord.deserialize(pnSession);
          if (fromSession.haveOpenSession()) {
            sessionUpdates[lidAddrStr] = fromSession.serialize();
            sessionUpdates[pnAddrStr] = null;
            migratedCount++;
          }
        }
      }

      if (Object.keys(sessionUpdates).length > 0) {
        await parsedKeys.set({ session: sessionUpdates });
        logger.debug({ migratedSessions: migratedCount }, 'bulk session migration complete');
        for (const op of migrationOps) {
          if (sessionUpdates[op.toAddr.toString()]) {
            const deviceKey = `${op.pnUser}.${op.deviceId}`;
            migratedSessionCache.set(deviceKey, true);
          }
        }
      }

      const skippedCount = totalOps - migratedCount;
      return { migrated: migratedCount, skipped: skippedCount, total: totalOps };
    },
  };

  return repository;
}

/**
 * Convert a JID to the `ProtocolAddress` libsignal uses internally.
 *
 * Non-WhatsApp domains get a `_<domainType>` suffix on the user part so
 * the same numeric id across LID / hosted namespaces never collides in
 * session storage. Devices default to 0. Device 99 is reserved for
 * hosted JIDs — we refuse anything else with device 99 as invalid.
 */
export function jidToSignalProtocolAddress(jid: string): libsignal.ProtocolAddress {
  const decoded = jidDecode(jid);
  if (!decoded) {
    throw new Error(`Could not decode JID: "${jid}"`);
  }
  const { user, device, server, domainType } = decoded;
  if (!user) {
    throw new Error(
      `JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`,
    );
  }
  const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
  const finalDevice = device ?? 0;
  if (device === 99 && server !== 'hosted' && server !== 'hosted.lid') {
    throw new Error(
      `Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:${jid}`,
    );
  }
  return new libsignal.ProtocolAddress(signalUser, finalDevice);
}

function jidToSignalSenderKeyName(group: string, user: string): SenderKeyName {
  const addr = jidToSignalProtocolAddress(user);
  return new SenderKeyName(group, {
    id: addr.id,
    deviceId: addr.deviceId,
    toString: () => addr.toString(),
  });
}

/**
 * Wrap our `SignalKeyStore` + `AuthenticationCreds` in the shape
 * libsignal-node expects (`SignalStorage`). Session IDs arriving via
 * `loadSession` / `storeSession` may still carry a PN signal address;
 * we resolve to the LID equivalent when a mapping exists so all
 * subsequent reads/writes target the canonical identity.
 */
function signalStorage({ creds, keys }: AuthenticationState, lidMapping: LIDMappingStore) {
  const resolveLIDSignalAddress = async (id: string): Promise<string> => {
    if (!id.includes('.')) return id;
    const [deviceId, device] = id.split('.');
    const [user, domainTypeStr] = (deviceId ?? '').split('_');
    const domainType = Number.parseInt(domainTypeStr ?? '0', 10);
    if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) {
      return id;
    }
    const serverPart = domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net';
    const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${serverPart}`;
    const lidForPN = await lidMapping.getLIDForPN(pnJid);
    if (lidForPN) {
      const lidAddr = jidToSignalProtocolAddress(lidForPN);
      return lidAddr.toString();
    }
    return id;
  };

  return {
    loadSession: async (id: string) => {
      try {
        const wireJid = await resolveLIDSignalAddress(id);
        const stored = await keys.get('session', [wireJid]);
        const sess = stored[wireJid];
        if (sess) {
          return libsignal.SessionRecord.deserialize(sess);
        }
      } catch {
        return null;
      }
      return null;
    },
    storeSession: async (id: string, session: libsignal.SessionRecord) => {
      const wireJid = await resolveLIDSignalAddress(id);
      await keys.set({ session: { [wireJid]: session.serialize() } });
    },
    isTrustedIdentity: () => true, // todo: implement
    loadPreKey: async (id: number | string) => {
      const keyId = id.toString();
      const stored = await keys.get('pre-key', [keyId]);
      const key = stored[keyId];
      if (key) {
        return {
          privKey: Buffer.from(key.private),
          pubKey: Buffer.from(key.public),
        };
      }
      return undefined;
    },
    removePreKey: (id: number) => keys.set({ 'pre-key': { [id.toString()]: null } }),
    loadSignedPreKey: () => {
      const key = creds.signedPreKey;
      return {
        privKey: Buffer.from(key.keyPair.private),
        pubKey: Buffer.from(key.keyPair.public),
      };
    },
    loadSenderKey: async (senderKeyName: SenderKeyName) => {
      const keyId = senderKeyName.toString();
      const stored = await (keys as SignalKeyStore).get('sender-key', [keyId]);
      const key = stored[keyId];
      if (key) {
        return SenderKeyRecord.deserialize(key);
      }
      return new SenderKeyRecord();
    },
    storeSenderKey: async (senderKeyName: SenderKeyName, record: SenderKeyRecord) => {
      const keyId = senderKeyName.toString();
      const serialized = JSON.stringify(record.serialize());
      await (keys as SignalKeyStore).set({
        'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') },
      });
    },
    getOurRegistrationId: () => creds.registrationId,
    getOurIdentity: () => {
      const { signedIdentityKey } = creds;
      return {
        privKey: Buffer.from(signedIdentityKey.private),
        pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public)),
      };
    },
  };
}
