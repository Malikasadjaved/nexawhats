import { promisify } from 'node:util';
/**
 * Message receive — decodes, decrypts, and processes incoming WhatsApp
 * message stanzas from the wire.
 *
 * Ported from Baileys' `Socket/messages-recv.js` and
 * `Utils/decode-wa-message.js` + `Utils/process-message.js` +
 * `Utils/history.js`.
 */
import { inflate } from 'node:zlib';
import type { Logger } from 'pino';
import type { BinaryNode } from '../binary/index.js';
import {
  areJidsSameUser,
  isHostedLidUser,
  isHostedPnUser,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
} from '../binary/jid.js';
import { proto } from '../proto/index.js';
import type { SignalRepository } from '../signal/libsignal.js';
import type { WAMessage, WAMessageContent } from '../types/message.js';
import { aesDecryptGCM, hmacSign } from '../utils/crypto.js';
import { getContentType, normalizeMessageContent } from './encode.js';
import { downloadContentFromMessage } from './media.js';

const inflatePromise = promisify(inflate);

// ── Constants ──────────────────────────────────────────────────────────

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node';

/** Retry configuration for failed decryption. */
export const DECRYPTION_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 100,
  sessionRecordErrors: ['No session record', 'SessionError: No session record'],
};

// ── Addressing ─────────────────────────────────────────────────────────

export interface AddressingContext {
  addressingMode: string;
  senderAlt?: string;
  recipientAlt?: string;
}

/**
 * Extract LID/PN dual-addressing metadata from a message stanza.
 */
export function extractAddressingContext(stanza: BinaryNode): AddressingContext {
  let senderAlt: string | undefined;
  let recipientAlt: string | undefined;

  const sender = stanza.attrs.participant || stanza.attrs.from;
  const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn');

  if (addressingMode === 'lid') {
    senderAlt =
      stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn;
    recipientAlt = stanza.attrs.recipient_pn;
  } else {
    senderAlt =
      stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid;
    recipientAlt = stanza.attrs.recipient_lid;
  }

  return { addressingMode, senderAlt, recipientAlt };
}

// ── Decode ─────────────────────────────────────────────────────────────

export interface DecodedMessage {
  fullMessage: WAMessage;
  author: string;
  sender: string;
}

/**
 * Parse a message `<message>` stanza into a `WAMessage` skeleton without
 * decrypting the content.
 */
export function decodeMessageNode(
  stanza: BinaryNode,
  meId: string,
  meLid?: string,
): DecodedMessage {
  let msgType: string;
  let chatId: string;
  let author: string;
  let fromMe = false;

  const msgId = stanza.attrs.id;
  const from = stanza.attrs.from;
  const participant = stanza.attrs.participant;
  const recipient = stanza.attrs.recipient;
  const addressingContext = extractAddressingContext(stanza);

  const isMe = (jid: string): boolean => areJidsSameUser(jid, meId);
  const isMeLid = (jid: string): boolean => (meLid ? areJidsSameUser(jid, meLid) : false);

  if (
    from &&
    (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from))
  ) {
    if (recipient && !isJidNewsletter(recipient)) {
      if (!isMe(from) && !isMeLid(from)) {
        throw new Error(`recipient present, but msg not from me: ${JSON.stringify(stanza.attrs)}`);
      }
      fromMe = true;
      chatId = recipient;
    } else {
      chatId = from;
    }
    msgType = 'chat';
    author = from;
  } else if (from && isJidGroup(from)) {
    if (!participant) {
      throw new Error('No participant in group message');
    }
    if (isMe(participant) || isMeLid(participant)) {
      fromMe = true;
    }
    msgType = 'group';
    author = participant;
    chatId = from;
  } else if (from && isJidBroadcast(from)) {
    if (!participant) {
      throw new Error('No participant in group message');
    }
    const isParticipantMe = isMe(participant);
    msgType = isParticipantMe ? 'direct_peer_status' : 'other_status';
    fromMe = isParticipantMe;
    chatId = from;
    author = participant;
  } else if (from && isJidNewsletter(from)) {
    msgType = 'newsletter';
    chatId = from;
    author = from;
    if (isMe(from) || isMeLid(from)) {
      fromMe = true;
    }
  } else {
    throw new Error(`Unknown message type: ${JSON.stringify(stanza.attrs)}`);
  }

  const pushname = stanza.attrs.notify;

  const key: WAMessage['key'] = {
    remoteJid: chatId,
    fromMe,
    id: msgId,
    participant,
    ...(msgType === 'newsletter' && stanza.attrs.server_id
      ? { server_id: stanza.attrs.server_id }
      : {}),
  };

  // Attach alt JIDs for LID/PN dual addressing
  if (!isJidGroup(chatId)) {
    (key as Record<string, unknown>).remoteJidAlt = addressingContext.senderAlt;
  }
  if (isJidGroup(chatId)) {
    (key as Record<string, unknown>).participantAlt = addressingContext.senderAlt;
  }
  (key as Record<string, unknown>).addressingMode = addressingContext.addressingMode;

  const fullMessage: WAMessage = {
    key,
    messageTimestamp: Number(stanza.attrs.t) || undefined,
    pushName: pushname,
    broadcast: isJidBroadcast(from),
  };

  if (stanza.attrs.category) {
    (fullMessage as unknown as Record<string, unknown>).category = stanza.attrs.category;
  }

  if (key.fromMe) {
    fullMessage.status = 'SERVER_ACK';
  }

  return {
    fullMessage,
    author,
    sender: msgType === 'chat' ? author : chatId,
  };
}

