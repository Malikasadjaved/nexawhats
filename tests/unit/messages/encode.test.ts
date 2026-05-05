import { describe, expect, it } from 'vitest';
import {
  generateWAMessageContent,
  generateWAMessageFromContent,
  getContentType,
  normalizeMessageContent,
} from '../../../src/messages/encode.js';
import type { AnyMessageContent, WAMessage, WAMessageContent } from '../../../src/types/message.js';

// ── getContentType ──────────────────────────────────────────────────────

describe('getContentType', () => {
  it('returns "conversation" for plain text', () => {
    expect(getContentType({ conversation: 'hello' })).toBe('conversation');
  });

  it('returns "extendedTextMessage" for extended text', () => {
    expect(getContentType({ extendedTextMessage: { text: 'hi' } })).toBe('extendedTextMessage');
  });

  it('returns "imageMessage" for images', () => {
    expect(getContentType({ imageMessage: { url: 'x' } })).toBe('imageMessage');
  });

  it('skips "senderKeyDistributionMessage"', () => {
    expect(
      getContentType({
        senderKeyDistributionMessage: { groupId: 'g' },
        conversation: 'hi',
      }),
    ).toBe('conversation');
  });

  it('returns undefined for null/undefined/empty', () => {
    expect(getContentType(null)).toBeUndefined();
    expect(getContentType(undefined)).toBeUndefined();
    expect(getContentType({})).toBeUndefined();
  });

  it('detects video/audio/document/sticker message types', () => {
    expect(getContentType({ videoMessage: {} })).toBe('videoMessage');
    expect(getContentType({ audioMessage: {} })).toBe('audioMessage');
    expect(getContentType({ documentMessage: {} })).toBe('documentMessage');
    expect(getContentType({ stickerMessage: {} })).toBe('stickerMessage');
  });
});

// ── normalizeMessageContent ─────────────────────────────────────────────

describe('normalizeMessageContent', () => {
  it('returns undefined for falsy input', () => {
    expect(normalizeMessageContent(null)).toBeUndefined();
    expect(normalizeMessageContent(undefined)).toBeUndefined();
  });

  it('passes through plain content unchanged', () => {
    const content = { conversation: 'hi' };
    expect(normalizeMessageContent(content)).toEqual(content);
  });

  it('unwraps a single ephemeralMessage layer', () => {
    const inner = { conversation: 'secret' };
    const wrapped = { ephemeralMessage: { message: inner } };
    expect(normalizeMessageContent(wrapped)).toEqual(inner);
  });

  it('unwraps viewOnceMessage layer', () => {
    const inner = { imageMessage: { url: 'x' } };
    const wrapped = { viewOnceMessage: { message: inner } };
    expect(normalizeMessageContent(wrapped)).toEqual(inner);
  });

  it('unwraps viewOnceMessageV2 layer', () => {
    const inner = { videoMessage: {} };
    const wrapped = { viewOnceMessageV2: { message: inner } };
    expect(normalizeMessageContent(wrapped)).toEqual(inner);
  });

  it('unwraps editedMessage layer', () => {
    const inner = { conversation: 'edited text' };
    const wrapped = { editedMessage: { message: inner } };
    expect(normalizeMessageContent(wrapped)).toEqual(inner);
  });

  it('unwraps nested wrappers (ephemeral → viewOnce → inner)', () => {
    const inner = { conversation: 'deep' };
    const wrapped = {
      ephemeralMessage: {
        message: { viewOnceMessage: { message: inner } },
      },
    };
    expect(normalizeMessageContent(wrapped)).toEqual(inner);
  });

  it('stops after 5 iterations (safety cap)', () => {
    // Build 6 layers — should only unwrap 5
    // biome-ignore lint/suspicious/noExplicitAny: constructing deep wrapper
    let content: any = { conversation: 'bottom' };
    for (let i = 0; i < 6; i++) {
      content = { ephemeralMessage: { message: content } };
    }
    // After 5 unwraps, should still be ephemeralMessage, not the bottom conversation
    const result = normalizeMessageContent(content as Record<string, unknown>);
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>)?.conversation).toBeUndefined();
    expect((result as Record<string, unknown>)?.ephemeralMessage).toBeDefined();
  });
});

// ── generateWAMessageContent ────────────────────────────────────────────

