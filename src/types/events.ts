import type { AuthenticationCreds, Contact } from './auth.js';
import type { WAMessage, WAMessageKey, WAMessageUpdate } from './message.js';
import type { ConnectionState } from './socket.js';

/** Chat metadata */
export interface Chat {
  id: string;
  name?: string;
  conversationTimestamp?: number;
  unreadCount?: number;
  archived?: boolean;
  pinned?: boolean;
  mute?: number;
  ephemeralExpiration?: number;
}

/** Chat update delta */
export type ChatUpdate = Partial<Chat> & { id: string };

/** Presence data */
export interface PresenceData {
  lastKnownPresence: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';
  lastSeen?: number;
}

/** Group participant */
export interface GroupParticipant {
  id: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
}

/** Group metadata */
export interface GroupMetadata {
  id: string;
  subject: string;
  subjectOwner?: string;
  subjectTime?: number;
  creation?: number;
  owner?: string;
  desc?: string;
  descOwner?: string;
  participants: GroupParticipant[];
  ephemeralDuration?: number;
  announce?: boolean;
  restrict?: boolean;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
  linkedParent?: string;
  size?: number;
}

/** Group participant action */
export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote' | 'modify';

/** Call event */
export interface WACallEvent {
  chatId: string;
  from: string;
  isGroup: boolean;
  isVideo: boolean;
  status: 'offer' | 'ringing' | 'reject' | 'accept' | 'timeout';
  date: Date;
}

/** Label (WhatsApp Business) */
export interface Label {
  id: string;
  name: string;
  color: number;
  predefinedId?: string;
}

/** Label association */
export interface LabelAssociation {
  labelId: string;
  chatId: string;
  messageId?: string;
  type: 'chat' | 'message';
}

/** Message receipt update */
export interface MessageUserReceiptUpdate {
  key: WAMessageKey;
  receipt: {
    userJid: string;
    readTimestamp?: number;
    playedTimestamp?: number;
    receiptTimestamp: number;
  };
}

/** Complete event map — all events NexaWhats can emit */
export interface NexaWhatsEventMap {
  // Connection lifecycle
  'connection.update': Partial<ConnectionState>;

  // Credentials
  'creds.update': Partial<AuthenticationCreds>;

  // History sync
  'messaging-history.set': {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    isLatest?: boolean;
    progress?: number | null;
  };

  // Chats
  'chats.upsert': Chat[];
  'chats.update': ChatUpdate[];
  'chats.delete': string[];

  // LID mapping
  'lid-mapping.update': { lid: string; pn: string };

  // Presence
  'presence.update': {
    id: string;
    presences: Record<string, PresenceData>;
  };

  // Contacts
  'contacts.upsert': Contact[];
  'contacts.update': Partial<Contact>[];

  // Messages
  'messages.upsert': {
    messages: WAMessage[];
    type: 'notify' | 'append';
    requestId?: string;
  };
  'messages.update': WAMessageUpdate[];
  'messages.delete': { keys: WAMessageKey[] } | { jid: string; all: true };
  'messages.reaction': Array<{ key: WAMessageKey; reaction: { text: string } }>;
  'messages.media-update': Array<{
    key: WAMessageKey;
    media?: { ciphertext: Uint8Array; iv: Uint8Array };
  }>;
  'message-receipt.update': MessageUserReceiptUpdate[];

  // Groups
  'groups.upsert': GroupMetadata[];
  'groups.update': Partial<GroupMetadata>[];
  'group-participants.update': {
    id: string;
    author: string;
    participants: GroupParticipant[];
    action: ParticipantAction;
  };

  // Blocking
  'blocklist.set': { blocklist: string[] };
  'blocklist.update': { blocklist: string[]; type: 'add' | 'remove' };

  // Calls
  call: WACallEvent[];

  // Labels (Business)
  'labels.edit': Label;
  'labels.association': { association: LabelAssociation; type: 'add' | 'remove' };

  // NexaWhats-specific events (not in Baileys)
  'queue.drained': undefined;
  'queue.dead-letter': { jid: string; content: unknown; error: Error; attempts: number };
  'circuit-breaker.state-change': { from: string; to: string };
}
