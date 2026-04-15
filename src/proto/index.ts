/**
 * Protobuf definitions for WhatsApp's message format.
 *
 * In Phase 1, this will be populated with the full WAProto definitions
 * forked from Baileys' WAProto directory (~789KB of protobuf schemas).
 *
 * For now, we re-export a placeholder namespace.
 */

/** Placeholder proto namespace — will be replaced with full WAProto in Phase 1 */
export namespace proto {
  export interface IMessageKey {
    remoteJid?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
  }

  export interface IWebMessageInfo {
    key: IMessageKey;
    message?: IMessage | null;
    messageTimestamp?: number | Long | null;
    pushName?: string | null;
    status?: number | null;
    participant?: string | null;
    broadcast?: boolean | null;
  }

  export interface IMessage {
    conversation?: string | null;
    extendedTextMessage?: IExtendedTextMessage | null;
    imageMessage?: IImageMessage | null;
    videoMessage?: IVideoMessage | null;
    audioMessage?: IAudioMessage | null;
    documentMessage?: IDocumentMessage | null;
    stickerMessage?: IStickerMessage | null;
    reactionMessage?: IReactionMessage | null;
    editedMessage?: { message?: IMessage | null } | null;
  }

  export interface IExtendedTextMessage {
    text?: string | null;
    contextInfo?: IContextInfo | null;
  }

  export interface IContextInfo {
    stanzaId?: string | null;
    participant?: string | null;
    quotedMessage?: IMessage | null;
    mentionedJid?: string[] | null;
  }

  export interface IImageMessage {
    url?: string | null;
    mimetype?: string | null;
    caption?: string | null;
    mediaKey?: Uint8Array | null;
    directPath?: string | null;
  }

  export interface IVideoMessage extends IImageMessage {
    seconds?: number | null;
    gifPlayback?: boolean | null;
  }

  export interface IAudioMessage extends IImageMessage {
    seconds?: number | null;
    ptt?: boolean | null;
  }

  export interface IDocumentMessage extends IImageMessage {
    fileName?: string | null;
    pageCount?: number | null;
  }

  export interface IStickerMessage extends IImageMessage {
    isAnimated?: boolean | null;
  }

  export interface IReactionMessage {
    key?: IMessageKey | null;
    text?: string | null;
  }

  /** protobuf Long type placeholder */
  interface Long {
    toNumber(): number;
  }
}
