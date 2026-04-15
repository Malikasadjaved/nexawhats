import { describe, expect, it } from 'vitest';
import { decodeBinaryNode, decodeBinaryNodes } from '../../../src/binary/decoder.js';
import { encodeBinaryNode, encodeBinaryNodes } from '../../../src/binary/encoder.js';
import {
  type BinaryNode,
  findChildNode,
  findChildNodes,
  getBinaryContent,
  getTextContent,
  hasChildNodes,
} from '../../../src/binary/types.js';

describe('BinaryNode encoder/decoder round-trip', () => {
  it('round-trips a simple node with text content', () => {
    const node: BinaryNode = {
      tag: 'message',
      attrs: { to: '923124166950@s.whatsapp.net', type: 'text' },
      content: 'Hello world',
    };
    const encoded = encodeBinaryNode(node);
    const decoded = decodeBinaryNode(encoded);

    expect(decoded.tag).toBe('message');
    expect(decoded.attrs.to).toBe('923124166950@s.whatsapp.net');
    expect(decoded.attrs.type).toBe('text');
    expect(decoded.content).toBe('Hello world');
  });

  it('round-trips a node with binary content', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const node: BinaryNode = {
      tag: 'media',
      attrs: { mediatype: 'image' },
      content: data,
    };
    const encoded = encodeBinaryNode(node);
    const decoded = decodeBinaryNode(encoded);

    expect(decoded.tag).toBe('media');
    expect(decoded.content).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.content as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it('round-trips a node with no content', () => {
    const node: BinaryNode = {
      tag: 'ack',
      attrs: { id: '123' },
    };
    const encoded = encodeBinaryNode(node);
    const decoded = decodeBinaryNode(encoded);

    expect(decoded.tag).toBe('ack');
    expect(decoded.attrs.id).toBe('123');
    expect(decoded.content).toBeUndefined();
  });

  it('round-trips a node with child nodes', () => {
    const node: BinaryNode = {
      tag: 'iq',
      attrs: { type: 'set' },
      content: [
        { tag: 'pair-device', attrs: {}, content: 'code123' },
        { tag: 'pair-device-sign', attrs: { key: 'abc' } },
      ],
    };
    const encoded = encodeBinaryNode(node);
    const decoded = decodeBinaryNode(encoded);

    expect(decoded.tag).toBe('iq');
    expect(Array.isArray(decoded.content)).toBe(true);
    const children = decoded.content as BinaryNode[];
    expect(children).toHaveLength(2);
    expect(children[0].tag).toBe('pair-device');
    expect(children[1].tag).toBe('pair-device-sign');
  });

  it('round-trips a node with empty attrs', () => {
    const node: BinaryNode = {
      tag: 'ping',
      attrs: {},
    };
    const encoded = encodeBinaryNode(node);
    const decoded = decodeBinaryNode(encoded);

    expect(decoded.tag).toBe('ping');
    expect(decoded.attrs).toEqual({});
  });
});

describe('encodeBinaryNodes / decodeBinaryNodes', () => {
  it('round-trips multiple nodes', () => {
    const nodes: BinaryNode[] = [
      { tag: 'msg1', attrs: { id: '1' }, content: 'Hello' },
      { tag: 'msg2', attrs: { id: '2' }, content: 'World' },
      { tag: 'msg3', attrs: { id: '3' } },
    ];
    const encoded = encodeBinaryNodes(nodes);
    const decoded = decodeBinaryNodes(encoded);

    expect(decoded).toHaveLength(3);
    expect(decoded[0].tag).toBe('msg1');
    expect(decoded[1].content).toBe('World');
    expect(decoded[2].attrs.id).toBe('3');
  });

  it('handles empty array', () => {
    const encoded = encodeBinaryNodes([]);
    const decoded = decodeBinaryNodes(encoded);
    expect(decoded).toHaveLength(0);
  });
});

describe('BinaryNode helpers', () => {
  it('hasChildNodes returns true for array content', () => {
    const node: BinaryNode = {
      tag: 'parent',
      attrs: {},
      content: [{ tag: 'child', attrs: {} }],
    };
    expect(hasChildNodes(node)).toBe(true);
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
    const node: BinaryNode = { tag: 'bin', attrs: {}, content: new Uint8Array([1]) };
    expect(getTextContent(node)).toBeUndefined();
  });

  it('getBinaryContent returns Uint8Array', () => {
    const data = new Uint8Array([1, 2, 3]);
    const node: BinaryNode = { tag: 'bin', attrs: {}, content: data };
    expect(getBinaryContent(node)).toBe(data);
  });

  it('findChildNode finds by tag', () => {
    const node: BinaryNode = {
      tag: 'parent',
      attrs: {},
      content: [
        { tag: 'a', attrs: { val: '1' } },
        { tag: 'b', attrs: { val: '2' } },
      ],
    };
    expect(findChildNode(node, 'b')?.attrs.val).toBe('2');
  });

  it('findChildNode returns undefined when not found', () => {
    const node: BinaryNode = { tag: 'parent', attrs: {}, content: 'text' };
    expect(findChildNode(node, 'child')).toBeUndefined();
  });

  it('findChildNodes returns all matching', () => {
    const node: BinaryNode = {
      tag: 'parent',
      attrs: {},
      content: [
        { tag: 'item', attrs: { id: '1' } },
        { tag: 'other', attrs: {} },
        { tag: 'item', attrs: { id: '2' } },
      ],
    };
    const items = findChildNodes(node, 'item');
    expect(items).toHaveLength(2);
    expect(items[0].attrs.id).toBe('1');
    expect(items[1].attrs.id).toBe('2');
  });
});
