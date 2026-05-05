/**
 * Message content generation — converts user-friendly `AnyMessageContent`
 * into WhatsApp protobuf `Message` and `WebMessageInfo` objects.
 *
 * Ported from Baileys' `Utils/messages.js` (generateWAMessageContent,
 * generateWAMessageFromContent, generateWAMessage, normalizeMessageContent,
 * getContentType, generateForwardMessageContent).
 */
import { proto } from '../proto/index.js';
import type {
  AnyMessageContent,
  MediaUploadCallback,
  WAMessage,
  WAMessageContent,
} from '../types/message.js';
import { generateMessageId } from '../utils/crypto.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Get the key that holds the actual message content (e.g. "conversation" or "imageMessage"). */
export function getContentType(
  content: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!content) return undefined;
  return Object.keys(content).find(
    (k) => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage',
  );
}

/**
 * Unwrap ephemeral, view-once, and document-with-caption wrappers to
 * get the inner message content. Max 5 iterations to prevent loops.
 */
export function normalizeMessageContent(
  content: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!content) return undefined;
  for (let i = 0; i < 5; i++) {
    let inner: Record<string, unknown> | undefined;
    for (const wrapper of [
      'ephemeralMessage',
      'viewOnceMessage',
      'viewOnceMessageV2',
      'viewOnceMessageV2Extension',
      'documentWithCaptionMessage',
      'editedMessage',
    ] as const) {
      const wrapped = content[wrapper] as { message?: Record<string, unknown> } | undefined;
      if (wrapped?.message) {
        inner = wrapped.message;
        break;
      }
    }
    if (!inner) break;
    // biome-ignore lint/style/noParameterAssign: unwrapping loop (matches Baileys)
    content = inner;
  }
  return content;
}

// ── Proto byte-level helpers (bypass proto.fromObject for known shapes) ─

/** Encode a proto.Message to bytes via the runtime proxy. */
function encodeProto(msg: unknown): Uint8Array {
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  return (proto as any).Message.encode(msg).finish() as Uint8Array;
}

/** Decode bytes to proto.Message. */
function decodeProto(buf: Uint8Array): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  return (proto as any).Message.decode(buf) as Record<string, unknown>;
}

/** Create a proto.Message from a plain object. */
function createProtoMessage(obj: Record<string, unknown>): unknown {
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  return (proto as any).Message.create(obj);
}

// ── Forwarding ──────────────────────────────────────────────────────

/**
 * Generate forwarded message content, incrementing the forwarding score
 * if the message is from someone else.
 */
export function generateForwardMessageContent(
  message: WAMessage,
  forceForward?: boolean,
): Record<string, unknown> {
  let content = normalizeMessageContent(
    message.message as Record<string, unknown> | null | undefined,
  );
  if (!content) throw new Error('no content in message');

  // Re-encode/decode to get a clean copy
  const encoded = encodeProto(content);
  content = decodeProto(encoded);

  let key = Object.keys(content)[0];
  let score =
    (content?.[key] as { contextInfo?: { forwardingScore?: number } })?.contextInfo
      ?.forwardingScore ?? 0;
  score += message.key.fromMe && !forceForward ? 0 : 1;

  if (key === 'conversation') {
    content.extendedTextMessage = { text: content.conversation };
    content.conversation = undefined;
    key = 'extendedTextMessage';
  }

  const inner = content?.[key] as Record<string, unknown>;
  if (inner) {
    if (score > 0) {
      inner.contextInfo = { forwardingScore: score, isForwarded: true };
    } else {
      inner.contextInfo = {};
    }
  }
  return content;
}

// ── Content generation ──────────────────────────────────────────────

export interface GenerateContentOptions {
  /** Logger (for link preview warnings). */
  logger?: { warn?: (...args: unknown[]) => void };
  /** User JID (our own). */
  userJid?: string;
  /** Background color for text messages. */
  backgroundColor?: string | number;
  /** Font type for text messages. */
  font?: number;
  /** Group JID for ephemeral/message context. */
  jid?: string;
  /** Media upload callback — encrypts + uploads to WhatsApp CDN. */
  upload?: MediaUploadCallback;
}

/**
 * Convert user-friendly `AnyMessageContent` into a `proto.Message`.
 *
 * Supported content types (initial D6):
 * - text (with mentions)
 * - image (basic — media upload is handled by the relay)
 * - react, delete, location, contacts
 * - forward
 * - groupInvite
 * - disappearingMessagesInChat
 */
