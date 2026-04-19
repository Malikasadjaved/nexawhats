import { describe, expect, it } from 'vitest';
import { encodeBinaryNode } from '../../../src/binary/encoder.js';
import {
  decodeDecompressedBinaryNode,
  decompressingIfRequired,
} from '../../../src/binary/decoder.js';
import {
  type BinaryNode,
  findChildNode,
  findChildNodes,
  getAllBinaryNodeChildren,
  getBinaryContent,
  getBinaryNodeChildBuffer,
  getBinaryNodeChildString,
  getBinaryNodeChildUInt,
  getTextContent,
  hasChildNodes,
  assertNodeErrorFree,
  reduceBinaryNodeToDictionary,
  binaryNodeToString,
} from '../../../src/binary/types.js';
import { TAGS, TOKEN_MAP } from '../../../src/binary/constants.js';

/**
 * Helper: encode a node, strip the prefix byte, then decode.
 * The encoder prepends a 0x00 byte; the decoder expects it removed.
 */
function roundTrip(node: BinaryNode): BinaryNode {
  const encoded = encodeBinaryNode(node);
  // Strip the prefix byte (encodeBinaryNode adds buffer[0] = 0)
  const withoutPrefix = Buffer.from(encoded.subarray(1));
  return decodeDecompressedBinaryNode(withoutPrefix);
}

// ============ Real protocol round-trip tests ============

