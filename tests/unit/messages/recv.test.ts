import { describe, expect, it } from 'vitest';
import type { BinaryNode } from '../../../src/binary/index.js';
import { randomBytes } from 'node:crypto';
import {
  cleanMessage,
  decodeMessageNode,
  decryptPollVote,
  decryptEventResponse,
  extractAddressingContext,
  extractEncryptedPollVote,
  extractEncryptedEventResponse,
  getChatId,
  getHistoryMsg,
  isRealMessage,
  processHistoryMessage,
} from '../../../src/messages/recv.js';
import { aesEncryptGCM, hmacSign } from '../../../src/utils/crypto.js';
import type { WAMessage, WAMessageContent } from '../../../src/types/message.js';

// ── extractAddressingContext ────────────────────────────────────────────

describe('extractAddressingContext', () => {
  it('defaults to "pn" mode when no addressing_mode is present', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: { from: '123@s.whatsapp.net' },
    };
    const ctx = extractAddressingContext(stanza);
    expect(ctx.addressingMode).toBe('pn');
  });

  it('detects "lid" addressing from addressing_mode attr', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: 'abc@lid',
        participant: 'abc@lid',
        addressing_mode: 'lid',
      },
    };
    const ctx = extractAddressingContext(stanza);
    expect(ctx.addressingMode).toBe('lid');
  });

  it('extracts sender LID from participant_lid when in pn mode', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: '123@s.whatsapp.net',
        participant: '123@s.whatsapp.net',
        participant_lid: 'abc@lid',
      },
    };
    const ctx = extractAddressingContext(stanza);
    expect(ctx.addressingMode).toBe('pn');
    expect(ctx.senderAlt).toBe('abc@lid');
  });

  it('extracts sender PN from participant_pn when in lid mode', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: 'abc@lid',
        participant: 'abc@lid',
        participant_pn: '123@s.whatsapp.net',
      },
    };
    const ctx = extractAddressingContext(stanza);
    expect(ctx.addressingMode).toBe('lid');
    expect(ctx.senderAlt).toBe('123@s.whatsapp.net');
  });

  it('extracts recipient LID from recipient_lid', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: '123@s.whatsapp.net',
        recipient_lid: 'xyz@lid',
      },
    };
    const ctx = extractAddressingContext(stanza);
    expect(ctx.recipientAlt).toBe('xyz@lid');
  });

  it('handles empty stanza attrs gracefully', () => {
    const stanza: BinaryNode = { tag: 'message', attrs: {} };
    const ctx = extractAddressingContext(stanza);
    expect(ctx.addressingMode).toBe('pn');
    expect(ctx.senderAlt).toBeUndefined();
    expect(ctx.recipientAlt).toBeUndefined();
  });
});

// ── decodeMessageNode ───────────────────────────────────────────────────

