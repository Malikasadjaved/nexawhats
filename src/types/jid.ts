/** JID server types used by WhatsApp */
export type JidServer =
  | 's.whatsapp.net'
  | 'g.us'
  | 'c.us'
  | 'broadcast'
  | 'lid'
  | 'hosted'
  | 'hosted.lid'
  | 'newsletter'
  | 'msgr'
  | 'bot';

/** WhatsApp JID domain types (numeric enum matching Baileys wire format) */
export enum WAJIDDomains {
  WHATSAPP = 0,
  LID = 1,
  HOSTED = 128,
  HOSTED_LID = 129,
}

/** Fully parsed JID */
export interface FullJid {
  user: string;
  device?: number;
  server: string;
  domainType?: number;
}

/** JID string — e.g. "923124166950@s.whatsapp.net" or "197151900590225@lid" */
export type JidString = string;

/** LID-to-phone mapping entry */
export interface LidMapping {
  lid: string;
  phone: string;
  updatedAt: number;
}

/** Well-known JID constants */
export const S_WHATSAPP_NET = '@s.whatsapp.net';
export const OFFICIAL_BIZ_JID = '16505361212@c.us';
export const SERVER_JID = 'server@c.us';
export const PSA_WID = '0@c.us';
export const STORIES_JID = 'status@broadcast';
export const META_AI_JID = '13135550002@c.us';