// ── Decrypt ────────────────────────────────────────────────────────────

export interface DecryptableMessage {
  fullMessage: WAMessage;
  category?: string;
  author: string;
  /** Execute decryption — mutates `fullMessage` in place. */
  decrypt(): Promise<void>;
}

/**
 * Decode and prepare a message stanza for decryption.
 *
 * Returns a `DecryptableMessage` whose `decrypt()` method performs the
 * actual Signal decryption.  The split lets the caller batch multiple
 * messages before running the CPU-heavy decryption step.
 */
export function decryptMessageNode(
  stanza: BinaryNode,
  meId: string,
  meLid: string | undefined,
  repository: SignalRepository,
  logger: Logger,
): DecryptableMessage {
  const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid);

  return {
    fullMessage,
    category: stanza.attrs.category,
    author,
    async decrypt() {
      let decryptables = 0;

      if (!Array.isArray(stanza.content)) return;

      for (const child of stanza.content) {
        if (typeof child !== 'object' || child === null) continue;
        const { tag, attrs, content } = child as BinaryNode;

        // Verified business name
        if (tag === 'verified_name' && content instanceof Uint8Array) {
          try {
            const cert = (proto as Record<string, unknown>).VerifiedNameCertificate as {
              decode: (b: Uint8Array) => { details: Uint8Array };
            };
            const details = (proto as Record<string, unknown>).VerifiedNameCertificate as {
              Details: { decode: (b: Uint8Array) => { verifiedName?: string } };
            };
            const c = cert.decode(content);
            const d = details.Details.decode(c.details);
            (fullMessage as unknown as Record<string, unknown>).verifiedBizName = d.verifiedName;
          } catch {
            // ignore cert parse errors
          }
        }

        if (tag === 'unavailable' && attrs?.type === 'view_once') {
          (fullMessage.key as Record<string, unknown>).isViewOnce = true;
        }

        if (attrs?.count && tag === 'enc') {
          (fullMessage as unknown as Record<string, unknown>).retryCount = Number(attrs.count);
        }

        if (tag !== 'enc' && tag !== 'plaintext') {
          continue;
        }

        if (!(content instanceof Uint8Array)) {
          continue;
        }

        decryptables += 1;

        try {
          const decryptionJid = await getDecryptionJid(author, repository);

          // Store LID mapping from envelope data
          const addressing = extractAddressingContext(stanza);
          if (
            addressing.senderAlt &&
            isLidUser(addressing.senderAlt) &&
            isPnUser(author) &&
            decryptionJid === author
          ) {
            try {
              await repository.lidMapping.storeLIDPNMappings([
                { lid: addressing.senderAlt, pn: author },
              ]);
              await repository.migrateSession(author, addressing.senderAlt);
              logger.debug(
                { author, senderAlt: addressing.senderAlt },
                'Stored LID mapping from envelope',
              );
            } catch (err) {
              logger.warn(
                { author, senderAlt: addressing.senderAlt, err },
                'Failed to store LID mapping',
              );
            }
          }

          const e2eType = tag === 'plaintext' ? 'plaintext' : attrs?.type;
          let msgBuffer: Uint8Array;

          switch (e2eType) {
            case 'skmsg':
              msgBuffer = await repository.decryptGroupMessage({
                group: sender,
                authorJid: author,
                msg: Buffer.from(content),
              });
              break;
            case 'pkmsg':
            case 'msg':
              msgBuffer = await repository.decryptMessage({
                jid: decryptionJid,
                type: e2eType,
                ciphertext: content,
              });
              break;
            case 'plaintext':
              msgBuffer = content;
              break;
            default:
              throw new Error(`Unknown e2e type: ${e2eType}`);
          }

          // Unpad + decode protobuf
          const unpadded = e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer;
          let msg = (
            proto as Record<string, { decode: (b: Uint8Array) => Record<string, unknown> }>
          ).Message.decode(unpadded);

          // Unwrap device-sent wrapper
          msg = (msg.deviceSentMessage as { message?: Record<string, unknown> })?.message || msg;

          // Process sender key distribution inline
          if (msg.senderKeyDistributionMessage) {
            try {
              await repository.processSenderKeyDistributionMessage({
                authorJid: author,
                item: msg.senderKeyDistributionMessage as {
                  groupId?: string | null;
                  axolotlSenderKeyDistributionMessage: Buffer | Uint8Array;
                },
              });
            } catch (err) {
              logger.error(
                { key: fullMessage.key, err },
                'failed to process sender key distribution message',
              );
            }
          }

          // Merge decrypted content into fullMessage
          if (fullMessage.message) {
            Object.assign(fullMessage.message, msg);
          } else {
            fullMessage.message = msg as unknown as WAMessageContent;
          }
        } catch (err) {
          const errorContext = {
            key: fullMessage.key,
            err,
            messageType: tag === 'plaintext' ? 'plaintext' : attrs?.type,
            sender,
            author,
          };
          logger.error(errorContext, 'failed to decrypt message');
          fullMessage.messageStubType = 3; // CIPHERTEXT
          fullMessage.messageStubParameters = [(err as Error).message?.toString() ?? String(err)];
        }
      }

      if (!decryptables && !(fullMessage.key as Record<string, unknown>).isViewOnce) {
        fullMessage.messageStubType = 3; // CIPHERTEXT
        fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT];
      }

      // ── Protocol message detection (Phase 4) ─────────────────────
      const normalizedContent =
        normalizeMessageContent(
          fullMessage.message as Record<string, unknown> | null | undefined,
        ) ?? {};
      const protocolMsg = (normalizedContent as Record<string, unknown>).protocolMessage as
        | {
            type?: number | null;
            historySyncNotification?: Record<string, unknown> | null;
            appStateSyncKeyShare?: {
              keys?: Array<{ keyData?: Uint8Array; keyId?: { keyId?: Uint8Array } }>;
            } | null;
          }
        | undefined;

      if (protocolMsg) {
        // HISTORY_SYNC_NOTIFICATION = 10
        if (protocolMsg.type === 10 && protocolMsg.historySyncNotification) {
          try {
            logger.debug('detected history sync notification, downloading...');
            const historyData = await downloadAndProcessHistorySyncNotification(
              protocolMsg.historySyncNotification,
              {
                downloadViaContent: async (msg, type) => {
                  const dlMsg = {
                    mediaKey: (msg.mediaKey as Uint8Array) ?? null,
                    directPath: (msg.directPath as string) ?? null,
                    url: (msg.url as string) ?? null,
                  };
                  return downloadContentFromMessage(dlMsg, type);
                },
              },
            );
            (fullMessage as unknown as Record<string, unknown>).historySyncData = historyData;
          } catch (err) {
            logger.error({ err, key: fullMessage.key }, 'failed to download history sync');
          }
        }

        // APP_STATE_SYNC_KEY_SHARE = 11
        if (protocolMsg.type === 11 && protocolMsg.appStateSyncKeyShare?.keys?.length) {
          logger.debug(
            { keyCount: protocolMsg.appStateSyncKeyShare.keys.length },
            'detected app state sync key share',
          );
          (fullMessage as unknown as Record<string, unknown>).appStateSyncKeys =
            protocolMsg.appStateSyncKeyShare.keys.map((k) => ({
              keyId: k.keyId?.keyId ? Buffer.from(k.keyId.keyId).toString('base64') : undefined,
              keyData: k.keyData,
            }));
        }
      }

      // ── Poll vote / event response detection (Phase 7) ──────────
      // Attach encrypted payloads so consumers can decrypt them
      // with the exported decryptPollVote / decryptEventResponse.

      const encPollVote = extractEncryptedPollVote(
        normalizedContent as Record<string, unknown> | null,
      );
      if (encPollVote) {
        (fullMessage as unknown as Record<string, unknown>).encryptedPollVote = encPollVote;
      }

      const encEventResp = extractEncryptedEventResponse(
        normalizedContent as Record<string, unknown> | null,
      );
      if (encEventResp) {
        (fullMessage as unknown as Record<string, unknown>).encryptedEventResponse = encEventResp;
      }
    },
  };
}