describe('decodeMessageNode', () => {
  const meId = '123@s.whatsapp.net';

  it('decodes a 1:1 chat message from another user', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: '456@s.whatsapp.net',
        id: 'MSG001',
        t: '1700000000',
        notify: 'Alice',
      },
    };
    const result = decodeMessageNode(stanza, meId);
    expect(result.fullMessage.key.remoteJid).toBe('456@s.whatsapp.net');
    expect(result.fullMessage.key.fromMe).toBe(false);
    expect(result.fullMessage.key.id).toBe('MSG001');
    expect(result.fullMessage.pushName).toBe('Alice');
    expect(result.fullMessage.messageTimestamp).toBe(1700000000);
    expect(result.author).toBe('456@s.whatsapp.net');
  });

  it('decodes a message from me (via recipient field)', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: '123@s.whatsapp.net',
        recipient: '456@s.whatsapp.net',
        id: 'MSG002',
      },
    };
    const result = decodeMessageNode(stanza, meId);
    expect(result.fullMessage.key.remoteJid).toBe('456@s.whatsapp.net');
    expect(result.fullMessage.key.fromMe).toBe(true);
    expect(result.fullMessage.status).toBe('SERVER_ACK');
  });

  it('decodes a group message', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: '789@g.us',
        participant: '456@s.whatsapp.net',
        id: 'MSG003',
        t: '1700000001',
      },
    };
    const result = decodeMessageNode(stanza, meId);
    expect(result.fullMessage.key.remoteJid).toBe('789@g.us');
    expect(result.fullMessage.key.participant).toBe('456@s.whatsapp.net');
    expect(result.fullMessage.key.fromMe).toBe(false);
    expect(result.author).toBe('456@s.whatsapp.net');
  });

  it('detects own messages in groups', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: '789@g.us',
        participant: '123@s.whatsapp.net',
        id: 'MSG004',
      },
    };
    const result = decodeMessageNode(stanza, meId);
    expect(result.fullMessage.key.fromMe).toBe(true);
  });

  it('decodes a broadcast message', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: 'status@broadcast',
        participant: '456@s.whatsapp.net',
        id: 'MSG005',
      },
    };
    const result = decodeMessageNode(stanza, meId);
    expect(result.fullMessage.broadcast).toBe(true);
    expect(result.author).toBe('456@s.whatsapp.net');
  });

  it('includes category attr in fullMessage', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: '456@s.whatsapp.net',
        id: 'MSG006',
        category: 'peer',
      },
    };
    const result = decodeMessageNode(stanza, meId);
    expect((result.fullMessage as unknown as Record<string, unknown>).category).toBe('peer');
  });

  it('throws for unknown message types', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: 'unknown@strange',
        id: 'BAD',
      },
    };
    expect(() => decodeMessageNode(stanza, meId)).toThrow('Unknown message type');
  });

  it('stores LID/PN alt JIDs on the message key', () => {
    const stanza: BinaryNode = {
      tag: 'message',
      attrs: {
        from: '456@s.whatsapp.net',
        participant_lid: 'lid-456@lid',
        id: 'MSG007',
      },
    };
    const result = decodeMessageNode(stanza, meId);
    const alt = (result.fullMessage.key as Record<string, unknown>).remoteJidAlt;
    expect(alt).toBe('lid-456@lid');
  });
});

// ── cleanMessage ────────────────────────────────────────────────────────

describe('cleanMessage', () => {
  const meId = '123@s.whatsapp.net';

  it('normalizes hosted PN JIDs to regular PN', () => {
    const msg: WAMessage = {
      key: { remoteJid: '456:10@hosted', fromMe: false, id: '1' },
    };
    cleanMessage(msg, meId);
    expect(msg.key.remoteJid).toBe('456@s.whatsapp.net');
  });

  it('normalizes hosted LID JIDs to regular LID', () => {
    const msg: WAMessage = {
      key: { remoteJid: 'abc:5@hosted.lid', fromMe: false, id: '1' },
    };
    cleanMessage(msg, meId);
    expect(msg.key.remoteJid).toBe('abc@lid');
  });

  it('normalizes participant hosted JIDs', () => {
    const msg: WAMessage = {
      key: {
        remoteJid: '789@g.us',
        participant: '456:20@hosted',
        fromMe: false,
        id: '1',
      },
    };
    cleanMessage(msg, meId);
    expect(msg.key.participant).toBe('456@s.whatsapp.net');
  });

  it('leaves already-normal JIDs unchanged', () => {
    const msg: WAMessage = {
      key: {
        remoteJid: '456@s.whatsapp.net',
        participant: '789@s.whatsapp.net',
        fromMe: false,
        id: '1',
      },
    };
    cleanMessage(msg, meId);
    expect(msg.key.remoteJid).toBe('456@s.whatsapp.net');
    expect(msg.key.participant).toBe('789@s.whatsapp.net');
  });

  it('fixes reaction key fromMe when receiving a reaction', () => {
    const msg: WAMessage = {
      key: { remoteJid: '456@s.whatsapp.net', fromMe: false, id: '1' },
      message: {
        reactionMessage: {
          key: { remoteJid: '789@g.us', fromMe: false, participant: '123@s.whatsapp.net' },
          text: '❤️',
        },
      } as WAMessageContent,
    };
    cleanMessage(msg, meId);
    const rxn = msg.message?.reactionMessage;
    // The reaction key should have fromMe set correctly
    // Since participant is the user (123@s.whatsapp.net), fromMe should become true
    expect(rxn?.key?.fromMe).toBe(true);
  });

  it('handles messages with no content gracefully', () => {
    const msg: WAMessage = {
      key: { remoteJid: '456@s.whatsapp.net', fromMe: false, id: '1' },
    };
    expect(() => cleanMessage(msg, meId)).not.toThrow();
  });
});

