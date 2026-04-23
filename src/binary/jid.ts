/**
 * JID (Jabber ID) utilities for WhatsApp addressing.
 *
 * Ported from Baileys' WABinary/jid-utils.js — the wire format is
 * authoritative and we cannot deviate from it. Keep this port faithful
 * to the reference source.
 */

export const S_WHATSAPP_NET = '@s.whatsapp.net';
export const OFFICIAL_BIZ_JID = '16505361212@c.us';
export const SERVER_JID = 'server@c.us';
export const PSA_WID = '0@c.us';
export const STORIES_JID = 'status@broadcast';
export const META_AI_JID = '13135550002@c.us';

/**
 * WhatsApp JID domain types. Numeric values are part of the wire protocol
 * (they are encoded into the "agent" field of compound JIDs), so the
 * specific integer constants MUST match Baileys exactly.
 */
export enum WAJIDDomains {
  WHATSAPP = 0,
  LID = 1,
  HOSTED = 128,
  HOSTED_LID = 129,
}

export const getServerFromDomainType = (
  initialServer: string,
  domainType: WAJIDDomains,
): string => {
  switch (domainType) {
    case WAJIDDomains.LID:
      return 'lid';
    case WAJIDDomains.HOSTED:
      return 'hosted';
    case WAJIDDomains.HOSTED_LID:
      return 'hosted.lid';
    default:
      return initialServer;
  }
};

export const jidEncode = (
  user: string | number | undefined | null,
  server: string,
  device?: number,
  agent?: number,
): string => {
  const userPart = user != null ? String(user) : '';
  const agentPart = agent ? `_${agent}` : '';
  const devicePart = device ? `:${device}` : '';
  return `${userPart}${agentPart}${devicePart}@${server}`;
};

export interface JidDecoded {
  server: string;
  user: string;
  domainType: WAJIDDomains | number;
  device: number | undefined;
}

export const jidDecode = (jid: string | undefined | null): JidDecoded | undefined => {
  // todo: investigate how to implement hosted ids in this case
  const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1;
  if (sepIdx < 0 || jid == null) {
    return undefined;
  }
  const server = jid.slice(sepIdx + 1);
  const userCombined = jid.slice(0, sepIdx);
  const [userAgent, device] = userCombined.split(':');
  const [user, agent] = (userAgent ?? '').split('_');
  let domainType: WAJIDDomains | number = WAJIDDomains.WHATSAPP;
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
    user: user ?? '',
    domainType,
    device: device ? +device : undefined,
  };
};

/** Is the JID the same user (ignoring device)? */
export const areJidsSameUser = (jid1: string, jid2: string): boolean =>
  jidDecode(jid1)?.user === jidDecode(jid2)?.user;

/** Meta AI bot JID test */
export const isJidMetaAI = (jid: string | undefined): boolean => !!jid?.endsWith('@bot');

/** Phone-number user (PN = @s.whatsapp.net) */
export const isPnUser = (jid: string | undefined): boolean => !!jid?.endsWith('@s.whatsapp.net');

/** LID user (WhatsApp Linked Identity) */
export const isLidUser = (jid: string | undefined): boolean => !!jid?.endsWith('@lid');

/** Broadcast list */
export const isJidBroadcast = (jid: string | undefined): boolean => !!jid?.endsWith('@broadcast');

/** Group chat JID */
export const isJidGroup = (jid: string | undefined): boolean => !!jid?.endsWith('@g.us');

/** The special status broadcast JID */
export const isJidStatusBroadcast = (jid: string | undefined): boolean =>
  jid === 'status@broadcast';

/** Newsletter / channel JID */
export const isJidNewsletter = (jid: string | undefined): boolean => !!jid?.endsWith('@newsletter');

/** Hosted phone-number user */
export const isHostedPnUser = (jid: string | undefined): boolean => !!jid?.endsWith('@hosted');

/** Hosted LID user */
export const isHostedLidUser = (jid: string | undefined): boolean => !!jid?.endsWith('@hosted.lid');

const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/;

/** Known WhatsApp bot JID */
export const isJidBot = (jid: string | undefined): boolean =>
  !!(jid && botRegexp.test(jid.split('@')[0] ?? '') && jid.endsWith('@c.us'));

/** Normalize a JID to its canonical @s.whatsapp.net form if it was @c.us. */
export const jidNormalizedUser = (jid: string): string => {
  const result = jidDecode(jid);
  if (!result) {
    return '';
  }
  const { user, server } = result;
  return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server);
};

/** Copy device id from fromJid onto toJid (keeping toJid's user/server). */
export const transferDevice = (fromJid: string, toJid: string): string => {
  const fromDecoded = jidDecode(fromJid);
  const deviceId = fromDecoded?.device || 0;
  const toDecoded = jidDecode(toJid);
  if (!toDecoded) {
    return toJid;
  }
  const { server, user } = toDecoded;
  return jidEncode(user, server, deviceId);
};
