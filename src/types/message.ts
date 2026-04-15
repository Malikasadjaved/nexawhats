import type { JidString } from './jid.js';

/** Message key — uniquely identifies a message */
export interface WAMessageKey {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
}

/** Incoming WhatsApp message */
export interface WAMessage {
  key: WAMessageKey;
  message?: WAMessageContent | null;
  messageTimestamp?: number;
  pushName?: string | null;
  status?: WAMessageStatus;
  participant?: string | null;
  broadcast?: boolean;
}

/** Message status */
export type WAMessageStatus =
  | 'ERROR'
  | 'PENDING'
  | 'SERVER_ACK'
  | 'DELIVERY_ACK'
  | 'READ'
  | 'PLAYED';

/** Message update event data */
export interface WAMessageUpdate {
  key: WAMessageKey;
  update: Partial<WAMessage>;
}

/** Message content — discriminated by which field is present */
export interface WAMessageContent {
  conversation?: string | null;
  extendedTextMessage?: {
    text?: string | null;
    contextInfo?: MessageContextInfo | null;
    matchedText?: string | null;
    canonicalUrl?: string | null;
    description?: string | null;
    title?: string | null;
  } | null;
  imageMessage?: WAMediaMessage | null;
  videoMessage?: WAMediaMessage | null;
  audioMessage?: WAAudioMessage | null;
  documentMessage?: WADocumentMessage | null;
  stickerMessage?: WAMediaMessage | null;
  contactMessage?: {
    displayName?: string | null;
    vcard?: string | null;
  } | null;
  locationMessage?: {
    degreesLatitude?: number | null;
    degreesLongitude?: number | null;
    name?: string | null;
    address?: string | null;
  } | null;
  reactionMessage?: {
    key?: WAMessageKey | null;
    text?: string | null;
  } | null;
  pollCreationMessage?: {
    name?: string | null;
    options?: Array<{ optionName?: string | null }> | null;
    selectableOptionsCount?: number | null;
  } | null;
  editedMessage?: {
    message?: WAMessageContent | null;
  } | null;
  viewOnceMessage?: {
    message?: WAMessageContent | null;
  } | null;
  viewOnceMessageV2?: {
    message?: WAMessageContent | null;
  } | null;
}

/** Context info attached to messages */
export interface MessageContextInfo {
  stanzaId?: string | null;
  participant?: string | null;
  quotedMessage?: WAMessageContent | null;
  mentionedJid?: string[] | null;
  isForwarded?: boolean | null;
  forwardingScore?: number | null;
}

/** Base media message fields */
export interface WAMediaMessage {
  url?: string | null;
  mimetype?: string | null;
  caption?: string | null;
  fileSha256?: Uint8Array | null;
  fileLength?: number | null;
  mediaKey?: Uint8Array | null;
  fileEncSha256?: Uint8Array | null;
  directPath?: string | null;
  jpegThumbnail?: Uint8Array | null;
  contextInfo?: MessageContextInfo | null;
  width?: number | null;
  height?: number | null;
}

/** Audio-specific message fields */
export interface WAAudioMessage extends WAMediaMessage {
  seconds?: number | null;
  ptt?: boolean | null;
  waveform?: Uint8Array | null;
}

/** Document-specific message fields */
export interface WADocumentMessage extends WAMediaMessage {
  fileName?: string | null;
  pageCount?: number | null;
}

/** What you can send — discriminated union */
export type AnyMessageContent =
  | TextContent
  | ImageContent
  | VideoContent
  | AudioContent
  | DocumentContent
  | StickerContent
  | LocationContent
  | ContactContent
  | ReactionContent
  | PollContent
  | EditContent
  | DeleteContent
  | ForwardContent;

export interface TextContent {
  text: string;
  mentions?: JidString[];
  contextInfo?: MessageContextInfo;
}

export interface ImageContent {
  image: WAMediaUpload;
  caption?: string;
  jpegThumbnail?: string;
  contextInfo?: MessageContextInfo;
}

export interface VideoContent {
  video: WAMediaUpload;
  caption?: string;
  ptv?: boolean;
  gifPlayback?: boolean;
  contextInfo?: MessageContextInfo;
}

export interface AudioContent {
  audio: WAMediaUpload;
  ptt?: boolean;
  seconds?: number;
  contextInfo?: MessageContextInfo;
}

export interface DocumentContent {
  document: WAMediaUpload;
  mimetype: string;
  fileName?: string;
  caption?: string;
  contextInfo?: MessageContextInfo;
}

export interface StickerContent {
  sticker: WAMediaUpload;
  isAnimated?: boolean;
  contextInfo?: MessageContextInfo;
}

export interface LocationContent {
  location: {
    degreesLatitude: number;
    degreesLongitude: number;
    name?: string;
    address?: string;
  };
  contextInfo?: MessageContextInfo;
}

export interface ContactContent {
  contacts: {
    displayName: string;
    contacts: Array<{ vcard: string }>;
  };
}

export interface ReactionContent {
  react: {
    text: string;
    key: WAMessageKey;
  };
}

export interface PollContent {
  poll: {
    name: string;
    values: string[];
    selectableCount?: number;
  };
}

export interface EditContent {
  text: string;
  edit: WAMessageKey;
}

export interface DeleteContent {
  delete: WAMessageKey;
}

export interface ForwardContent {
  forward: WAMessage;
  force?: boolean;
}

/** Media upload source — buffer, stream, or URL */
export type WAMediaUpload = Buffer | { stream: NodeJS.ReadableStream } | { url: URL | string };

/** Media types for upload/download */
export type MediaType =
  | 'audio'
  | 'document'
  | 'gif'
  | 'image'
  | 'ppic'
  | 'product'
  | 'ptt'
  | 'sticker'
  | 'video'
  | 'thumbnail-document'
  | 'thumbnail-image'
  | 'thumbnail-video'
  | 'thumbnail-link'
  | 'md-msg-hist'
  | 'md-app-state'
  | 'ptv';

/** Message send priority */
export type MessagePriority = 'urgent' | 'high' | 'normal' | 'low';

/** Options for sending a message */
export interface MessageSendOptions {
  /** Message priority in the queue (default: 'normal') */
  priority?: MessagePriority;
  /** Timeout in ms for this specific message (default: queue default) */
  timeoutMs?: number;
}
