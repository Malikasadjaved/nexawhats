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

  // ── Phase 3: interactive message types ──────────────────────────

  it('generates buttonsMessage for buttons content', async () => {
    const content: AnyMessageContent = {
      buttons: {
        text: 'Choose one',
        footerText: 'Footer',
        buttons: [
          { buttonId: 'btn1', buttonText: { displayText: 'Option A' }, type: 1 },
          { buttonId: 'btn2', buttonText: { displayText: 'Option B' }, type: 1 },
        ],
        headerType: 2,
        headerText: 'Header',
      },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const bm = result.buttonsMessage as Record<string, unknown> | undefined;
    expect(bm).toBeDefined();
    expect(bm?.contentText).toBe('Choose one');
    expect(bm?.footerText).toBe('Footer');
    expect(bm?.headerType).toBe(2);
    expect(bm?.text).toBe('Header');
    expect(Array.isArray(bm?.buttons)).toBe(true);
    expect((bm?.buttons as Array<unknown>)?.length).toBe(2);
  });

  it('generates buttonsMessage with default headerType from headerText', async () => {
    const content: AnyMessageContent = {
      buttons: {
        text: 'Body',
        buttons: [{ buttonId: 'a', buttonText: { displayText: 'Click' }, type: 1 }],
        headerText: 'Title',
      },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const bm = result.buttonsMessage as Record<string, unknown> | undefined;
    expect(bm?.headerType).toBe(2);
    expect(bm?.text).toBe('Title');
  });

  it('generates listMessage for list content', async () => {
    const content: AnyMessageContent = {
      list: {
        title: 'Pick one',
        description: 'Choose from the list',
        buttonText: 'View options',
        footerText: 'Thanks',
        listType: 0,
        sections: [
          {
            title: 'Section 1',
            rows: [
              { title: 'Row 1', description: 'First', rowId: 'r1' },
              { title: 'Row 2', rowId: 'r2' },
            ],
          },
        ],
      },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const lm = result.listMessage as Record<string, unknown> | undefined;
    expect(lm).toBeDefined();
    expect(lm?.title).toBe('Pick one');
    expect(lm?.buttonText).toBe('View options');
    expect(lm?.listType).toBe(0);
    const sections = lm?.sections as Array<{ title?: string; rows: Array<unknown> }> | undefined;
    expect(sections?.length).toBe(1);
    expect(sections?.[0]?.rows?.length).toBe(2);
  });

  it('generates templateButtonReplyMessage for buttonReply (template type)', async () => {
    const content: AnyMessageContent = {
      buttonReply: { displayText: 'Yes', id: 'btn-yes', index: 0 },
      type: 'template',
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const reply = result.templateButtonReplyMessage as
      | { selectedDisplayText?: string; selectedId?: string; selectedIndex?: number }
      | undefined;
    expect(reply).toBeDefined();
    expect(reply?.selectedDisplayText).toBe('Yes');
    expect(reply?.selectedId).toBe('btn-yes');
    expect(reply?.selectedIndex).toBe(0);
  });

  it('generates buttonsResponseMessage for buttonReply (plain type)', async () => {
    const content: AnyMessageContent = {
      buttonReply: { displayText: 'OK', id: 'ok-btn' },
      type: 'plain',
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const resp = result.buttonsResponseMessage as
      | { selectedButtonId?: string; selectedDisplayText?: string; type?: number }
      | undefined;
    expect(resp).toBeDefined();
    expect(resp?.selectedButtonId).toBe('ok-btn');
    expect(resp?.selectedDisplayText).toBe('OK');
    expect(resp?.type).toBe(2); // DISPLAY_TEXT
  });

  it('generates interactiveMessage for interactive content', async () => {
    const content: AnyMessageContent = {
      interactive: {
        body: { text: 'Body text' },
        footer: { text: 'Footer text' },
        header: { title: 'Header', hasMediaAttachment: false },
        nativeFlowMessage: {
          buttons: [{ name: 'cta_url', params: { url: 'https://example.com' } }],
        },
      },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const iv = result.interactiveMessage as Record<string, unknown> | undefined;
    expect(iv).toBeDefined();
    expect((iv?.body as { text?: string })?.text).toBe('Body text');
    expect((iv?.footer as { text?: string })?.text).toBe('Footer text');
    expect(iv?.nativeFlowMessage).toBeDefined();
  });

  it('generates interactiveMessage with carouselMessage', async () => {
    const content: AnyMessageContent = {
      interactive: {
        body: { text: 'Products' },
        carouselMessage: { cards: [{ header: { title: 'Card 1' }, body: { text: 'Desc' } }] },
      },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const iv = result.interactiveMessage as Record<string, unknown> | undefined;
    expect(iv?.carouselMessage).toBeDefined();
  });

  it('generates templateMessage for template content', async () => {
    const content: AnyMessageContent = {
      template: {
        hydratedFourRowTemplate: {
          hydratedContentText: 'Hello',
          hydratedFooterText: 'Footer',
          hydratedButtons: [{ index: 0, quickReplyButton: { displayText: 'Reply', id: 'r1' } }],
        },
        contextInfo: {},
      },
    };
    const result = (await generateWAMessageContent(content, opts)) as Record<string, unknown>;
    const tpl = result.templateMessage as Record<string, unknown> | undefined;
    expect(tpl).toBeDefined();
    expect(tpl?.hydratedFourRowTemplate).toBeDefined();
    expect(tpl?.contextInfo).toBeDefined();
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
