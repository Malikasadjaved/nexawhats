import { describe, expect, it } from 'vitest';
import { decodeDecompressedBinaryNode } from '../../../src/binary/decoder.js';
import { encodeBinaryNode } from '../../../src/binary/encoder.js';
import {
  findChildNode,
  findChildNodes,
  getBinaryContent,
  getTextContent,
  hasChildNodes,
} from '../../../src/binary/types.js';
import type { BinaryNode } from '../../../src/binary/types.js';

/** Helper: encode → strip prefix → decode */
function roundTrip(node: BinaryNode): BinaryNode {
  const encoded = encodeBinaryNode(node);
  const withoutPrefix = Buffer.from(encoded.subarray(1));
  return decodeDecompressedBinaryNode(withoutPrefix);
}

describe('BinaryNode encode/decode round-trip', () => {
  it('should round-trip a simple node', () => {
    const node: BinaryNode = {
      tag: 'message',
      attrs: { to: '123@s.whatsapp.net', type: 'text' },
    };
    const decoded = roundTrip(node);
    expect(decoded.tag).toBe('message');
    expect(decoded.attrs.to).toBe('123@s.whatsapp.net');
    expect(decoded.attrs.type).toBe('text');
  });

  it('should round-trip a node with text content', () => {
    const node: BinaryNode = {
      tag: 'body',
      attrs: {},
      content: 'Hello, world!',
    };
    const decoded = roundTrip(node);
    expect(decoded.tag).toBe('body');
    // Wire format uses BINARY_8 for raw strings — decoded as Buffer, use getTextContent()
    expect(getTextContent(decoded)).toBe('Hello, world!');
  });

  it('should round-trip a node with binary content', () => {
    const data = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    const node: BinaryNode = {
      tag: 'media',
      attrs: { type: 'image' },
      content: data,
    };
    const decoded = roundTrip(node);
    expect(decoded.tag).toBe('media');
    const content = getBinaryContent(decoded);
    expect(content).toBeDefined();
    expect(Buffer.from(content!)).toEqual(data);
  });

  it('should round-trip a node with child nodes', () => {
    const node: BinaryNode = {
      tag: 'iq',
      attrs: { type: 'set' },
      content: [
        { tag: 'query', attrs: {}, content: 'test' },
        { tag: 'status', attrs: { code: '200' } },
      ],
    };
    const decoded = roundTrip(node);
    expect(decoded.tag).toBe('iq');
    expect(hasChildNodes(decoded)).toBe(true);
    if (hasChildNodes(decoded)) {
      expect(decoded.content).toHaveLength(2);
      expect(decoded.content[0].tag).toBe('query');
      expect(decoded.content[1].tag).toBe('status');
    }
  });

  it('should round-trip a node with no content', () => {
    const node: BinaryNode = {
      tag: 'ack',
      attrs: { id: 'test123' },
    };
    const decoded = roundTrip(node);
    expect(decoded.tag).toBe('ack');
    expect(decoded.attrs.id).toBe('test123');
    expect(decoded.content).toBeUndefined();
  });
});

describe('BinaryNode helpers', () => {
  const tree: BinaryNode = {
    tag: 'root',
    attrs: {},
    content: [
      { tag: 'child1', attrs: { id: '1' }, content: 'text1' },
      { tag: 'child2', attrs: { id: '2' }, content: 'text2' },
      { tag: 'child1', attrs: { id: '3' }, content: 'text3' },
    ],
  };

  it('findChildNode should find first matching child', () => {
    const child = findChildNode(tree, 'child1');
    expect(child).toBeDefined();
    expect(child?.attrs.id).toBe('1');
  });

  it('findChildNode should return undefined for non-existent tag', () => {
    expect(findChildNode(tree, 'missing')).toBeUndefined();
  });

  it('findChildNodes should find all matching children', () => {
    const children = findChildNodes(tree, 'child1');
    expect(children).toHaveLength(2);
    expect(children[0].attrs.id).toBe('1');
    expect(children[1].attrs.id).toBe('3');
  });

  it('hasChildNodes should return true for nodes with children', () => {
    expect(hasChildNodes(tree)).toBe(true);
  });

  it('hasChildNodes should return false for leaf nodes', () => {
    expect(hasChildNodes({ tag: 'leaf', attrs: {}, content: 'text' })).toBe(false);
  });

  it('getTextContent should return text from text nodes', () => {
    expect(getTextContent({ tag: 'a', attrs: {}, content: 'hello' })).toBe('hello');
  });

  it('getTextContent should return undefined for non-text nodes', () => {
    expect(getTextContent(tree)).toBeUndefined();
  });
});
