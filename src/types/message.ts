import type { JidString } from './jid.js';

/** Message key — uniquely identifies a message */
export interface WAMessageKey {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
  /** Alternate participant JID (LID when primary is PN, or vice versa). */
  participantAlt?: string | null;
  /** Alternate remote JID for LID/PN dual addressing. */
  remoteJidAlt?: string | null;
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
  /** Stub type for system-generated messages (group events, ciphertext errors, etc.). */
  messageStubType?: number | null;
  /** Parameters for stub messages. */
  messageStubParameters?: string[] | null;
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
  /** Protocol messages — revoke, edit, history sync, etc. */
  protocolMessage?: {
    type?: number | null;
    key?: WAMessageKey | null;
    editedMessage?: WAMessageContent | null;
    historySyncNotification?: unknown | null;
    ephemeralExpiration?: number | null;
    appStateSyncKeyShare?: unknown | null;
    peerDataOperationRequestResponseMessage?: unknown | null;
  } | null;
  /** Sender key distribution message (group encryption). */
  senderKeyDistributionMessage?: {
    groupId?: string | null;
    axolotlSenderKeyDistributionMessage?: Uint8Array | null;
  } | null;
  /** Device-sent message wrapper (for own-device path). */
  deviceSentMessage?: {
    destinationJid?: string | null;
    message?: WAMessageContent | null;
  } | null;
  /** Button messages. */
  buttonsMessage?: Record<string, unknown> | null;
  /** List picker messages. */
  listMessage?: Record<string, unknown> | null;
  /** List response messages. */
  listResponseMessage?: Record<string, unknown> | null;
  /** Button response messages. */
  buttonsResponseMessage?: Record<string, unknown> | null;
  /** Template button reply messages. */
  templateButtonReplyMessage?: Record<string, unknown> | null;
  /** Interactive v2 messages. */
  interactiveMessage?: Record<string, unknown> | null;
  /** Template messages. */
  templateMessage?: Record<string, unknown> | null;
  /** Allow any other proto fields at runtime. */
  [key: string]: unknown;
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
  | ForwardContent
  | ButtonsContent
  | ListContent
  | ButtonReplyContent
  | InteractiveContent
  | TemplateContent;

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

// ── Interactive message content types (Phase 3) ─────────────────────

export interface ButtonsContent {
  buttons: {
    /** Body text shown above the buttons. */
    text?: string;
    /** Footer text shown below the buttons. */
    footerText?: string;
    /** The buttons to display (max 3). */
    buttons: Array<{
      buttonId: string;
      buttonText: { displayText: string };
      /** 1 = QUICK_REPLY, 2 = URL, 3 = CALL */
      type: 1 | 2 | 3;
      nativeFlowInfo?: Record<string, unknown>;
    }>;
    /** Header type: 1 = empty, 2 = text, 3 = image, 4 = video, 5 = document */
    headerType?: number;
    /** Header text (used when headerType = 2). */
    headerText?: string;
    /** Header image (used when headerType = 3). Requires `upload` callback. */
    headerImage?: WAMediaUpload;
    /** Header video (used when headerType = 4). Requires `upload` callback. */
    headerVideo?: WAMediaUpload;
    /** Header document (used when headerType = 5). Requires `upload` callback. */
    headerDocument?: WAMediaUpload;
    contextInfo?: MessageContextInfo;
  };
}

export interface ListContent {
  list: {
    /** List title. */
    title?: string;
    /** Body/description text. */
    description?: string;
    /** Text on the "send" button. */
    buttonText?: string;
    /** Footer text. */
    footerText?: string;
    /** List sections, each containing rows. */
    sections: Array<{
      title?: string;
      rows: Array<{
        title: string;
        description?: string;
        rowId: string;
      }>;
    }>;
    /** 0 = SINGLE_SELECT, 1 = PRODUCT_LIST */
    listType?: number;
    contextInfo?: MessageContextInfo;
  };
}

export interface InteractiveContent {
  interactive: {
    /** Interactive body. */
    body?: { text: string };
    /** Interactive footer. */
    footer?: { text: string };
    /** Interactive header (optional). */
    header?: {
      title?: string;
      subtitle?: string;
      hasMediaAttachment?: boolean;
    };
    /** Native Flow Message (v2 interactive). */
    nativeFlowMessage?: Record<string, unknown>;
    /** Carousel message. */
    carouselMessage?: Record<string, unknown>;
    /** Shop message (commerce). */
    shopMessage?: Record<string, unknown>;
    /** Product message. */
    productMessage?: Record<string, unknown>;
    contextInfo?: MessageContextInfo;
  };
}

export interface TemplateContent {
  template: {
    hydratedFourRowTemplate?: Record<string, unknown>;
    hydratedTemplate?: Record<string, unknown>;
    fourRowTemplate?: Record<string, unknown>;
    contextInfo?: MessageContextInfo;
  };
}

export interface ButtonReplyContent {
  buttonReply: {
    displayText: string;
    id: string;
    index?: number;
  };
  /** 'template' sends templateButtonReplyMessage, 'plain' sends buttonsResponseMessage */
  type: 'template' | 'plain';
}

/** Media upload source — buffer, stream, or URL */
export type WAMediaUpload = Buffer | { stream: NodeJS.ReadableStream } | { url: URL | string };

/** Result from uploading media to WhatsApp's CDN. */
export interface MediaUploadResult {
  mediaUrl?: string;
  directPath?: string;
  fbid?: string;
  ts?: string;
  mediaKey: Buffer;
  fileEncSha256: Buffer;
  fileSha256: Buffer;
  fileLength: number;
  jpegThumbnail?: Buffer;
  /** Height x Width of the original media. */
  originalDimensions?: { width: number; height: number };
}

/** Callback that encrypts and uploads media, returning CDN handles. */
export type MediaUploadCallback = (
  media: WAMediaUpload,
  mediaType: string,
  opts?: { generateThumbnail?: boolean },
) => Promise<MediaUploadResult>;

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