export async function generateWAMessageContent(
  message: AnyMessageContent,
  options: GenerateContentOptions,
): Promise<unknown> {
  let m: Record<string, unknown> = {};

  if ('text' in message) {
    const extContent: Record<string, unknown> = { text: message.text };
    const textMsg = message as { contextInfo?: Record<string, unknown> };
    if (textMsg.contextInfo) {
      extContent.contextInfo = textMsg.contextInfo;
    }
    if (options.backgroundColor) {
      extContent.backgroundArgb = options.backgroundColor;
    }
    if (options.font !== undefined) {
      extContent.font = options.font;
    }
    m.extendedTextMessage = extContent;
  } else if ('contacts' in message) {
    const contacts = message.contacts.contacts;
    if (contacts.length === 0) throw new Error('require at least 1 contact');
    if (contacts.length === 1) {
      m.contactMessage = contacts[0];
    } else {
      m.contactsArrayMessage = message.contacts;
    }
  } else if ('location' in message) {
    m.locationMessage = message.location;
  } else if ('react' in message) {
    const react: Record<string, unknown> = { ...message.react };
    if (!react.senderTimestampMs) {
      react.senderTimestampMs = Date.now();
    }
    m.reactionMessage = react;
  } else if ('delete' in message) {
    m.protocolMessage = {
      key: message.delete,
      type: 2, // REVOKE
    };
  } else if ('forward' in message) {
    m = generateForwardMessageContent(message.forward, message.force);
  } else if ('disappearingMessagesInChat' in message) {
    const exp =
      typeof message.disappearingMessagesInChat === 'boolean'
        ? message.disappearingMessagesInChat
          ? 7 * 24 * 60 * 60 // WA_DEFAULT_EPHEMERAL
          : 0
        : message.disappearingMessagesInChat;
    m = {
      ephemeralMessage: {
        message: {
          protocolMessage: {
            type: 3, // EPHEMERAL_SETTING
            ephemeralExpiration: exp,
          },
        },
      },
    };
  } else if ('image' in message) {
    if (options.upload) {
      const uploaded = await options.upload(message.image, 'image', { generateThumbnail: true });
      const mediaMsg: Record<string, unknown> = {
        url: uploaded.mediaUrl,
        directPath: uploaded.directPath,
        mediaKey: uploaded.mediaKey,
        fileEncSha256: uploaded.fileEncSha256,
        fileSha256: uploaded.fileSha256,
        fileLength: uploaded.fileLength,
        mimetype: 'image/jpeg',
      };
      if (uploaded.originalDimensions) {
        mediaMsg.width = uploaded.originalDimensions.width;
        mediaMsg.height = uploaded.originalDimensions.height;
      }
      if (uploaded.jpegThumbnail) mediaMsg.jpegThumbnail = uploaded.jpegThumbnail;
      if (message.caption) mediaMsg.caption = message.caption;
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { imageMessage?: unknown }).imageMessage = mediaMsg;
    } else {
      const mediaMsg: Record<string, unknown> = {};
      if (message.caption) mediaMsg.caption = message.caption;
      if (message.jpegThumbnail) mediaMsg.jpegThumbnail = message.jpegThumbnail;
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { imageMessage?: unknown }).imageMessage = mediaMsg;
    }
  } else if ('video' in message) {
    if (options.upload) {
      const uploaded = await options.upload(message.video, 'video', { generateThumbnail: true });
      const mediaMsg: Record<string, unknown> = {
        url: uploaded.mediaUrl,
        directPath: uploaded.directPath,
        mediaKey: uploaded.mediaKey,
        fileEncSha256: uploaded.fileEncSha256,
        fileSha256: uploaded.fileSha256,
        fileLength: uploaded.fileLength,
        mimetype: message.gifPlayback ? 'video/mp4' : 'video/mp4',
      };
      if (uploaded.originalDimensions) {
        mediaMsg.width = uploaded.originalDimensions.width;
        mediaMsg.height = uploaded.originalDimensions.height;
      }
      if (uploaded.jpegThumbnail) mediaMsg.jpegThumbnail = uploaded.jpegThumbnail;
      if (message.caption) mediaMsg.caption = message.caption;
      if (message.ptv) mediaMsg.ptv = true;
      if (message.gifPlayback) mediaMsg.gifPlayback = true;
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { videoMessage?: unknown }).videoMessage = mediaMsg;
    } else {
      const mediaMsg: Record<string, unknown> = {};
      if (message.caption) mediaMsg.caption = message.caption;
      if (message.ptv) mediaMsg.ptv = true;
      if (message.gifPlayback) mediaMsg.gifPlayback = true;
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { videoMessage?: unknown }).videoMessage = mediaMsg;
    }
  } else if ('audio' in message) {
    if (options.upload) {
      const uploaded = await options.upload(message.audio, 'audio');
      const mediaMsg: Record<string, unknown> = {
        url: uploaded.mediaUrl,
        directPath: uploaded.directPath,
        mediaKey: uploaded.mediaKey,
        fileEncSha256: uploaded.fileEncSha256,
        fileSha256: uploaded.fileSha256,
        fileLength: uploaded.fileLength,
        mimetype: 'audio/ogg; codecs=opus',
      };
      if (message.ptt) mediaMsg.ptt = true;
      if (message.seconds !== undefined) mediaMsg.seconds = message.seconds;
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { audioMessage?: unknown }).audioMessage = mediaMsg;
    } else {
      const mediaMsg: Record<string, unknown> = {};
      if (message.ptt) mediaMsg.ptt = true;
      if (message.seconds !== undefined) mediaMsg.seconds = message.seconds;
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { audioMessage?: unknown }).audioMessage = mediaMsg;
    }
  } else if ('document' in message) {
    if (options.upload) {
      const uploaded = await options.upload(message.document, 'document');
      const mediaMsg: Record<string, unknown> = {
        url: uploaded.mediaUrl,
        directPath: uploaded.directPath,
        mediaKey: uploaded.mediaKey,
        fileEncSha256: uploaded.fileEncSha256,
        fileSha256: uploaded.fileSha256,
        fileLength: uploaded.fileLength,
        mimetype: message.mimetype,
      };
      if (message.fileName) mediaMsg.fileName = message.fileName;
      if (message.caption) mediaMsg.caption = message.caption;
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { documentMessage?: unknown }).documentMessage = mediaMsg;
    } else {
      const mediaMsg: Record<string, unknown> = {
        mimetype: message.mimetype,
      };
      if (message.fileName) mediaMsg.fileName = message.fileName;
      if (message.caption) mediaMsg.caption = message.caption;
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { documentMessage?: unknown }).documentMessage = mediaMsg;
    }
  } else if ('sticker' in message) {
    if (options.upload) {
      const uploaded = await options.upload(message.sticker, 'sticker');
      const mediaMsg: Record<string, unknown> = {
        url: uploaded.mediaUrl,
        directPath: uploaded.directPath,
        mediaKey: uploaded.mediaKey,
        fileEncSha256: uploaded.fileEncSha256,
        fileSha256: uploaded.fileSha256,
        fileLength: uploaded.fileLength,
        mimetype: message.isAnimated ? 'image/webp' : 'image/webp',
      };
      if (uploaded.originalDimensions) {
        mediaMsg.width = uploaded.originalDimensions.width;
        mediaMsg.height = uploaded.originalDimensions.height;
      }
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { stickerMessage?: unknown }).stickerMessage = mediaMsg;
    } else {
      const mediaMsg: Record<string, unknown> = {};
      if (message.contextInfo) mediaMsg.contextInfo = message.contextInfo;
      (m as { stickerMessage?: unknown }).stickerMessage = mediaMsg;
    }
  } else if ('poll' in message) {
    m.pollCreationMessage = {
      name: message.poll.name,
      options: message.poll.values.map((v) => ({ optionName: v })),
      selectableOptionsCount: message.poll.selectableCount ?? 0,
    };
  } else if ('buttons' in message) {
    const b = message.buttons;
    const btnMsg: Record<string, unknown> = {};
    if (b.text) btnMsg.contentText = b.text;
    if (b.footerText) btnMsg.footerText = b.footerText;
    if (b.headerText) btnMsg.headerType = 2;
    if (b.headerText) btnMsg.text = b.headerText;
    if (b.headerType !== undefined) btnMsg.headerType = b.headerType;
    btnMsg.buttons = b.buttons.map((btn, i) => ({
      buttonId: btn.buttonId ?? `${i}`,
      buttonText: { displayText: btn.buttonText.displayText },
      type: btn.type ?? 1,
      nativeFlowInfo: btn.nativeFlowInfo ?? null,
    }));
    if (b.contextInfo) btnMsg.contextInfo = b.contextInfo;

    // Handle media headers (image/video/document)
    if (b.headerImage && options.upload) {
      const uploaded = await options.upload(b.headerImage, 'image', { generateThumbnail: true });
      btnMsg.headerType = 3;
      btnMsg.imageMessage = {
        url: uploaded.mediaUrl,
        mediaKey: uploaded.mediaKey,
        fileEncSha256: uploaded.fileEncSha256,
        fileSha256: uploaded.fileSha256,
        fileLength: uploaded.fileLength,
        mimetype: 'image/jpeg',
        ...(uploaded.originalDimensions ?? {}),
        jpegThumbnail: uploaded.jpegThumbnail,
      };
    } else if (b.headerVideo && options.upload) {
      const uploaded = await options.upload(b.headerVideo, 'video', { generateThumbnail: true });
      btnMsg.headerType = 4;
      btnMsg.videoMessage = {
        url: uploaded.mediaUrl,
        mediaKey: uploaded.mediaKey,
        fileEncSha256: uploaded.fileEncSha256,
        fileSha256: uploaded.fileSha256,
        fileLength: uploaded.fileLength,
        mimetype: 'video/mp4',
        ...(uploaded.originalDimensions ?? {}),
        jpegThumbnail: uploaded.jpegThumbnail,
      };
    } else if (b.headerDocument && options.upload) {
      const uploaded = await options.upload(b.headerDocument, 'document');
      btnMsg.headerType = 5;
      btnMsg.documentMessage = {
        url: uploaded.mediaUrl,
        mediaKey: uploaded.mediaKey,
        fileEncSha256: uploaded.fileEncSha256,
        fileSha256: uploaded.fileSha256,
        fileLength: uploaded.fileLength,
        mimetype: 'application/pdf',
      };
    }
    m.buttonsMessage = btnMsg;
  } else if ('list' in message) {
    const l = message.list;
    const listMsg: Record<string, unknown> = {};
    if (l.title) listMsg.title = l.title;
    if (l.description) listMsg.description = l.description;
    if (l.buttonText) listMsg.buttonText = l.buttonText;
    if (l.footerText) listMsg.footerText = l.footerText;
    if (l.listType !== undefined) listMsg.listType = l.listType;
    listMsg.sections = l.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        title: r.title,
        description: r.description ?? null,
        rowId: r.rowId,
      })),
    }));
    if (l.contextInfo) listMsg.contextInfo = l.contextInfo;
    m.listMessage = listMsg;
  } else if ('buttonReply' in message) {
    const br = message.buttonReply;
    if (message.type === 'template') {
      m.templateButtonReplyMessage = {
        selectedDisplayText: br.displayText,
        selectedId: br.id,
        selectedIndex: br.index,
      };
    } else {
      m.buttonsResponseMessage = {
        selectedButtonId: br.id,
        selectedDisplayText: br.displayText,
        type: 2, // DISPLAY_TEXT
      };
    }
  } else if ('interactive' in message) {
    const iv = message.interactive;
    const imsg: Record<string, unknown> = {};
    if (iv.body) imsg.body = iv.body;
    if (iv.footer) imsg.footer = iv.footer;
    if (iv.header) imsg.header = iv.header;
    if (iv.nativeFlowMessage) imsg.nativeFlowMessage = iv.nativeFlowMessage;
    if (iv.carouselMessage) imsg.carouselMessage = iv.carouselMessage;
    if (iv.shopMessage) imsg.shopMessage = iv.shopMessage;
    if (iv.productMessage) imsg.productMessage = iv.productMessage;
    if (iv.contextInfo) imsg.contextInfo = iv.contextInfo;
    m.interactiveMessage = imsg;
  } else if ('template' in message) {
    const t = message.template;
    const tpl: Record<string, unknown> = {};
    if (t.hydratedFourRowTemplate) tpl.hydratedFourRowTemplate = t.hydratedFourRowTemplate;
    if (t.hydratedTemplate) tpl.hydratedTemplate = t.hydratedTemplate;
    if (t.fourRowTemplate) tpl.fourRowTemplate = t.fourRowTemplate;
    if (t.contextInfo) tpl.contextInfo = t.contextInfo;
    m.templateMessage = tpl;
  }

  // ── View-once wrapping ────────────────────────────────────────
  if ('viewOnce' in message && message.viewOnce) {
    m = { viewOnceMessage: { message: m } };
  }

  // ── Mentions ──────────────────────────────────────────────────
  if ('mentions' in message && message.mentions?.length) {
    const msgType = Object.keys(m)[0];
    const key = m[msgType] as Record<string, unknown> | undefined;
    if (key) {
      if ('contextInfo' in key && key.contextInfo) {
        (key.contextInfo as Record<string, unknown>).mentionedJid = message.mentions;
      } else {
        key.contextInfo = { mentionedJid: message.mentions };
      }
    }
  }

  // ── Edit wrapping ─────────────────────────────────────────────
  if ('edit' in message) {
    m = {
      protocolMessage: {
        key: message.edit,
        editedMessage: m,
        timestampMs: Date.now(),
        type: 5, // MESSAGE_EDIT
      },
    };
  }

  return createProtoMessage(m);
}