// ── Clean ──────────────────────────────────────────────────────────────

/**
 * Normalize JIDs and reaction keys in a received message so they are
 * consistent from our perspective.
 */
export function cleanMessage(message: WAMessage, meId: string, meLid?: string): void {
  // Normalize remoteJid
  const remoteJid = message.key.remoteJid ?? '';
  if (isHostedPnUser(remoteJid) || isHostedLidUser(remoteJid)) {
    const decoded = jidDecode(remoteJid);
    message.key.remoteJid = jidEncode(
      decoded?.user ?? '',
      isHostedPnUser(remoteJid) ? 's.whatsapp.net' : 'lid',
    );
  } else if (remoteJid) {
    message.key.remoteJid = jidNormalizedUser(remoteJid);
  }

  // Normalize participant
  const participant = message.key.participant ?? '';
  if (isHostedPnUser(participant) || isHostedLidUser(participant)) {
    const decoded = jidDecode(participant);
    message.key.participant = jidEncode(
      decoded?.user ?? '',
      isHostedPnUser(participant) ? 's.whatsapp.net' : 'lid',
    );
  } else if (participant) {
    message.key.participant = jidNormalizedUser(participant);
  }

  const content = normalizeMessageContent(
    message.message as Record<string, unknown> | null | undefined,
  ) as Record<string, unknown> | undefined;

  // Fix reaction keys
  if (content?.reactionMessage) {
    normaliseKey((content.reactionMessage as { key: Record<string, unknown> }).key);
  }

  // Fix poll update keys
  if (content?.pollUpdateMessage) {
    normaliseKey(
      (content.pollUpdateMessage as { pollCreationMessageKey: Record<string, unknown> })
        .pollCreationMessageKey,
    );
  }

  function normaliseKey(msgKey: Record<string, unknown>): void {
    if (!message.key.fromMe) {
      msgKey.fromMe = !msgKey.fromMe
        ? areJidsSameUser((msgKey.participant as string) || (msgKey.remoteJid as string), meId) ||
          areJidsSameUser(
            (msgKey.participant as string) || (msgKey.remoteJid as string),
            meLid ?? '',
          )
        : false;
      msgKey.remoteJid = message.key.remoteJid;
      msgKey.participant = msgKey.participant || message.key.participant;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Get the chat ID from a message key.
 * For broadcasts from others, the participant is the chat.
 */
export function getChatId(key: {
  remoteJid?: string | null;
  participant?: string | null;
  fromMe?: boolean | null;
}): string | undefined {
  if (
    key.remoteJid &&
    isJidBroadcast(key.remoteJid) &&
    !isJidStatusBroadcast(key.remoteJid) &&
    !key.fromMe
  ) {
    return key.participant ?? undefined;
  }
  return key.remoteJid ?? undefined;
}

/**
 * Check if a message has real (non-protocol, non-reaction) content.
 */
export function isRealMessage(message: WAMessage): boolean {
  const normalizedContent = normalizeMessageContent(
    message.message as Record<string, unknown> | null | undefined,
  );
  const hasSomeContent = !!getContentType(normalizedContent as Record<string, unknown>);
  return (
    !!normalizedContent &&
    hasSomeContent &&
    !normalizedContent.protocolMessage &&
    !normalizedContent.reactionMessage &&
    !normalizedContent.pollUpdateMessage
  );
}

/** Remove the random-byte padding from a WhatsApp protobuf body. */
function unpadRandomMax16(e: Uint8Array): Uint8Array {
  const t = new Uint8Array(e);
  if (t.length === 0) {
    throw new Error('unpadRandomMax16 given empty bytes');
  }
  const r = t[t.length - 1] ?? 0;
  if (r > t.length) {
    throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`);
  }
  return new Uint8Array(t.buffer, t.byteOffset, t.length - r);
}

/**
 * Resolve the JID to use for decryption.
 * LID users decrypt with their LID; PN users may have a mapped LID.
 */
async function getDecryptionJid(sender: string, repository: SignalRepository): Promise<string> {
  if (isLidUser(sender) || isHostedLidUser(sender)) {
    return sender;
  }
  const mapped = await repository.lidMapping.getLIDForPN(sender);
  return mapped || sender;
}

// ── History sync + app state sync (Phase 4) ──────────────────────────

/**
 * Extract a history sync notification from a decoded message, if present.
 * Returns undefined for non-history-sync messages.
 */
export function getHistoryMsg(
  message: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const normalized = normalizeMessageContent(message);
  const histSyncMsg = (normalized as Record<string, unknown> | undefined)?.protocolMessage as
    | { historySyncNotification?: Record<string, unknown> }
    | undefined;
  return histSyncMsg?.historySyncNotification;
}

/**
 * Download, decompress, and decode a HistorySync protobuf from a
 * received history sync notification.
 */
export async function downloadAndProcessHistorySyncNotification(
  notification: Record<string, unknown>,
  options: {
    downloadMedia?: (msg: Record<string, unknown>, type: string) => Promise<AsyncIterable<Buffer>>;
    downloadViaContent?: (
      msg: Record<string, unknown>,
      type: string,
    ) => Promise<AsyncIterable<Buffer>>;
  } = {},
): Promise<Record<string, unknown>> {
  let historyMsg: Record<string, unknown>;

  // Inline payload path (initial bootstrap)
  if (notification.initialHistBootstrapInlinePayload) {
    const decompressed = await inflatePromise(
      Buffer.from(notification.initialHistBootstrapInlinePayload as Uint8Array),
    );
    historyMsg = (
      proto as Record<string, { decode: (b: Uint8Array) => Record<string, unknown> }>
    ).HistorySync.decode(decompressed);
  } else {
    // Download the history from media servers
    const downloader = options.downloadViaContent ?? options.downloadMedia;
    if (!downloader) {
      throw new Error('No download callback provided for history sync');
    }
    const stream = await downloader(notification, 'md-msg-hist');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    let buffer = Buffer.concat(chunks);
    buffer = await inflatePromise(buffer);
    historyMsg = (
      proto as Record<string, { decode: (b: Uint8Array) => Record<string, unknown> }>
    ).HistorySync.decode(buffer);
  }

  return historyMsg;
}

/**
 * Process a raw HistorySync protobuf into messages, contacts, and chats.
 */
export function processHistoryMessage(item: Record<string, unknown>): {
  chats: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  syncType: unknown;
  progress: unknown;
} {
  const messages: Record<string, unknown>[] = [];
  const contacts: Record<string, unknown>[] = [];
  const chats: Record<string, unknown>[] = [];

  const syncType = item.syncType as number;
  // HistorySyncType enum values from proto
  const HIST_INITIAL_BOOTSTRAP = 0;
  const HIST_RECENT = 1;
  const HIST_FULL = 2;
  const HIST_ON_DEMAND = 3;
  const HIST_PUSH_NAME = 4;

  if (
    syncType === HIST_INITIAL_BOOTSTRAP ||
    syncType === HIST_RECENT ||
    syncType === HIST_FULL ||
    syncType === HIST_ON_DEMAND
  ) {
    const conversations = (item.conversations as Array<Record<string, unknown>>) ?? [];
    for (const chat of conversations) {
      contacts.push({
        id: chat.id,
        name: chat.name || undefined,
        lid: chat.lidJid || undefined,
        phoneNumber: chat.pnJid || undefined,
      });
      const msgs = (chat.messages as Array<Record<string, unknown>> | undefined) ?? [];
      (chat as { messages?: unknown }).messages = undefined;
      for (const entry of msgs) {
        const message = entry.message as Record<string, unknown> | undefined;
        if (message) {
          messages.push(message);
        }
        if (
          message &&
          !(message.key as { fromMe?: boolean })?.fromMe &&
          message.messageTimestamp !== undefined &&
          !chat.lastMessageRecvTimestamp
        ) {
          chat.lastMessageRecvTimestamp = message.messageTimestamp;
        }
      }
      chats.push({ ...chat });
    }
  } else if (syncType === HIST_PUSH_NAME) {
    const pushnames = (item.pushnames as Array<Record<string, unknown>>) ?? [];
    for (const c of pushnames) {
      contacts.push({ id: c.id, notify: c.pushname });
    }
  }

  return {
    chats,
    contacts,
    messages,
    syncType: item.syncType,
    progress: item.progress,
  };
}

// ── Poll vote / event response decryption (Phase 7) ───────────────────

export interface PollVoteContext {
  pollCreatorJid: string;
  pollMsgId: string;
  pollEncKey: Uint8Array;
  voterJid: string;
}

export interface EventResponseContext {
  eventCreatorJid: string;
  eventMsgId: string;
  eventEncKey: Uint8Array;
  responderJid: string;
}

/**
 * Decrypt an encrypted poll vote.
 *
 * Uses HMAC-SHA256 key derivation (matching WhatsApp's
 * `messageSecret`-based scheme) followed by AES-256-GCM decryption.
 */
export function decryptPollVote(
  { encPayload, encIv }: { encPayload: Uint8Array; encIv: Uint8Array },
  { pollCreatorJid, pollMsgId, pollEncKey, voterJid }: PollVoteContext,
): Record<string, unknown> {
  const toBinary = (txt: string): Buffer => Buffer.from(txt);

  const sign = Buffer.concat([
    toBinary(pollMsgId),
    toBinary(pollCreatorJid),
    toBinary(voterJid),
    toBinary('Poll Vote'),
    new Uint8Array([1]),
  ]);

  const key0 = hmacSign(new Uint8Array(32), pollEncKey, 'sha256');
  const decKey = hmacSign(sign, key0, 'sha256');
  const aad = toBinary(`${pollMsgId} ${voterJid}`);

  const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
  const Proto = proto as Record<
    string,
    Record<string, { decode(b: Uint8Array): Record<string, unknown> }>
  >;
  return Proto.Message.PollVoteMessage.decode(decrypted);
}

/**
 * Decrypt an encrypted event response.
 *
 * Same algorithm as `decryptPollVote` but uses "Event Response" as
 * the domain separator in the HMAC key derivation.
 */
export function decryptEventResponse(
  { encPayload, encIv }: { encPayload: Uint8Array; encIv: Uint8Array },
  { eventCreatorJid, eventMsgId, eventEncKey, responderJid }: EventResponseContext,
): Record<string, unknown> {
  const toBinary = (txt: string): Buffer => Buffer.from(txt);

  const sign = Buffer.concat([
    toBinary(eventMsgId),
    toBinary(eventCreatorJid),
    toBinary(responderJid),
    toBinary('Event Response'),
    new Uint8Array([1]),
  ]);

  const key0 = hmacSign(new Uint8Array(32), eventEncKey, 'sha256');
  const decKey = hmacSign(sign, key0, 'sha256');
  const aad = toBinary(`${eventMsgId} ${responderJid}`);

  const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad);
  const Proto = proto as Record<
    string,
    Record<string, { decode(b: Uint8Array): Record<string, unknown> }>
  >;
  return Proto.Message.EventResponseMessage.decode(decrypted);
}

/**
 * Extract an encrypted poll vote from a decrypted message, if present.
 * Returns undefined for non-poll-update messages or unencrypted votes.
 */
export function extractEncryptedPollVote(
  content: Record<string, unknown> | null | undefined,
): { encPayload: Uint8Array; encIv: Uint8Array } | undefined {
  const pollUpdate = (content as Record<string, unknown> | undefined)?.pollUpdateMessage as
    | Record<string, unknown>
    | undefined;
  const vote = pollUpdate?.vote as { encPayload?: Uint8Array; encIv?: Uint8Array } | undefined;
  if (vote?.encPayload && vote?.encIv) {
    return { encPayload: vote.encPayload, encIv: vote.encIv };
  }
  return undefined;
}

/**
 * Extract an encrypted event response from a decrypted message, if present.
 */
export function extractEncryptedEventResponse(
  content: Record<string, unknown> | null | undefined,
):
  | { encPayload: Uint8Array; encIv: Uint8Array; eventCreationMessageKey?: Record<string, unknown> }
  | undefined {
  const enc = (content as Record<string, unknown> | undefined)?.encEventResponseMessage as
    | {
        encPayload?: Uint8Array;
        encIv?: Uint8Array;
        eventCreationMessageKey?: Record<string, unknown>;
      }
    | undefined;
  if (enc?.encPayload && enc?.encIv) {
    return {
      encPayload: enc.encPayload,
      encIv: enc.encIv,
      eventCreationMessageKey: enc.eventCreationMessageKey,
    };
  }
  return undefined;
}
