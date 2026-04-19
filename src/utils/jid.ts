import { WAJIDDomains } from '../types/jid.js';
import type { FullJid, JidString } from '../types/jid.js';

/**
 * Map a WAJIDDomains enum value to the corresponding server string.
 */
export function getServerFromDomainType(
  initialServer: string,
  domainType?: number,
): string {
  switch (domainType) {
    case WAJIDDomains.LID:
      return 'lid';
    case WAJIDDomains.HOSTED:
      return 'hosted';
    case WAJIDDomains.HOSTED_LID:
      return 'hosted.lid';
    case WAJIDDomains.WHATSAPP:
    default:
      return initialServer;
  }
}

/**
 * Encode a JID from components.
 *
 * Format: `{user}[_{agent}][:{device}]@{server}`
 *
 * @example
 * jidEncode('923124166950', 's.whatsapp.net') // '923124166950@s.whatsapp.net'
 * jidEncode('923124166950', 's.whatsapp.net', 1) // '923124166950:1@s.whatsapp.net'
 */
export function jidEncode(
  user: string | null | undefined,
  server: string,
  device?: number,
  agent?: number,
): JidString {
  return `${user || ''}${agent ? `_${agent}` : ''}${device ? `:${device}` : ''}@${server}`;
}

/**
 * Decode a JID string into components.
 *
 * @example
 * jidDecode('923124166950@s.whatsapp.net')
 * // { user: '923124166950', server: 's.whatsapp.net', domainType: 0 }
 */
export function jidDecode(jid: string | undefined | null): FullJid | undefined {
  const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1;
  if (sepIdx < 0) return undefined;

  const server = jid!.slice(sepIdx + 1);
  const userCombined = jid!.slice(0, sepIdx);

  const [userAgent, device] = userCombined.split(':');
  const [user, agent] = userAgent.split('_');

  let domainType: number = WAJIDDomains.WHATSAPP;
  if (server === 'lid') {
    domainType = WAJIDDomains.LID;
  } else if (server === 'hosted') {
    domainType = WAJIDDomains.HOSTED;
  } else if (server === 'hosted.lid') {
    domainType = WAJIDDomains.HOSTED_LID;
  } else if (agent) {
    domainType = Number.parseInt(agent, 10);
  }

  return {
    server,
    user,
    domainType,
    device: device ? +device : undefined,
  };
}

/** Get the normalized user portion of a JID (without device or server) */
export function jidNormalizedUser(jid: JidString): JidString {
  const decoded = jidDecode(jid);
  if (!decoded) return '';
  const { user, server } = decoded;
  return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server);
}

/** Check if two JIDs refer to the same user (ignoring device) */
export function areJidsSameUser(
  jid1: JidString | undefined | null,
  jid2: JidString | undefined | null,
): boolean {
  return jidDecode(jid1)?.user === jidDecode(jid2)?.user;
}

/** Check if a JID is Meta AI */
export function isJidMetaAI(jid: string | undefined | null): boolean {
  return jid?.endsWith('@bot') ?? false;
}

/** Check if a JID is a PN user (@s.whatsapp.net) */
export function isPnUser(jid: string | undefined | null): boolean {
  return jid?.endsWith('@s.whatsapp.net') ?? false;
}

/** Check if a JID uses LID format (linked identity) */
export function isLidUser(jid: string | undefined | null): boolean {
  return jid?.endsWith('@lid') ?? false;
}

/** Check if a JID is a broadcast */
export function isJidBroadcast(jid: string | undefined | null): boolean {
  return jid?.endsWith('@broadcast') ?? false;
}

/** Check if a JID belongs to a group */
export function isJidGroup(jid: string | undefined | null): boolean {
  return jid?.endsWith('@g.us') ?? false;
}

/** Check if a JID is the status broadcast */
export function isJidStatusBroadcast(jid: string | undefined | null): boolean {
  return jid === 'status@broadcast';
}

/** Check if a JID is a newsletter */
export function isJidNewsletter(jid: string | undefined | null): boolean {
  return jid?.endsWith('@newsletter') ?? false;
}

/** Check if a JID is a hosted PN */
export function isHostedPnUser(jid: string | undefined | null): boolean {
  return jid?.endsWith('@hosted') ?? false;
}

/** Check if a JID is a hosted LID */
export function isHostedLidUser(jid: string | undefined | null): boolean {
  return jid?.endsWith('@hosted.lid') ?? false;
}

const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/;

/** Check if a JID is a bot (Meta AI) */
export function isJidBot(jid: string | undefined | null): boolean {
  return !!jid && botRegexp.test(jid.split('@')[0]) && jid.endsWith('@c.us');
}

/** Check if a JID is a regular user */
export function isJidUser(jid: string | undefined | null): boolean {
  return isPnUser(jid) || (jid?.endsWith('@c.us') ?? false);
}

/** Transfer the device ID from one JID to another */
export function transferDevice(fromJid: JidString, toJid: JidString): JidString {
  const fromDecoded = jidDecode(fromJid);
  const deviceId = fromDecoded?.device || 0;
  const toDecoded = jidDecode(toJid);
  if (!toDecoded) return toJid;
  return jidEncode(toDecoded.user, toDecoded.server, deviceId);
}

/** Extract the phone number from a JID */
export function phoneFromJid(jid: JidString): string | undefined {
  const decoded = jidDecode(jid);
  if (!decoded) return undefined;
  if (decoded.server === 's.whatsapp.net' || decoded.server === 'c.us') {
    return decoded.user;
  }
  return undefined;
}