describe('generateWAMessageContent', () => {
  const opts = { userJid: '123@s.whatsapp.net' };

  it('generates extendedTextMessage for text content', async () => {
    const content: AnyMessageContent = { text: 'hello world' };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    expect(result).toBeDefined();
    // proto.Message has the field set
    const msg = (result as { extendedTextMessage?: { text?: string } }).extendedTextMessage;
    expect(msg?.text).toBe('hello world');
  });

  it('generates reactionMessage for react content', async () => {
    const content: AnyMessageContent = {
      react: { text: '👍', key: { remoteJid: 'x@s.whatsapp.net', id: '123' } },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    expect((result as { reactionMessage?: unknown }).reactionMessage).toBeDefined();
  });

  it('generates protocolMessage for delete content', async () => {
    const content: AnyMessageContent = {
      delete: { remoteJid: 'x@s.whatsapp.net', id: 'abc' },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const pm = (result as { protocolMessage?: { type?: number; key?: unknown } }).protocolMessage;
    expect(pm).toBeDefined();
    expect(pm?.type).toBe(2); // REVOKE
  });

  it('generates locationMessage for location content', async () => {
    const content: AnyMessageContent = {
      location: { degreesLatitude: 1.23, degreesLongitude: 4.56 },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    expect((result as { locationMessage?: unknown }).locationMessage).toBeDefined();
  });

  it('generates imageMessage with caption', async () => {
    const content: AnyMessageContent = {
      image: Buffer.from('fake-png'),
      caption: 'check this out',
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const img = (result as { imageMessage?: { caption?: string } }).imageMessage;
    expect(img?.caption).toBe('check this out');
  });

  it('generates documentMessage with mimetype', async () => {
    const content: AnyMessageContent = {
      document: Buffer.from('pdf-bytes'),
      mimetype: 'application/pdf',
      fileName: 'report.pdf',
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const doc = (result as { documentMessage?: { mimetype?: string; fileName?: string } })
      .documentMessage;
    expect(doc?.mimetype).toBe('application/pdf');
    expect(doc?.fileName).toBe('report.pdf');
  });

  it('wraps in viewOnceMessage when viewOnce is set', async () => {
    const content: AnyMessageContent = { text: 'self-destruct', viewOnce: true };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    expect((result as { viewOnceMessage?: unknown }).viewOnceMessage).toBeDefined();
  });

  it('includes mentions in contextInfo', async () => {
    const content: AnyMessageContent = {
      text: 'hey @someone',
      mentions: ['someone@s.whatsapp.net'],
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const ext = (result as { extendedTextMessage?: { contextInfo?: { mentionedJid?: string[] } } })
      .extendedTextMessage;
    expect(ext?.contextInfo?.mentionedJid).toEqual(['someone@s.whatsapp.net']);
  });
});

// ── generateWAMessageFromContent ────────────────────────────────────────

describe('generateWAMessageFromContent', () => {
  it('produces a valid WAMessage skeleton for 1:1 chat', () => {
    const msg = generateWAMessageFromContent('123@s.whatsapp.net', { conversation: 'test' }, {});
    expect(msg.key.remoteJid).toBe('123@s.whatsapp.net');
    expect(msg.key.fromMe).toBe(true);
    expect(msg.key.id).toBeDefined();
    expect(typeof msg.key.id).toBe('string');
    expect(msg.messageTimestamp).toBeGreaterThan(0);
    expect(msg.status).toBe('PENDING');
  });

  it('sets participant for group messages', () => {
    const msg = generateWAMessageFromContent(
      '456@g.us',
      { conversation: 'group msg' },
      { userJid: '123@s.whatsapp.net' },
    );
    expect(msg.key.remoteJid).toBe('456@g.us');
    expect(msg.participant).toBe('123@s.whatsapp.net');
  });

  it('accepts custom messageId', () => {
    const msg = generateWAMessageFromContent(
      'x@s.whatsapp.net',
      { conversation: 'custom' },
      { messageId: 'CUSTOM-ID-123' },
    );
    expect(msg.key.id).toBe('CUSTOM-ID-123');
  });

  it('accepts custom timestamp', () => {
    const ts = new Date('2024-01-15T12:00:00Z');
    const msg = generateWAMessageFromContent(
      'x@s.whatsapp.net',
      { conversation: 'timed' },
      { timestamp: ts },
    );
    expect(msg.messageTimestamp).toBe(Math.floor(ts.getTime() / 1000));
  });

  it('includes quoted message contextInfo', () => {
    const quoted: WAMessage = {
      key: {
        remoteJid: '123@s.whatsapp.net',
        fromMe: false,
        id: 'QUOTED-ID',
      },
      message: { conversation: 'original' } as WAMessageContent,
      messageTimestamp: 1000,
    };
    const msg = generateWAMessageFromContent(
      '123@s.whatsapp.net',
      { extendedTextMessage: { text: 'reply' } },
      { quoted, userJid: 'me@s.whatsapp.net' },
    );
    const ctxt = (
      msg.message as unknown as {
        extendedTextMessage?: {
          contextInfo?: { stanzaId?: string; quotedMessage?: unknown };
        };
      }
    )?.extendedTextMessage?.contextInfo;
    expect(ctxt?.stanzaId).toBe('QUOTED-ID');
  });
});