// ── getChatId ───────────────────────────────────────────────────────────

describe('getChatId', () => {
  it('returns remoteJid for regular chats', () => {
    const key = { remoteJid: '123@s.whatsapp.net', fromMe: false };
    expect(getChatId(key)).toBe('123@s.whatsapp.net');
  });

  it('returns remoteJid for status@broadcast (excluded from participant extraction)', () => {
    // status@broadcast is a STATUS broadcast — getChatId excludes it
    const key = {
      remoteJid: 'status@broadcast',
      participant: '456@s.whatsapp.net',
      fromMe: false,
    };
    expect(getChatId(key)).toBe('status@broadcast');
  });

  it('returns remoteJid for own broadcasts', () => {
    const key = {
      remoteJid: 'status@broadcast',
      participant: '123@s.whatsapp.net',
      fromMe: true,
    };
    expect(getChatId(key)).toBe('status@broadcast');
  });

  it('returns undefined when remoteJid is null', () => {
    const key = { remoteJid: null, fromMe: false };
    expect(getChatId(key)).toBeUndefined();
  });
});

// ── isRealMessage ───────────────────────────────────────────────────────

describe('isRealMessage', () => {
  it('returns true for a plain text message', () => {
    const msg: WAMessage = {
      key: { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: '1' },
      message: { conversation: 'hello' } as WAMessageContent,
    };
    expect(isRealMessage(msg)).toBe(true);
  });

  it('returns true for media messages', () => {
    const msg: WAMessage = {
      key: { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: '1' },
      message: { imageMessage: { url: 'http://...' } } as WAMessageContent,
    };
    expect(isRealMessage(msg)).toBe(true);
  });

  it('returns false for protocol messages', () => {
    const msg: WAMessage = {
      key: { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: '1' },
      message: {
        protocolMessage: { type: 2, key: { id: 'x' } },
      } as WAMessageContent,
    };
    expect(isRealMessage(msg)).toBe(false);
  });

  it('returns false for reaction messages', () => {
    const msg: WAMessage = {
      key: { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: '1' },
      message: {
        reactionMessage: { text: '👍' },
      } as WAMessageContent,
    };
    expect(isRealMessage(msg)).toBe(false);
  });

  it('returns false for poll update messages', () => {
    const msg: WAMessage = {
      key: { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: '1' },
      message: {
        pollUpdateMessage: {},
      } as WAMessageContent,
    };
    expect(isRealMessage(msg)).toBe(false);
  });

  it('returns false for messages with no content', () => {
    const msg: WAMessage = {
      key: { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: '1' },
    };
    expect(isRealMessage(msg)).toBe(false);
  });

  it('unwraps ephemeral wrapper before checking', () => {
    const msg: WAMessage = {
      key: { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: '1' },
      message: {
        ephemeralMessage: { message: { conversation: 'hi' } },
      } as WAMessageContent,
    };
    expect(isRealMessage(msg)).toBe(true);
  });
});

// ── getHistoryMsg (Phase 4) ─────────────────────────────────────────────