describe('BinaryNode real protocol round-trip', () => {
  it('round-trips a simple node with token-compressed tag', () => {
    // 'message' is index 19 in SINGLE_BYTE_TOKENS — should compress to 1 byte
    const node: BinaryNode = {
      tag: 'message',
      attrs: { type: 'text' },
    };
    const result = roundTrip(node);
    expect(result.tag).toBe('message');
    expect(result.attrs.type).toBe('text');
  });

  it('round-trips a node with token-compressed attributes', () => {
    // Both 'to' and 'from' are in SINGLE_BYTE_TOKENS
    expect(TOKEN_MAP['to']).toBeDefined();
    expect(TOKEN_MAP['from']).toBeDefined();

    const node: BinaryNode = {
      tag: 'message',
      attrs: { to: '923124166950@s.whatsapp.net', from: '923315244441@s.whatsapp.net' },
    };
    const result = roundTrip(node);
    expect(result.attrs.to).toBe('923124166950@s.whatsapp.net');
    expect(result.attrs.from).toBe('923315244441@s.whatsapp.net');
  });

  it('round-trips a JID that gets JID_PAIR encoded', () => {
    // JIDs with @server get encoded as JID_PAIR
    const node: BinaryNode = {
      tag: 'ack',
      attrs: { to: '120363123456789@g.us' },
    };
    const result = roundTrip(node);
    expect(result.attrs.to).toBe('120363123456789@g.us');
  });

  it('round-trips text content', () => {
    const node: BinaryNode = {
      tag: 'body',
      attrs: {},
      content: 'Hello, world!',
    };
    const result = roundTrip(node);
    expect(result.tag).toBe('body');
    // Wire format uses BINARY_8 for raw strings — decoded as Buffer, use getTextContent()
    expect(getTextContent(result)).toBe('Hello, world!');
  });

  it('round-trips binary content', () => {
    const data = Buffer.from([0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
    const node: BinaryNode = {
      tag: 'enc',
      attrs: { v: '2', type: 'msg' },
      content: data,
    };
    const result = roundTrip(node);
    expect(result.tag).toBe('enc');
    expect(result.attrs.v).toBe('2');
    expect(Buffer.from(result.content as Uint8Array)).toEqual(data);
  });

  it('round-trips nested child nodes', () => {
    const node: BinaryNode = {
      tag: 'iq',
      attrs: { type: 'set', xmlns: 'w:g2' },
      content: [
        {
          tag: 'create',
          attrs: { subject: 'Test Group' },
          content: [
            { tag: 'participant', attrs: { jid: '923124166950@s.whatsapp.net' } },
            { tag: 'participant', attrs: { jid: '923315244441@s.whatsapp.net' } },
          ],
        },
      ],
    };
    const result = roundTrip(node);
    expect(result.tag).toBe('iq');
    expect(result.attrs.type).toBe('set');
    expect(result.attrs.xmlns).toBe('w:g2');
    expect(Array.isArray(result.content)).toBe(true);

    const create = (result.content as BinaryNode[])[0];
    expect(create.tag).toBe('create');
    expect(create.attrs.subject).toBe('Test Group');
    expect(Array.isArray(create.content)).toBe(true);

    const participants = create.content as BinaryNode[];
    expect(participants).toHaveLength(2);
    expect(participants[0].attrs.jid).toBe('923124166950@s.whatsapp.net');
    expect(participants[1].attrs.jid).toBe('923315244441@s.whatsapp.net');
  });

  it('round-trips a node with no content', () => {
    const node: BinaryNode = {
      tag: 'ack',
      attrs: { id: 'abc123', class: 'message' },
    };
    const result = roundTrip(node);
    expect(result.tag).toBe('ack');
    expect(result.attrs.id).toBe('abc123');
    expect(result.attrs.class).toBe('message');
    expect(result.content).toBeUndefined();
  });

  it('round-trips nibble-encoded numeric strings', () => {
    // Pure digits get nibble-encoded (4 bits per char)
    const node: BinaryNode = {
      tag: 'message',
      attrs: { id: '923124166950' },
    };
    const result = roundTrip(node);
    expect(result.attrs.id).toBe('923124166950');
  });

  it('round-trips a node with empty attrs', () => {
    const node: BinaryNode = {
      tag: 'success',
      attrs: {},
    };
    const result = roundTrip(node);
    expect(result.tag).toBe('success');
    expect(result.attrs).toEqual({});
  });

  it('round-trips a double-byte token tag', () => {
    // 'dirty' is in DOUBLE_BYTE_TOKENS[1][1] — should compress to 2 bytes
    expect(TOKEN_MAP['dirty']).toBeDefined();
    expect(TOKEN_MAP['dirty'].dict).toBeDefined();

    const node: BinaryNode = {
      tag: 'iq',
      attrs: {},
      content: [{ tag: 'dirty', attrs: { type: 'account_sync' } }],
    };
    const result = roundTrip(node);
    const dirty = (result.content as BinaryNode[])[0];
    expect(dirty.tag).toBe('dirty');
    expect(dirty.attrs.type).toBe('account_sync');
  });

  it('round-trips a presence node (common WhatsApp pattern)', () => {
    const node: BinaryNode = {
      tag: 'presence',
      attrs: { type: 'available', name: 'Test User' },
    };
    const result = roundTrip(node);
    expect(result.tag).toBe('presence');
    expect(result.attrs.type).toBe('available');
    expect(result.attrs.name).toBe('Test User');
  });

  it('round-trips a message receipt pattern', () => {
    const node: BinaryNode = {
      tag: 'receipt',
      attrs: {
        to: '923124166950@s.whatsapp.net',
        id: 'ABCDEF123456',
        type: 'read',
      },
    };
    const result = roundTrip(node);
    expect(result.tag).toBe('receipt');
    expect(result.attrs.to).toBe('923124166950@s.whatsapp.net');
    expect(result.attrs.id).toBe('ABCDEF123456');
    expect(result.attrs.type).toBe('read');
  });

  it('round-trips a LID JID', () => {
    const node: BinaryNode = {
      tag: 'message',
      attrs: { from: '197151900590225@lid' },
    };
    const result = roundTrip(node);
    expect(result.attrs.from).toBe('197151900590225@lid');
  });

  it('handles large binary content', () => {
    const data = Buffer.alloc(1024, 0xab);
    const node: BinaryNode = {
      tag: 'media',
      attrs: { mediatype: 'image' },
      content: data,
    };
    const result = roundTrip(node);
    expect(Buffer.from(result.content as Uint8Array)).toEqual(data);
  });

  it('handles an unknown string that needs raw encoding', () => {
    const node: BinaryNode = {
      tag: 'iq',
      attrs: { custom_field: 'some-totally-custom-value-here' },
    };
    const result = roundTrip(node);
    expect(result.attrs.custom_field).toBe('some-totally-custom-value-here');
  });
});

// ============ Token compression verification ============

describe('Token compression', () => {
  it('compresses known single-byte tokens', () => {
    expect(TOKEN_MAP['message']).toEqual({ index: 19 });
    expect(TOKEN_MAP['presence']).toEqual({ index: 31 });
    expect(TOKEN_MAP['iq']).toEqual({ index: 25 });
    expect(TOKEN_MAP['s.whatsapp.net']).toEqual({ index: 3 });
    expect(TOKEN_MAP['g.us']).toEqual({ index: 28 });
  });

  it('compresses known double-byte tokens', () => {
    expect(TOKEN_MAP['dirty']).toBeDefined();
    expect(typeof TOKEN_MAP['dirty'].dict).toBe('number');
    expect(TOKEN_MAP['w:g2']).toBeDefined();
    expect(typeof TOKEN_MAP['w:g2'].dict).toBe('number');
  });

  it('produces smaller output for token-compressed nodes vs raw', () => {
    // 'message' should be 1 byte, not the 7 bytes of "message"
    const node: BinaryNode = { tag: 'message', attrs: {} };
    const encoded = encodeBinaryNode(node);
    // Prefix byte + list header + tag (1 byte for token) = very small
    expect(encoded.length).toBeLessThan(15);
  });
});

// ============ Decompression ============

describe('decompressingIfRequired', () => {
  it('strips prefix byte for uncompressed data', async () => {
    const input = Buffer.from([0x00, 0x41, 0x42, 0x43]);
    const result = await decompressingIfRequired(input);
    expect(result.toString()).toBe('ABC');
  });
});

// ============ BinaryNode helpers ============

describe('BinaryNode helpers', () => {
  const tree: BinaryNode = {
    tag: 'root',
    attrs: {},
    content: [
      { tag: 'child1', attrs: { id: '1' }, content: 'text1' },
      { tag: 'child2', attrs: { id: '2' }, content: Buffer.from([0x01, 0x02]) },
      { tag: 'child1', attrs: { id: '3' }, content: 'text3' },
    ],
  };

  it('hasChildNodes returns true for array content', () => {
    expect(hasChildNodes(tree)).toBe(true);
  });

  it('hasChildNodes returns false for text content', () => {
    const node: BinaryNode = { tag: 'text', attrs: {}, content: 'hello' };
    expect(hasChildNodes(node)).toBe(false);
  });

  it('getTextContent returns text', () => {
    const node: BinaryNode = { tag: 'text', attrs: {}, content: 'hello' };
    expect(getTextContent(node)).toBe('hello');
  });

  it('getTextContent returns undefined for non-text', () => {
    expect(getTextContent(tree)).toBeUndefined();
  });

  it('getBinaryContent returns Uint8Array', () => {
    const data = new Uint8Array([1, 2, 3]);
    const node: BinaryNode = { tag: 'bin', attrs: {}, content: data };
    expect(getBinaryContent(node)).toBe(data);
  });

  it('findChildNode finds first match by tag', () => {
    expect(findChildNode(tree, 'child1')?.attrs.id).toBe('1');
  });

  it('findChildNode returns undefined when not found', () => {
    expect(findChildNode(tree, 'missing')).toBeUndefined();
  });

  it('findChildNodes returns all matching', () => {
    const items = findChildNodes(tree, 'child1');
    expect(items).toHaveLength(2);
    expect(items[0].attrs.id).toBe('1');
    expect(items[1].attrs.id).toBe('3');
  });

  it('getAllBinaryNodeChildren returns all children', () => {
    const all = getAllBinaryNodeChildren(tree);
    expect(all).toHaveLength(3);
  });

  it('getBinaryNodeChildBuffer returns buffer from child', () => {
    const buf = getBinaryNodeChildBuffer(tree, 'child2');
    expect(buf).toBeDefined();
    expect(Buffer.from(buf!)).toEqual(Buffer.from([0x01, 0x02]));
  });

  it('getBinaryNodeChildString returns string from child', () => {
    const str = getBinaryNodeChildString(tree, 'child1');
    expect(str).toBe('text1');
  });

  it('getBinaryNodeChildUInt extracts integer', () => {
    const node: BinaryNode = {
      tag: 'root',
      attrs: {},
      content: [
        { tag: 'count', attrs: {}, content: Buffer.from([0x00, 0x05]) },
      ],
    };
    expect(getBinaryNodeChildUInt(node, 'count', 2)).toBe(5);
  });

  it('assertNodeErrorFree passes for non-error nodes', () => {
    expect(() => assertNodeErrorFree(tree)).not.toThrow();
  });

  it('assertNodeErrorFree throws for error nodes', () => {
    const node: BinaryNode = {
      tag: 'iq',
      attrs: {},
      content: [
        { tag: 'error', attrs: { code: '401', text: 'Unauthorized' } },
      ],
    };
    expect(() => assertNodeErrorFree(node)).toThrow('Unauthorized');
  });

  it('reduceBinaryNodeToDictionary builds dict from children', () => {
    const node: BinaryNode = {
      tag: 'root',
      attrs: {},
      content: [
        { tag: 'prop', attrs: { name: 'key1', value: 'val1' } },
        { tag: 'prop', attrs: { name: 'key2', value: 'val2' } },
      ],
    };
    const dict = reduceBinaryNodeToDictionary(node, 'prop');
    expect(dict).toEqual({ key1: 'val1', key2: 'val2' });
  });

  it('binaryNodeToString produces readable output', () => {
    const node: BinaryNode = {
      tag: 'message',
      attrs: { to: '123@s.whatsapp.net' },
      content: 'hello',
    };
    const str = binaryNodeToString(node);
    expect(str).toContain('message');
    expect(str).toContain('123@s.whatsapp.net');
  });
});

// ============ TAGS constants ============

describe('TAGS constants', () => {
  it('has expected tag values', () => {
    expect(TAGS.LIST_EMPTY).toBe(0);
    expect(TAGS.LIST_8).toBe(248);
    expect(TAGS.LIST_16).toBe(249);
    expect(TAGS.JID_PAIR).toBe(250);
    expect(TAGS.AD_JID).toBe(247);
    expect(TAGS.BINARY_8).toBe(252);
    expect(TAGS.BINARY_20).toBe(253);
    expect(TAGS.BINARY_32).toBe(254);
    expect(TAGS.NIBBLE_8).toBe(255);
    expect(TAGS.HEX_8).toBe(251);
    expect(TAGS.PACKED_MAX).toBe(127);
  });
});
