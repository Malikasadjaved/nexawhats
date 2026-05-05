/**
 * ClientPayload builders — ports Baileys' `Utils/validate-connection.js`
 * `generateLoginNode` and `generateRegistrationNode`. These are the two
 * payloads the Noise handshake wraps inside ClientFinish: login for a
 * returning device (creds.me set) and registration for first-pair.
 */
import { createHash } from 'node:crypto';
import { jidDecode } from '../binary/jid.js';
import type { AuthenticationCreds } from '../types/auth.js';
import { KEY_BUNDLE_TYPE } from '../utils/crypto.js';
import { proto } from './index.js';

/** Config subset needed to build a ClientPayload. Keeps the builders pure. */
export interface PayloadConfig {
  /** WhatsApp Web app version, e.g. [2, 3000, 1027934701]. */
  version: readonly [number, number, number];
  /** Browser triple, e.g. ['Ubuntu', 'Chrome', '22.04.4']. */
  browser: readonly [string, string, string];
  /** ISO-3166 alpha-2 country code. Baileys defaults to 'US'. */
  countryCode: string;
  /** Whether to pull the full history on first connect. Affects webSubPlatform. */
  syncFullHistory?: boolean;
}

/** Default browser — matches Baileys' `Browsers.ubuntu('Chrome')`. */
export const DEFAULT_BROWSER = ['Ubuntu', 'Chrome', '22.04.4'] as const;

/** Pinned WA Web version — matches the Baileys at D:/Digital Fte/body/my-bot/… */
export const DEFAULT_VERSION = [2, 3000, 1027934701] as const;

const PLATFORM_MAP: Record<string, number> = {
  // proto.ClientPayload.WebInfo.WebSubPlatform.{DARWIN,WIN32}
  // Numeric ids from WAProto; resolved lazily because proto is a proxy.
};

function getUserAgent(config: PayloadConfig): unknown {
  return {
    appVersion: {
      primary: config.version[0],
      secondary: config.version[1],
      tertiary: config.version[2],
    },
    platform: proto.ClientPayload.UserAgent.Platform.WEB,
    releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
    osVersion: '0.1',
    device: 'Desktop',
    osBuildNumber: '0.1',
    localeLanguageIso6391: 'en',
    mnc: '000',
    mcc: '000',
    localeCountryIso31661Alpha2: config.countryCode,
  };
}

function getWebInfo(config: PayloadConfig): unknown {
  let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER;
  if (config.syncFullHistory && config.browser[1] === 'Desktop') {
    // Resolve numeric ids lazily via the proxy.
    PLATFORM_MAP['Mac OS'] ??= proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN;
    PLATFORM_MAP.Windows ??= proto.ClientPayload.WebInfo.WebSubPlatform.WIN32;
    const mapped = PLATFORM_MAP[config.browser[0]];
    if (mapped !== undefined) webSubPlatform = mapped;
  }
  return { webSubPlatform };
}

function getClientPayload(config: PayloadConfig): Record<string, unknown> {
  return {
    connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
    connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
    userAgent: getUserAgent(config),
    webInfo: getWebInfo(config),
  };
}

/** Big-endian encode an integer into exactly `length` bytes (default 4). */
export function encodeBigEndian(value: number, length = 4): Buffer {
  const out = Buffer.alloc(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v >>>= 8;
  }
  return out;
}

function getPlatformType(platform: string): number {
  const key = platform.toUpperCase();
  return proto.DeviceProps.PlatformType[key] ?? proto.DeviceProps.PlatformType.CHROME;
}

/**
 * Build the ClientPayload sent during ClientFinish for a returning
 * device. The `userJid` is read from `creds.me.id` — callers must
 * guard against `creds.me` being undefined (that's the registration
 * path).
 */
export function generateLoginNode(userJid: string, config: PayloadConfig): unknown {
  const decoded = jidDecode(userJid);
  if (!decoded) throw new Error(`generateLoginNode: could not decode jid ${userJid}`);
  const { user, device } = decoded;
  const payload = {
    ...getClientPayload(config),
    passive: true,
    pull: true,
    username: Number(user),
    device,
    lidDbMigrated: false,
  };
  return proto.ClientPayload.fromObject(payload);
}

/**
 * Build the ClientPayload sent during ClientFinish for a fresh-pair
 * device. Packs the registration id, identity key, and signed pre-key
 * into `devicePairingData` so the server can set up a new Signal
 * identity during the subsequent `pair-success` IQ.
 */
export function generateRegistrationNode(
  creds: Pick<AuthenticationCreds, 'registrationId' | 'signedPreKey' | 'signedIdentityKey'>,
  config: PayloadConfig,
): unknown {
  // App version needs to be MD5-hashed and passed in buildHash.
  const appVersionBuf = createHash('md5').update(config.version.join('.')).digest();
  const companion = {
    os: config.browser[0],
    platformType: getPlatformType(config.browser[1]),
    requireFullSync: config.syncFullHistory ?? false,
    historySyncConfig: {
      storageQuotaMb: 10240,
      inlineInitialPayloadInE2EeMsg: true,
      recentSyncDaysLimit: undefined,
      supportCallLogHistory: false,
      supportBotUserAgentChatHistory: true,
      supportCagReactionsAndPolls: true,
      supportBizHostedMsg: true,
      supportRecentSyncChunkMessageCountTuning: true,
      supportHostedGroupMsg: true,
      supportFbidBotChatHistory: true,
      supportAddOnHistorySyncMigration: undefined,
      supportMessageAssociation: true,
      supportGroupHistory: false,
      onDemandReady: undefined,
      supportGuestChat: undefined,
    },
    version: { primary: 10, secondary: 15, tertiary: 7 },
  };
  const companionProto = proto.DeviceProps.encode(companion).finish();
  const registerPayload = {
    ...getClientPayload(config),
    passive: false,
    pull: false,
    devicePairingData: {
      buildHash: appVersionBuf,
      deviceProps: companionProto,
      eRegid: encodeBigEndian(creds.registrationId),
      eKeytype: KEY_BUNDLE_TYPE,
      eIdent: creds.signedIdentityKey.public,
      eSkeyId: encodeBigEndian(creds.signedPreKey.keyId, 3),
      eSkeyVal: creds.signedPreKey.keyPair.public,
      eSkeySig: creds.signedPreKey.signature,
    },
  };
  return proto.ClientPayload.fromObject(registerPayload);
}
