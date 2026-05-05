/**
 * Message relay — encrypts, builds stanzas, and sends messages over the
 * live connection.
 *
 * Ported from Baileys' `Socket/messages-send.js`.  Every function accepts
 * `sendNode` + `creds` + `signalRepository` as explicit arguments — no
 * `this`, no mutable socket state.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import {
  assertNodeErrorFree,
  getBinaryNodeChild,
  getBinaryNodeChildBuffer,
  getBinaryNodeChildUInt,
  getBinaryNodeChildren,
} from '../binary/index.js';
import type { BinaryNode } from '../binary/index.js';
import {
  S_WHATSAPP_NET,
  areJidsSameUser,
  isHostedLidUser,
  isHostedPnUser,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
} from '../binary/jid.js';
import { proto } from '../proto/index.js';
import type { SignalRepository } from '../signal/libsignal.js';
import type { AuthenticationCreds, AuthenticationState } from '../types/auth.js';
import type { AnyMessageContent, WAMessage } from '../types/message.js';
import { generateWAMessage } from './encode.js';

// ── Constants ──────────────────────────────────────────────────────────

const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60; // 7 days in seconds

// ── Types ──────────────────────────────────────────────────────────────

export interface DeviceInfo {
  user: string;
  device: number;
  domainType?: number;
  server?: string;
  jid: string;
}

export interface RelayParticipant {
  jid: string;
  count: number;
}

export interface RelayMessageOptions {
  messageId?: string;
  participant?: RelayParticipant;
  additionalAttributes?: Record<string, string>;
  additionalNodes?: BinaryNode[];
  useUserDevicesCache?: boolean;
  useCachedGroupMetadata?: boolean;
  statusJidList?: string[];
}

export interface SendMessageOptions {
  quoted?: WAMessage;
  ephemeralExpiration?: number;
  messageId?: string;
  timestamp?: Date;
  useCachedGroupMetadata?: boolean;
  statusJidList?: string[];
  backgroundColor?: string | number;
  font?: number;
}

export interface MessageRelay {
  sendMessage(
    jid: string,
    content: AnyMessageContent,
    options?: SendMessageOptions,
  ): Promise<WAMessage>;
  relayMessage(
    jid: string,
    message: Record<string, unknown>,
    options?: RelayMessageOptions,
  ): Promise<string>;
  createParticipantNodes(
    recipientJids: string[],
    message: Record<string, unknown>,
    extraAttrs?: Record<string, string>,
    dsmMessage?: Record<string, unknown>,
  ): Promise<{ nodes: BinaryNode[]; shouldIncludeDeviceIdentity: boolean }>;
  getUSyncDevices(
    jids: string[],
    useCache?: boolean,
    ignoreZeroDevices?: boolean,
  ): Promise<DeviceInfo[]>;
  sendReceipt(
    jid: string,
    participant: string | undefined,
    messageIds: string[],
    type: string,
  ): Promise<void>;
  readMessages(keys: Array<{ remoteJid?: string | null; id?: string | null }>): Promise<void>;
}

export interface MessageRelayConfig {
  sendNode: (node: BinaryNode) => Promise<void>;
  signalRepository: SignalRepository;
  auth: AuthenticationState;
  logger: Logger;
  query?: (node: BinaryNode) => Promise<BinaryNode>;
  cachedGroupMetadata?: (jid: string) => Promise<GroupMetadataMin | undefined>;
  patchMessageBeforeSending?: (
    msg: Record<string, unknown>,
    jids: string[],
  ) => Promise<
    Record<string, unknown> | Array<{ recipientJid: string; message: Record<string, unknown> }>
  >;
}

interface GroupMetadataMin {
  id: string;
  subject: string;
  participants: Array<{ id: string }>;
  ephemeralDuration?: number;
  addressingMode?: string;
}

// ── Internal helpers (ported from Baileys Utils) ──────────────────────

/** Unix timestamp in seconds. */
function unixTimestampSeconds(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

/** Pad message body with 1–16 random pad bytes (WhatsApp wire format). */
function writeRandomPadMax16(msg: Uint8Array): Buffer {
  const pad = randomBytes(1);
  const padLength = ((pad[0] ?? 0) & 0x0f) + 1;
  return Buffer.concat([msg, Buffer.alloc(padLength, padLength)]);
}

/** Encode a WebMessageInfo to wire bytes. */
function encodeWAMessage(message: Record<string, unknown>): Buffer {
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime
  const encoded = (proto as any).Message.encode(message).finish() as Uint8Array;
  return writeRandomPadMax16(encoded);
}

/** Generate a participant hash for the stanza (whatsmeow pattern). */
function generateParticipantHashV2(participants: string[]): string {
  const sorted = [...participants].sort();
  const hash = createHash('sha256').update(sorted.join('')).digest('base64');
  return `2:${hash.slice(0, 6)}`;
}

/** Detect the media type string from a proto.Message. */
function getMediaType(message: Record<string, unknown> | null | undefined): string {
  if (!message) return '';
  if (message.imageMessage) return 'image';
  if (message.videoMessage)
    return (message.videoMessage as Record<string, unknown>)?.gifPlayback ? 'gif' : 'video';
  if (message.audioMessage)
    return (message.audioMessage as Record<string, unknown>)?.ptt ? 'ptt' : 'audio';
  if (message.contactMessage) return 'vcard';
  if (message.documentMessage) return 'document';
  if (message.contactsArrayMessage) return 'contact_array';
  if (message.liveLocationMessage) return 'livelocation';
  if (message.stickerMessage) return 'sticker';
  if (message.listMessage) return 'list';
  if (message.listResponseMessage) return 'list_response';
  if (message.buttonsResponseMessage) return 'buttons_response';
  if (message.orderMessage) return 'order';
  if (message.productMessage) return 'product';
  if (message.interactiveResponseMessage) return 'native_flow_response';
  if (message.groupInviteMessage) return 'url';
  return '';
}

/** Determine the message stanza type attribute. */
function getMessageType(message: Record<string, unknown>): string {
  if (
    message.pollCreationMessage ||
    message.pollCreationMessageV2 ||
    message.pollCreationMessageV3
  ) {
    return 'poll';
  }
  if (message.eventMessage) return 'event';
  if (getMediaType(message) !== '') return 'media';
  return 'text';
}

/** Simple keyed mutex for per-JID encryption serialization. */
function makeKeyedMutex() {
  const map: Record<string, Promise<unknown>> = {};
  return {
    mutex<T>(key: string, task: () => Promise<T>): Promise<T> {
      if (!map[key]) {
        map[key] = Promise.resolve();
      }
      const p = map[key]?.then(
        () => task(),
        () => task(),
      );
      map[key] = p.catch(() => {});
      return p as Promise<T>;
    },
  };
}

// ── Factory ────────────────────────────────────────────────────────────

export function makeMessageRelay(config: MessageRelayConfig): MessageRelay {
  const {
    sendNode,
    signalRepository,
    auth,
    logger,
    query,
    cachedGroupMetadata,
    patchMessageBeforeSending,
  } = config;
  const creds = auth.creds;
  const keys = auth.keys;

  const encryptionMutex = makeKeyedMutex();

  // Simple in-memory device cache (5 min TTL)
  const deviceCache = new Map<string, { devices: DeviceInfo[]; ts: number }>();
  const DEVICE_CACHE_TTL_MS = 5 * 60 * 1000;

  // ── Device enumeration ────────────────────────────────────────────

  async function getUSyncDevices(
    jids: string[],
    useCache = true,
    ignoreZeroDevices = false,
  ): Promise<DeviceInfo[]> {
    const deviceResults: DeviceInfo[] = [];

    for (const jid of jids) {
      const decoded = jidDecode(jid);
      if (!decoded?.user) continue;

      const normalizedJid = jidNormalizedUser(jid);

      if (useCache) {
        const cached = deviceCache.get(normalizedJid);
        if (cached && Date.now() - cached.ts < DEVICE_CACHE_TTL_MS) {
          deviceResults.push(...cached.devices);
          continue;
        }
      }

      // If a specific device is requested, use it directly
      if (typeof decoded.device === 'number' && decoded.device >= 0) {
        deviceResults.push({ user: decoded.user, device: decoded.device, jid });
        continue;
      }

      // Try actual USync query if available
      if (query) {
        try {
          const result = await query({
            tag: 'iq',
            attrs: {
              to: S_WHATSAPP_NET,
              type: 'get',
              xmlns: 'usync',
            },
            content: [
              {
                tag: 'usync',
                attrs: { context: 'message', mode: 'query' },
                content: [
                  { tag: 'query', attrs: {}, content: [] as BinaryNode[] },
                  {
                    tag: 'list',
                    attrs: {},
                    content: [{ tag: 'user', attrs: {}, content: [{ tag: 'contact', attrs: {} }] }],
                  },
                  { tag: 'side_list', attrs: {} },
                ],
              },
            ],
          });

          // Extract device JIDs from USync result
          const usyncNode = getBinaryNodeChild(result, 'usync');
          const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined;
          const users = getBinaryNodeChildren(listNode ?? { tag: 'list', attrs: {} }, 'user');
          for (const userNode of users) {
            const userJid = userNode.attrs.jid;
            if (!userJid) continue;
            const dec = jidDecode(userJid);
            const devices = getBinaryNodeChildren(
              getBinaryNodeChild(userNode, 'devices') ?? { tag: 'devices', attrs: {} },
              'device',
            );
            for (const devNode of devices) {
              const deviceId = Number.parseInt(devNode.attrs['device-id'] ?? '0', 10);
              if (Number.isNaN(deviceId)) continue;
              if (ignoreZeroDevices && deviceId === 0) continue;
              deviceResults.push({
                user: dec?.user ?? userJid,
                device: deviceId,
                jid: jidEncode(dec?.user ?? userJid, dec?.server ?? 's.whatsapp.net', deviceId),
              });
            }
          }

          if (deviceResults.length > 0) {
            deviceCache.set(normalizedJid, { devices: [...deviceResults], ts: Date.now() });
          }
          continue;
        } catch (err) {
          logger.debug({ err, jid }, 'USync query failed, falling back to direct jid');
        }
      }

      // Fallback: treat the JID as a single device (device 0)
      const fallback: DeviceInfo = {
        user: decoded.user,
        device: 0,
        jid: jidEncode(decoded.user, decoded.server ?? 's.whatsapp.net', 0),
      };
      deviceResults.push(fallback);
      deviceCache.set(normalizedJid, { devices: [fallback], ts: Date.now() });
    }

    return deviceResults;
  }

  // ── Session assertion ──────────────────────────────────────────────

  async function assertSessions(jids: string[], force = false): Promise<boolean> {
    const uniqueJids = [...new Set(jids)];
    const jidsRequiringFetch: string[] = [];

    for (const jid of uniqueJids) {
      const validation = await signalRepository.validateSession(jid);
      if (!validation.exists || force) {
        jidsRequiringFetch.push(jid);
      }
    }

    if (jidsRequiringFetch.length && query) {
      logger.debug({ jidsRequiringFetch }, 'fetching sessions');
      const result = await query({
        tag: 'iq',
        attrs: {
          xmlns: 'encrypt',
          type: 'get',
          to: S_WHATSAPP_NET,
        },
        content: [
          {
            tag: 'key',
            attrs: {},
            content: jidsRequiringFetch.map((jid) => {
              const attrs: Record<string, string> = { jid };
              if (force) attrs.reason = 'identity';
              return { tag: 'user', attrs };
            }),
          },
        ],
      });

      await parseAndInjectE2ESessions(result, signalRepository);
      return true;
    }

    return false;
  }

  // ── Per-device encryption ─────────────────────────────────────────

  async function createParticipantNodes(
    recipientJids: string[],
    message: Record<string, unknown>,
    extraAttrs: Record<string, string> = {},
    dsmMessage?: Record<string, unknown>,
  ): Promise<{ nodes: BinaryNode[]; shouldIncludeDeviceIdentity: boolean }> {
    if (!recipientJids.length) {
      return { nodes: [], shouldIncludeDeviceIdentity: false };
    }

    const meId = creds.me?.id ?? '';
    const meLid = creds.me?.lid;

    let shouldIncludeDeviceIdentity = false;
    const patchedMessages = patchMessageBeforeSending
      ? await patchMessageBeforeSending(message, recipientJids)
      : recipientJids.map((jid) => ({ recipientJid: jid, message }));

    const msgArray = Array.isArray(patchedMessages)
      ? patchedMessages
      : recipientJids.map((jid) => ({ recipientJid: jid, message: patchedMessages }));

    const encryptionPromises = msgArray.map(async ({ recipientJid, message: patchedMessage }) => {
      if (!recipientJid) return null;

      let msgToEncrypt = patchedMessage;
      if (dsmMessage) {
        const { user: targetUser } = jidDecode(recipientJid) ?? { user: '' };
        const { user: ownPnUser } = jidDecode(meId) ?? { user: '' };
        const ownLidUser = meLid ? jidDecode(meLid)?.user : undefined;
        const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser);
        const isExactSenderDevice = recipientJid === meId || (meLid && recipientJid === meLid);
        if (isOwnUser && !isExactSenderDevice) {
          msgToEncrypt = dsmMessage;
          logger.debug({ jid: recipientJid, targetUser }, 'Using DSM for own device');
        }
      }

      const bytes = encodeWAMessage(msgToEncrypt);

      const node = await encryptionMutex.mutex(recipientJid, async () => {
        const { type, ciphertext } = await signalRepository.encryptMessage({
          jid: recipientJid,
          data: bytes,
        });
        if (type === 'pkmsg') {
          shouldIncludeDeviceIdentity = true;
        }
        return {
          tag: 'to' as const,
          attrs: { jid: recipientJid },
          content: [
            {
              tag: 'enc' as const,
              attrs: {
                v: '2',
                type,
                ...extraAttrs,
              },
              content: ciphertext,
            },
          ],
        } satisfies BinaryNode;
      });
      return node;
    });

    const resolved = await Promise.all(encryptionPromises);
    const nodes: BinaryNode[] = resolved.filter((n) => n !== null) as BinaryNode[];

    return { nodes, shouldIncludeDeviceIdentity };
  }

  // ── Core relay ─────────────────────────────────────────────────────

  async function relayMessage(
    jid: string,
    message: Record<string, unknown>,
    options: RelayMessageOptions = {},
  ): Promise<string> {
    const meId = creds.me?.id ?? '';
    const meLid = creds.me?.lid;

    let {
      messageId: msgId,
      participant,
      additionalAttributes = {},
      additionalNodes = [],
      useUserDevicesCache = true,
      useCachedGroupMetadata = true,
      statusJidList,
    } = options;

    const isRetryResend = Boolean(participant?.jid);
    let shouldIncludeDeviceIdentity = isRetryResend;

    const decoded = jidDecode(jid);
    const server = decoded?.server ?? '';
    const user = decoded?.user ?? '';
    const isGroup = server === 'g.us';
    const isStatus = jid === 'status@broadcast';
    const isLid = server === 'lid';
    const isGroupOrStatus = isGroup || isStatus;

    msgId = msgId ?? generateMessageID(); // fallback if no msgId provided
    const destinationJid = !isStatus ? jid : 'status@broadcast';
    const binaryNodeContent: BinaryNode[] = [];
    const devices: DeviceInfo[] = [];

    const meMsg: Record<string, unknown> = {
      deviceSentMessage: {
        destinationJid,
        message,
      },
      messageContextInfo: (message as { messageContextInfo?: unknown }).messageContextInfo,
    };

    const extraAttrs: Record<string, string> = {};

    if (participant) {
      if (!isGroup && !isStatus) {
        additionalAttributes = { ...additionalAttributes, device_fanout: 'false' };
      }
      const dec = jidDecode(participant.jid);
      devices.push({
        user: dec?.user ?? '',
        device: dec?.device ?? 0,
        jid: participant.jid,
      });
    }

    const mediaType = getMediaType(message);
    if (mediaType) {
      extraAttrs.mediatype = mediaType;
    }

    if (normalizeMessageContent(message)?.pinInChatMessage) {
      extraAttrs['decrypt-fail'] = 'hide';
    }

    // ── Group / Status path ───────────────────────────────────────
    if (isGroupOrStatus && !isRetryResend) {
      let groupData: GroupMetadataMin | undefined;
      if (useCachedGroupMetadata && cachedGroupMetadata) {
        groupData = await cachedGroupMetadata(jid);
      }

      // Fetch sender-key memory
      const senderKeyMemory = await keys.get('sender-key-memory', [jid]);
      const senderKeyMap: Record<string, boolean> = senderKeyMemory?.[jid] ?? {};

      const participantsList = groupData?.participants?.map((p) => p.id) ?? [];
      if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
        additionalAttributes = {
          ...additionalAttributes,
          expiration: groupData.ephemeralDuration.toString(),
        };
      }
      if (isStatus && statusJidList) {
        participantsList.push(...statusJidList);
      }

      const additionalDevices = await getUSyncDevices(
        participantsList,
        !!useUserDevicesCache,
        false,
      );
      devices.push(...additionalDevices);

      if (isGroup) {
        additionalAttributes = {
          ...additionalAttributes,
          addressing_mode: groupData?.addressingMode ?? 'lid',
        };
      }

      const bytes = encodeWAMessage(message);
      const groupAddressingMode =
        additionalAttributes.addressing_mode ?? groupData?.addressingMode ?? 'lid';
      const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId;

      const { ciphertext, senderKeyDistributionMessage } =
        await signalRepository.encryptGroupMessage({
          group: destinationJid,
          data: bytes,
          meId: groupSenderIdentity,
        });

      const senderKeyRecipients: string[] = [];
      for (const device of devices) {
        const deviceJid = device.jid;
        const hasKey = !!senderKeyMap[deviceJid];
        if (
          !hasKey &&
          !isHostedLidUser(deviceJid) &&
          !isHostedPnUser(deviceJid) &&
          device.device !== 99
        ) {
          senderKeyRecipients.push(deviceJid);
          senderKeyMap[deviceJid] = true;
        }
      }

      const participants: BinaryNode[] = [];
      if (senderKeyRecipients.length) {
        logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key');
        const senderKeyMsg = {
          senderKeyDistributionMessage: {
            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
            groupId: destinationJid,
          },
        };
        await assertSessions(senderKeyRecipients);
        const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs);
        shouldIncludeDeviceIdentity =
          shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
        participants.push(...result.nodes);
      }

      binaryNodeContent.push({
        tag: 'enc',
        attrs: { v: '2', type: 'skmsg', ...extraAttrs },
        content: ciphertext,
      });

      await keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });

      if (participants.length) {
        binaryNodeContent.push({
          tag: 'participants',
          attrs: {},
          content: participants,
        });
      }
    } else {
      // ── 1:1 / non-group path ────────────────────────────────────
      let ownId = meId;
      if (isLid && meLid) {
        ownId = meLid;
      }

      if (!isRetryResend) {
        const { user: ownUser } = jidDecode(ownId) ?? { user: '' };
        const targetUserServer = isLid ? 'lid' : 's.whatsapp.net';
        devices.push({
          user,
          device: 0,
          jid: jidEncode(user, targetUserServer, 0),
        });
        if (user !== ownUser) {
          const ownUserServer = isLid ? 'lid' : 's.whatsapp.net';
          const ownUserForAddressing =
            isLid && meLid ? jidDecode(meLid)?.user : jidDecode(meId)?.user;
          if (ownUserForAddressing) {
            devices.push({
              user: ownUserForAddressing,
              device: 0,
              jid: jidEncode(ownUserForAddressing, ownUserServer, 0),
            });
          }
        }

        if (additionalAttributes.category !== 'peer') {
          // Clear placeholders and enumerate actual devices
          devices.length = 0;
          const senderIdentity =
            isLid && meLid
              ? jidEncode(jidDecode(meLid)?.user ?? '', 'lid', undefined)
              : jidEncode(jidDecode(meId)?.user ?? '', 's.whatsapp.net', undefined);
          const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false);
          devices.push(...sessionDevices);
        }
      }

      const allRecipients: string[] = [];
      const meRecipients: string[] = [];
      const otherRecipients: string[] = [];

      const { user: mePnUser } = jidDecode(meId) ?? { user: '' };
      const { user: meLidUser } = meLid ? (jidDecode(meLid) ?? { user: '' }) : { user: '' };

      for (const { user: devUser, jid: devJid } of devices) {
        const isExactSenderDevice = devJid === meId || (meLid && devJid === meLid);
        if (isExactSenderDevice) {
          continue;
        }
        const isMe = devUser === mePnUser || devUser === meLidUser;
        if (isMe) {
          meRecipients.push(devJid);
        } else {
          otherRecipients.push(devJid);
        }
        allRecipients.push(devJid);
      }

      await assertSessions(allRecipients);

      const [
        { nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
        { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 },
      ] = await Promise.all([
        createParticipantNodes(meRecipients, meMsg, extraAttrs),
        createParticipantNodes(otherRecipients, message, extraAttrs, meMsg),
      ]);

      const allParticipantNodes = [...meNodes, ...otherNodes];
      if (meRecipients.length > 0 || otherRecipients.length > 0) {
        extraAttrs.phash = generateParticipantHashV2([...meRecipients, ...otherRecipients]);
      }
      shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;

      if (allParticipantNodes.length) {
        if (additionalAttributes?.category === 'peer') {
          const firstContent = allParticipantNodes[0]?.content;
          const peerNode = Array.isArray(firstContent) ? firstContent[0] : undefined;
          if (peerNode) {
            binaryNodeContent.push(peerNode);
          }
        } else {
          binaryNodeContent.push({
            tag: 'participants',
            attrs: {},
            content: allParticipantNodes,
          });
        }
      }
    }

    // ── Retry resend ───────────────────────────────────────────────
    if (isRetryResend && participant) {
      const isParticipantLid = isLidUser(participant.jid);
      const isMe = areJidsSameUser(participant.jid, isParticipantLid ? (meLid ?? meId) : meId);
      const encodedMessageToSend = isMe
        ? encodeWAMessage({
            deviceSentMessage: {
              destinationJid,
              message,
            },
          })
        : encodeWAMessage(message);
      const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({
        data: encodedMessageToSend,
        jid: participant.jid,
      });
      binaryNodeContent.push({
        tag: 'enc',
        attrs: {
          v: '2',
          type,
          count: participant.count.toString(),
        },
        content: encryptedContent,
      });
    }

    // ── Build and send stanza ──────────────────────────────────────
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        id: msgId,
        to: destinationJid,
        type: getMessageType(message),
        ...additionalAttributes,
      },
      content: binaryNodeContent,
    };

    if (participant) {
      if (isJidGroup(destinationJid)) {
        stanza.attrs.to = destinationJid;
        stanza.attrs.participant = participant.jid;
      } else if (areJidsSameUser(participant.jid, meId)) {
        stanza.attrs.to = participant.jid;
        stanza.attrs.recipient = destinationJid;
      } else {
        stanza.attrs.to = participant.jid;
      }
    }

    if (shouldIncludeDeviceIdentity && creds.account) {
      // Encode signed device identity for pkmsg recipients
      const deviceIdentityContent = encodeSignedDeviceIdentity(creds);
      if (deviceIdentityContent) {
        stanza.content = [
          ...(stanza.content as BinaryNode[]),
          {
            tag: 'device-identity',
            attrs: {},
            content: deviceIdentityContent,
          },
        ];
      }
    }

    // TC token for 1:1 chats (privacy)
    if (!isGroup && !isRetryResend && !isStatus) {
      const tcTokenData = await keys.get('tctoken', [destinationJid]);
      const tcTokenBuffer = tcTokenData?.[destinationJid]?.token;
      if (tcTokenBuffer) {
        stanza.content = [
          ...(stanza.content as BinaryNode[]),
          {
            tag: 'tctoken',
            attrs: {},
            content: tcTokenBuffer,
          },
        ];
      }
    }

    if (additionalNodes.length > 0) {
      stanza.content = [...(stanza.content as BinaryNode[]), ...additionalNodes];
    }

    logger.debug({ msgId }, `sending message to ${devices.length} devices`);
    await sendNode(stanza);

    return msgId;
  }

  // ── Top-level send ────────────────────────────────────────────────

  function normalizeMessageContent(
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

  async function sendMessage(
    jid: string,
    content: AnyMessageContent,
    options: SendMessageOptions = {},
  ): Promise<WAMessage> {
    const userJid = creds.me?.id ?? '';

    if (
      typeof content === 'object' &&
      'disappearingMessagesInChat' in content &&
      content.disappearingMessagesInChat !== undefined &&
      isJidGroup(jid)
    ) {
      // Group ephemeral setting change — handled separately
      const { disappearingMessagesInChat } = content as {
        disappearingMessagesInChat?: number | boolean;
      };
      const value =
        typeof disappearingMessagesInChat === 'boolean'
          ? disappearingMessagesInChat
            ? WA_DEFAULT_EPHEMERAL
            : 0
          : (disappearingMessagesInChat ?? 0);
      // Group ephemeral toggle is handled by groupToggleEphemeral later
      logger.debug({ jid, value }, 'group ephemeral setting (not yet wired)');
      // Fall through to generate the message
    }

    const fullMsg = await generateWAMessage(jid, content, {
      logger: logger as { warn?: (...args: unknown[]) => void },
      userJid,
      messageId: options.messageId,
      timestamp: options.timestamp,
      quoted: options.quoted,
      ephemeralExpiration: options.ephemeralExpiration,
      backgroundColor: options.backgroundColor,
      font: options.font,
      jid,
    });

    const isDeleteMsg = 'delete' in content && !!(content as { delete?: unknown }).delete;
    const isEditMsg = 'edit' in content && !!(content as { edit?: unknown }).edit;
    const isPollMessage = 'poll' in content && !!(content as { poll?: unknown }).poll;
    const isEventMsg = 'event' in content && !!(content as { event?: unknown }).event;

    const additionalAttributes: Record<string, string> = {};
    const additionalNodes: BinaryNode[] = [];

    if (isDeleteMsg) {
      const deleteContent = content as { delete?: { remoteJid?: string; fromMe?: boolean } };
      if (isJidGroup(deleteContent.delete?.remoteJid ?? '') && !deleteContent.delete?.fromMe) {
        additionalAttributes.edit = '8';
      } else {
        additionalAttributes.edit = '7';
      }
    } else if (isEditMsg) {
      additionalAttributes.edit = '1';
    } else if (isPollMessage) {
      additionalNodes.push({
        tag: 'meta',
        attrs: { polltype: 'creation' },
      });
    } else if (isEventMsg) {
      additionalNodes.push({
        tag: 'meta',
        attrs: { event_type: 'creation' },
      });
    }

    await relayMessage(jid, (fullMsg.message as Record<string, unknown>) ?? {}, {
      messageId: fullMsg.key.id ?? undefined,
      useCachedGroupMetadata: options.useCachedGroupMetadata,
      additionalAttributes,
      statusJidList: options.statusJidList,
      additionalNodes,
    });

    return fullMsg;
  }

  // ── Receipts ──────────────────────────────────────────────────────

  async function sendReceipt(
    jid: string,
    participant: string | undefined,
    messageIds: string[],
    type: string,
  ): Promise<void> {
    const firstId = messageIds[0];
    if (!firstId) return;

    const node: BinaryNode = {
      tag: 'receipt',
      attrs: {
        id: firstId,
      },
    };

    const isReadReceipt = type === 'read' || type === 'read-self';
    if (isReadReceipt) {
      node.attrs.t = unixTimestampSeconds().toString();
    }

    if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
      node.attrs.recipient = jid;
      if (participant) node.attrs.to = participant;
    } else {
      node.attrs.to = jid;
      if (participant) {
        node.attrs.participant = participant;
      }
    }

    if (type) {
      node.attrs.type = type;
    }

    const remainingIds = messageIds.slice(1);
    if (remainingIds.length) {
      node.content = [
        {
          tag: 'list',
          attrs: {},
          content: remainingIds.map((id) => ({
            tag: 'item' as const,
            attrs: { id },
          })),
        },
      ];
    }

    logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt');
    await sendNode(node);
  }

  async function readMessages(
    keys: Array<{ remoteJid?: string | null; id?: string | null }>,
  ): Promise<void> {
    const recps = aggregateMessageKeysNotFromMe(keys);
    for (const { jid, participant, messageIds } of recps) {
      await sendReceipt(jid, participant, messageIds, 'read');
    }
  }

  return {
    sendMessage,
    relayMessage,
    createParticipantNodes,
    getUSyncDevices,
    sendReceipt,
    readMessages,
  };
}

