import type { WAMessage, WAMessageContent } from '../types/message.js';

/**
 * Extract the text content from a WAMessage.
 * Handles plain text, extended text, captions, and edited messages.
 */
export function extractText(message: WAMessage): string | undefined {
  const content = message.message;
  if (!content) return undefined;

  // Plain text
  if (content.conversation) return content.conversation;

  // Extended text (with mentions, links, etc.)
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;

  // Image/video/document captions
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;

  // Edited message
  if (content.editedMessage?.message) {
    return extractTextFromContent(content.editedMessage.message);
  }

  // View-once message
  if (content.viewOnceMessage?.message) {
    return extractTextFromContent(content.viewOnceMessage.message);
  }
  if (content.viewOnceMessageV2?.message) {
    return extractTextFromContent(content.viewOnceMessageV2.message);
  }

  return undefined;
}

/** Extract text from a WAMessageContent (without the outer WAMessage wrapper) */
function extractTextFromContent(content: WAMessageContent): string | undefined {
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  return undefined;
}

/** Check if a message is from the bot itself */
export function isFromMe(message: WAMessage): boolean {
  return message.key.fromMe === true;
}

/** Check if a message is a group message */
export function isGroupMessage(message: WAMessage): boolean {
  return message.key.remoteJid?.endsWith('@g.us') === true;
}

/** Check if a message is a status broadcast */
export function isStatusBroadcast(message: WAMessage): boolean {
  return message.key.remoteJid === 'status@broadcast';
}

/** Get the sender JID from a message */
export function getSenderJid(message: WAMessage): string | undefined {
  if (isGroupMessage(message)) {
    return message.key.participant ?? undefined;
  }
  return message.key.remoteJid ?? undefined;
}

/** Get the chat JID from a message */
export function getChatJid(message: WAMessage): string | undefined {
  return message.key.remoteJid ?? undefined;
}

/** Check if a message contains media */
export function hasMedia(message: WAMessage): boolean {
  const content = message.message;
  if (!content) return false;
  return !!(
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage
  );
}

/** Get the media type from a message */
export function getMediaType(
  message: WAMessage,
): 'image' | 'video' | 'audio' | 'document' | 'sticker' | undefined {
  const content = message.message;
  if (!content) return undefined;
  if (content.imageMessage) return 'image';
  if (content.videoMessage) return 'video';
  if (content.audioMessage) return 'audio';
  if (content.documentMessage) return 'document';
  if (content.stickerMessage) return 'sticker';
  return undefined;
}