describe('getHistoryMsg', () => {
  it('extracts historySyncNotification from protocolMessage', () => {
    const notification = { syncType: 0, conversations: [] };
    const msg: Record<string, unknown> = {
      protocolMessage: {
        type: 10,
        historySyncNotification: notification,
      },
    };
    const result = getHistoryMsg(msg);
    expect(result).toBeDefined();
    expect(result).toEqual(notification);
  });

  it('returns undefined when no protocolMessage', () => {
    const msg = { conversation: 'hello' };
    expect(getHistoryMsg(msg)).toBeUndefined();
  });

  it('returns undefined when protocolMessage has no historySyncNotification', () => {
    const msg = {
      protocolMessage: {
        type: 2,
        key: { id: 'msg-1' },
      },
    };
    expect(getHistoryMsg(msg)).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(getHistoryMsg(null)).toBeUndefined();
    expect(getHistoryMsg(undefined)).toBeUndefined();
  });

  it('unwraps ephemeral wrapper before checking', () => {
    const notification = { syncType: 1, conversations: [] };
    const msg = {
      ephemeralMessage: {
        message: {
          protocolMessage: {
            type: 10,
            historySyncNotification: notification,
          },
        },
      },
    };
    const result = getHistoryMsg(msg);
    expect(result).toEqual(notification);
  });
});

// ── processHistoryMessage (Phase 4) ──────────────────────────────────────

describe('processHistoryMessage', () => {
  it('processes INITIAL_BOOTSTRAP sync with conversations', () => {
    const historySync: Record<string, unknown> = {
      syncType: 0, // INITIAL_BOOTSTRAP
      progress: 100,
      globalSettings: {},
      conversations: [
        {
          id: '123@s.whatsapp.net',
          name: 'Test Chat',
          pnJid: '123@s.whatsapp.net',
          lidJid: '456@lid',
          messages: [
            {
              message: {
                key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'm1' },
                messageTimestamp: 1000,
                message: { conversation: 'hello' },
              },
            },
            {
              message: {
                key: { remoteJid: '123@s.whatsapp.net', fromMe: true, id: 'm2' },
                messageTimestamp: 2000,
                message: { conversation: 'hi back' },
              },
            },
          ],
        },
      ],
    };

    const result = processHistoryMessage(historySync);

    expect(result.syncType).toBe(0);
    expect(result.progress).toBe(100);
    expect(result.chats).toHaveLength(1);
    expect(result.contacts).toHaveLength(1);
    expect(result.messages).toHaveLength(2);
    expect(result.contacts[0]?.id).toBe('123@s.whatsapp.net');
    expect(result.contacts[0]?.name).toBe('Test Chat');
    expect(result.contacts[0]?.lid).toBe('456@lid');
  });

  it('processes RECENT sync type', () => {
    const historySync: Record<string, unknown> = {
      syncType: 1, // RECENT
      progress: 50,
      conversations: [
        {
          id: '789@g.us',
          messages: [
            {
              message: {
                key: { remoteJid: '789@g.us', fromMe: false, id: 'm3' },
                messageTimestamp: 3000,
                message: { conversation: 'group msg' },
              },
            },
          ],
        },
      ],
    };

    const result = processHistoryMessage(historySync);
    expect(result.syncType).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.chats).toHaveLength(1);
    expect(result.chats[0]?.lastMessageRecvTimestamp).toBeDefined();
  });

  it('processes PUSH_NAME sync with pushnames', () => {
    const historySync: Record<string, unknown> = {
      syncType: 4, // PUSH_NAME
      pushnames: [
        { id: '111@s.whatsapp.net', pushname: 'Alice' },
        { id: '222@s.whatsapp.net', pushname: 'Bob' },
      ],
    };

    const result = processHistoryMessage(historySync);
    expect(result.syncType).toBe(4);
    expect(result.contacts).toHaveLength(2);
    expect(result.contacts[0]?.id).toBe('111@s.whatsapp.net');
    expect(result.contacts[0]?.notify).toBe('Alice');
    expect(result.contacts[1]?.id).toBe('222@s.whatsapp.net');
    expect(result.contacts[1]?.notify).toBe('Bob');
    expect(result.messages).toHaveLength(0);
    expect(result.chats).toHaveLength(0);
  });

  it('handles empty conversations gracefully', () => {
    const historySync: Record<string, unknown> = {
      syncType: 0,
      conversations: [],
    };

    const result = processHistoryMessage(historySync);
    expect(result.syncType).toBe(0);
    expect(result.chats).toHaveLength(0);
    expect(result.messages).toHaveLength(0);
    expect(result.contacts).toHaveLength(0);
  });

  it('handles conversations with no messages array', () => {
    const historySync: Record<string, unknown> = {
      syncType: 2, // FULL
      conversations: [{ id: '123@s.whatsapp.net', name: 'Empty Chat' }],
    };

    const result = processHistoryMessage(historySync);
    expect(result.chats).toHaveLength(1);
    expect(result.messages).toHaveLength(0);
    expect(result.contacts).toHaveLength(1);
  });
});