// ── Standalone helpers ─────────────────────────────────────────────────

/** Generate a message ID (fallback when userId is not needed). */
function generateMessageID(): string {
  const data = Buffer.alloc(8 + 20 + 16);
  data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  data.write('nexawhats', 8);
  randomBytes(16).copy(data, 8 + 9);
  return `3EB0${data.toString('base64url')}`;
}

/**
 * Encode signed device identity for pkmsg recipients.
 *
 * Simplified version — the full Baileys implementation uses the account
 * signature key. Returns null when creds.account is not available.
 */
function encodeSignedDeviceIdentity(creds: AuthenticationCreds): Buffer | null {
  if (!creds.account) return null;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: proto runtime
    const details = (proto as any).ADVDeviceIdentity.create({
      compiler: 1,
      primaryDeviceVersion:
        ((creds.account.details as Record<string, unknown> | undefined)?.primaryDeviceVersion as
          | number
          | undefined) ?? 0,
      receiverDeviceId: 0,
    });
    // biome-ignore lint/suspicious/noExplicitAny: proto runtime
    const encoded = (proto as any).ADVDeviceIdentity.encode(details).finish() as Uint8Array;
    // For now: return raw encoded identity — full signing needs account.signKey
    return Buffer.from(encoded);
  } catch {
    return null;
  }
}