// ── Envelope generation ─────────────────────────────────────────────

export interface GenerateFromContentOptions {
  /** User JID (the sender). */
  userJid?: string;
  /** Message ID override. */
  messageId?: string;
  /** Timestamp override. */
  timestamp?: Date;
  /** Quoted message. */
  quoted?: WAMessage;
  /** Ephemeral expiration in seconds. */
  ephemeralExpiration?: number;
  /** Whether this is for a newsletter (skip quote/ephemeral logic). */
  isNewsletter?: boolean;
}

/**
 * Wrap a `proto.Message` in a `proto.WebMessageInfo` envelope.
 */
export function generateWAMessageFromContent(
  jid: string,
  message: unknown,
  options: GenerateFromContentOptions,
): WAMessage {
  const innerMessage = normalizeMessageContent(
    message as Record<string, unknown> | null | undefined,
  ) as WAMessageContent;
  const key = getContentType(innerMessage as Record<string, unknown>);
  const timestamp = Math.floor((options.timestamp?.getTime() ?? Date.now()) / 1000);
  const { quoted, userJid } = options;

  // ── Quoted message ────────────────────────────────────────────
  if (quoted && !options.isNewsletter) {
    const participant = quoted.key.fromMe
      ? userJid
      : (quoted.participant ?? quoted.key.participant ?? quoted.key.remoteJid);

    const normalized = normalizeMessageContent(
      quoted.message as Record<string, unknown> | null | undefined,
    );
    const quotedType = getContentType(normalized as Record<string, unknown>);
    const quotedMsg = createProtoMessage(
      quotedType && normalized
        ? { [quotedType]: (normalized as Record<string, unknown>)[quotedType] }
        : {},
    );

    const inner = key ? (innerMessage as Record<string, unknown>)?.[key] : undefined;
    const contextInfo: Record<string, unknown> =
      (inner as { contextInfo?: Record<string, unknown> } | undefined)?.contextInfo ?? {};

    contextInfo.participant = participant;
    contextInfo.stanzaId = quoted.key.id;
    contextInfo.quotedMessage = quotedMsg;
    if (jid !== quoted.key.remoteJid) {
      contextInfo.remoteJid = quoted.key.remoteJid;
    }

    if (contextInfo && inner && key) {
      (innerMessage as Record<string, unknown>)[key] = {
        ...inner,
        contextInfo,
      };
    }
  }

  // ── Ephemeral expiration ──────────────────────────────────────
  if (
    options.ephemeralExpiration &&
    key !== 'protocolMessage' &&
    key !== 'ephemeralMessage' &&
    !options.isNewsletter
  ) {
    const inner = key ? (innerMessage as Record<string, unknown>)?.[key] : undefined;
    if (inner && typeof inner === 'object') {
      (inner as Record<string, unknown>).contextInfo = {
        ...((inner as Record<string, unknown>).contextInfo as Record<string, unknown> | undefined),
        expiration: options.ephemeralExpiration,
      };
    }
  }

  return {
    key: {
      remoteJid: jid,
      fromMe: true,
      id: options.messageId ?? generateMessageId(),
    },
    message: innerMessage,
    messageTimestamp: timestamp,
    messageStubParameters: [],
    participant: jid.endsWith('@g.us') || jid === 'status@broadcast' ? userJid : undefined,
    status: 'PENDING',
  };
}

// ── Top-level convenience ───────────────────────────────────────────

export interface GenerateWAMessageOptions
  extends GenerateContentOptions,
    GenerateFromContentOptions {}

/**
 * Generate a WAMessage from user content — the main entry point for
 * creating messages to send.
 */
export async function generateWAMessage(
  jid: string,
  content: AnyMessageContent,
  options: GenerateWAMessageOptions,
): Promise<WAMessage> {
  const msg = await generateWAMessageContent(content, options);
  return generateWAMessageFromContent(jid, msg, options);
}
