import type { FullJid, JidServer, JidString } from '../types/jid.js';

/**
 * Encode a JID from components.
 *
 * @example
 * jidEncode('923124166950', 's.whatsapp.net') // '923124166950@s.whatsapp.net'
 * jidEncode('923124166950', 's.whatsapp.net', 1) // '923124166950:1@s.whatsapp.net'
 */
export function jidEncode(
  user: string | null | undefined,
  server: JidServer,
  device?: number,
): JidString {
  const u = user ?? '';
  const d = device !== undefined && device !== 0 ? `:${device}` : '';
  return `${u}${d}@${server}`;
}

/**
 * Decode a JID string into components.
 *
 * @example
 * jidDecode('923124166950@s.whatsapp.net')
 * // { user: '923124166950', server: 's.whatsapp.net' }
 */
export function jidDecode(jid: JidString): FullJid | undefined {
  const atIndex = jid.indexOf('@');
  if (atIndex < 0) return undefined;

  const server = jid.slice(atIndex + 1) as JidServer;
  const userPart = jid.slice(0, atIndex);

  const colonIndex = userPart.indexOf(':');
  if (colonIndex >= 0) {
    return {
      user: userPart.slice(0, colonIndex),
      device: Number.parseInt(userPart.slice(colonIndex + 1), 10),
      server,
    };
  }

  return { user: userPart, server };
}

/** Get the normalized user portion of a JID (without device or server) */
export function jidNormalizedUser(jid: JidString): JidString {
  const decoded = jidDecode(jid);
  if (!decoded) return jid;
  return jidEncode(decoded.user, decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server);
}

/** Check if a JID belongs to a group */
export function isJidGroup(jid: JidString): boolean {
  return jid.endsWith('@g.us');
}

/** Check if a JID is a broadcast */
export function isJidBroadcast(jid: JidString): boolean {
  return jid === 'status@broadcast' || jid.endsWith('@broadcast');
}

/** Check if a JID is a newsletter */
export function isJidNewsletter(jid: JidString): boolean {
  return jid.endsWith('@newsletter');
}

/** Check if a JID uses LID format (linked identity) */
export function isLidUser(jid: JidString): boolean {
  return jid.endsWith('@lid');
}

/** Check if a JID is a regular user */
export function isJidUser(jid: JidString): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us');
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

/** Check if two JIDs refer to the same user (ignoring device) */
export function areJidsSameUser(jid1: JidString, jid2: JidString): boolean {
  return jidNormalizedUser(jid1) === jidNormalizedUser(jid2);
}