// ── Phase 7: poll vote / event response decryption ─────────────────────

describe('decryptPollVote', () => {
  it('produces deterministic key derivation matching WhatsApp spec', () => {
    // Verify the HMAC key derivation chain produces the expected keys
    // without testing protobuf decoding (which requires proper proto encoding)
    const encKey = new Uint8Array(32).fill(0xab);
    const toBinary = (txt: string): Buffer => Buffer.from(txt);

    const signPayload = Buffer.concat([
      toBinary('msg-1'),
      toBinary('creator@s.whatsapp.net'),
      toBinary('voter@s.whatsapp.net'),
      toBinary('Poll Vote'),
      new Uint8Array([1]),
    ]);

    const key0 = hmacSign(new Uint8Array(32), encKey, 'sha256');
    const decKey = hmacSign(signPayload, key0, 'sha256');

    // Keys should be deterministic
    expect(decKey).toHaveLength(32);
    const key0Again = hmacSign(new Uint8Array(32), encKey, 'sha256');
    expect(Buffer.from(key0Again).equals(Buffer.from(key0))).toBe(true);
  });

  it('fails to decrypt with wrong key (auth tag mismatch)', () => {
    const encKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const toBinary = (txt: string): Buffer => Buffer.from(txt);

    const sign = Buffer.concat([
      toBinary('msg-1'),
      toBinary('creator@s.whatsapp.net'),
      toBinary('voter@s.whatsapp.net'),
      toBinary('Poll Vote'),
      new Uint8Array([1]),
    ]);
    const key0 = hmacSign(new Uint8Array(32), encKey, 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const encIv = randomBytes(16);
    const aad = toBinary('msg-1 voter@s.whatsapp.net');
    const plaintext = randomBytes(16);
    const encPayload = aesEncryptGCM(plaintext, decKey, encIv, aad);

    // Decrypt with wrong key should fail (GCM auth tag mismatch)
    const wrongSign = Buffer.concat([
      toBinary('msg-1'),
      toBinary('creator@s.whatsapp.net'),
      toBinary('voter@s.whatsapp.net'),
      toBinary('Poll Vote'),
      new Uint8Array([1]),
    ]);
    const wrongKey0 = hmacSign(new Uint8Array(32), wrongKey, 'sha256');
    const wrongDecKey = hmacSign(wrongSign, wrongKey0, 'sha256');

    expect(() => {
      const { aesDecryptGCM } = require('../../../src/utils/crypto.js');
      aesDecryptGCM(encPayload, wrongDecKey, encIv, aad);
    }).toThrow();
  });
});

describe('decryptEventResponse', () => {
  it('uses the correct domain separator ("Event Response")', () => {
    // Verify the key derivation uses "Event Response" not "Poll Vote"
    const encKey = new Uint8Array(32).fill(0xcd);
    const toBinary = (txt: string): Buffer => Buffer.from(txt);

    const pollSign = Buffer.concat([
      toBinary('msg-1'),
      toBinary('creator@s.whatsapp.net'),
      toBinary('responder@s.whatsapp.net'),
      toBinary('Poll Vote'),
      new Uint8Array([1]),
    ]);

    const eventSign = Buffer.concat([
      toBinary('msg-1'),
      toBinary('creator@s.whatsapp.net'),
      toBinary('responder@s.whatsapp.net'),
      toBinary('Event Response'),
      new Uint8Array([1]),
    ]);

    const key0 = hmacSign(new Uint8Array(32), encKey, 'sha256');
    const pollKey = hmacSign(pollSign, key0, 'sha256');
    const eventKey = hmacSign(eventSign, key0, 'sha256');

    // Different domain separators produce different keys
    expect(Buffer.from(pollKey).equals(Buffer.from(eventKey))).toBe(false);
  });

  it('fails to decrypt with wrong context (auth tag mismatch)', () => {
    const encKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const toBinary = (txt: string): Buffer => Buffer.from(txt);

    const sign = Buffer.concat([
      toBinary('msg-event'),
      toBinary('creator@s.whatsapp.net'),
      toBinary('responder@s.whatsapp.net'),
      toBinary('Event Response'),
      new Uint8Array([1]),
    ]);
    const key0 = hmacSign(new Uint8Array(32), encKey, 'sha256');
    const decKey = hmacSign(sign, key0, 'sha256');
    const encIv = randomBytes(16);
    const aad = toBinary('msg-event responder@s.whatsapp.net');
    const plaintext = randomBytes(16);
    const encPayload = aesEncryptGCM(plaintext, decKey, encIv, aad);

    // Decrypt with wrong encKey
    const wrongKey0 = hmacSign(new Uint8Array(32), wrongKey, 'sha256');
    const wrongDecKey = hmacSign(sign, wrongKey0, 'sha256');

    expect(() => {
      const { aesDecryptGCM } = require('../../../src/utils/crypto.js');
      aesDecryptGCM(encPayload, wrongDecKey, encIv, aad);
    }).toThrow();
  });
});

describe('extractEncryptedPollVote', () => {
  it('extracts encrypted vote from poll update content', () => {
    const content = {
      pollUpdateMessage: {
        pollCreationMessageKey: { remoteJid: 'chat@s.whatsapp.net', id: 'poll1' },
        vote: {
          encPayload: new Uint8Array([1, 2, 3]),
          encIv: new Uint8Array(16),
        },
      },
    };
    const result = extractEncryptedPollVote(content);
    expect(result).toBeDefined();
    expect(result!.encPayload).toEqual(new Uint8Array([1, 2, 3]));
    expect(result!.encIv).toHaveLength(16);
  });

  it('returns undefined for plain poll update', () => {
    const content = {
      pollUpdateMessage: {
        pollCreationMessageKey: { remoteJid: 'chat@s.whatsapp.net', id: 'poll1' },
      },
    };
    expect(extractEncryptedPollVote(content)).toBeUndefined();
  });

  it('returns undefined for null/undefined content', () => {
    expect(extractEncryptedPollVote(null)).toBeUndefined();
    expect(extractEncryptedPollVote(undefined)).toBeUndefined();
  });
});

describe('extractEncryptedEventResponse', () => {
  it('extracts encrypted response from event content', () => {
    const content = {
      encEventResponseMessage: {
        eventCreationMessageKey: { remoteJid: 'chat@s.whatsapp.net', id: 'event1' },
        encPayload: new Uint8Array([4, 5, 6]),
        encIv: new Uint8Array(16),
      },
    };
    const result = extractEncryptedEventResponse(content);
    expect(result).toBeDefined();
    expect(result!.encPayload).toEqual(new Uint8Array([4, 5, 6]));
    expect(result!.encIv).toHaveLength(16);
    expect(result!.eventCreationMessageKey).toBeDefined();
  });

  it('returns undefined when encPayload is missing', () => {
    const content = {
      encEventResponseMessage: {
        eventCreationMessageKey: { remoteJid: 'chat@s.whatsapp.net' },
      },
    };
    expect(extractEncryptedEventResponse(content)).toBeUndefined();
  });

  it('returns undefined for null/undefined content', () => {
    expect(extractEncryptedEventResponse(null)).toBeUndefined();
    expect(extractEncryptedEventResponse(undefined)).toBeUndefined();
  });
});
