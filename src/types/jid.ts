/** JID server types used by WhatsApp */
export type JidServer =
  | 's.whatsapp.net'
  | 'g.us'
  | 'c.us'
  | 'broadcast'
  | 'lid'
  | 'newsletter'
  | 'msgr';

/** WhatsApp JID domain types */
export type WAJIDDomains = 'pn' | 'lid' | 'msgr';

/** Fully parsed JID */
export interface FullJid {
  user: string;
  device?: number;
  server: JidServer;
  domainType?: WAJIDDomains;
}

/** JID string — e.g. "923124166950@s.whatsapp.net" or "197151900590225@lid" */
export type JidString = string;

/** LID-to-phone mapping entry */
export interface LidMapping {
  lid: string;
  phone: string;
  updatedAt: number;
}