/**
 * Parse E2E session injection from an IQ response.
 *
 * Ported from Baileys `Utils/signal.js` parseAndInjectE2ESessions.
 */
async function parseAndInjectE2ESessions(
  node: BinaryNode,
  repository: SignalRepository,
): Promise<void> {
  const listChild = getBinaryNodeChild(node, 'list');
  const users = listChild ? getBinaryNodeChildren(listChild, 'user') : [];

  for (const userNode of users) {
    assertNodeErrorFree(userNode);
  }

  const chunkSize = 100;
  for (let i = 0; i < users.length; i += chunkSize) {
    const chunk = users.slice(i, i + chunkSize);
    for (const user of chunk) {
      const jid = user.attrs.jid;
      if (!jid) continue;
      const registrationId = getBinaryNodeChildUInt(user, 'registration', 4) ?? 0;
      const identity = getBinaryNodeChildBuffer(user, 'identity') ?? new Uint8Array();
      const signedKey = getBinaryNodeChild(user, 'skey');
      const key = getBinaryNodeChild(user, 'key');

      const extractKey = (k: BinaryNode | undefined) => {
        if (!k) return undefined;
        return {
          keyId: getBinaryNodeChildUInt(k, 'id', 3) ?? 0,
          publicKey: getBinaryNodeChildBuffer(k, 'value') ?? new Uint8Array(),
          signature: getBinaryNodeChildBuffer(k, 'signature') ?? new Uint8Array(),
        };
      };

      await repository.injectE2ESession({
        jid,
        session: {
          registrationId,
          identityKey: identity,
          signedPreKey: extractKey(signedKey) ?? {
            keyId: 0,
            publicKey: new Uint8Array(),
            signature: new Uint8Array(),
          },
          preKey: extractKey(key) ?? { keyId: 0, publicKey: new Uint8Array() },
        },
      });
    }
  }
}

/**
 * Aggregate message keys by JID+participant for bulk receipts.
 */
interface ReceiptRecipient {
  jid: string;
  participant?: string;
  messageIds: string[];
}

function aggregateMessageKeysNotFromMe(
  keys: Array<{
    remoteJid?: string | null;
    id?: string | null;
    participant?: string | null;
    fromMe?: boolean | null;
  }>,
): ReceiptRecipient[] {
  const map = new Map<string, ReceiptRecipient>();
  for (const key of keys) {
    if (key.fromMe || !key.remoteJid || !key.id) continue;
    const mapKey = `${key.remoteJid}_${key.participant ?? ''}`;
    const existing = map.get(mapKey);
    if (existing) {
      existing.messageIds.push(key.id);
    } else {
      map.set(mapKey, {
        jid: key.remoteJid,
        participant: key.participant ?? undefined,
        messageIds: [key.id],
      });
    }
  }
  return [...map.values()];
}
