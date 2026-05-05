import { describe, expect, it } from 'vitest';
import type { BinaryNode } from '../../../src/binary/index.js';
import {
  cleanMessage,
  decodeMessageNode,
  extractAddressingContext,
  getChatId,
  isRealMessage,
} from '../../../src/messages/recv.js';
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
