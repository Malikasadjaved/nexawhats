/**
 * WhatsApp Binary Protocol Decoder
 *
 * Decodes WhatsApp's compact binary format into BinaryNode trees.
 * Handles zlib decompression, token decompression, nibble/hex unpacking.
 *
 * Ported from Baileys WABinary/decode.js with TypeScript types.
 */

import { promisify } from 'node:util';
import { inflate } from 'node:zlib';
import { WAJIDDomains } from '../types/jid.js';
import { jidEncode } from '../utils/jid.js';
import * as constants from './constants.js';
import type { BinaryNodeCodingOptions } from './encoder.js';
import type { BinaryNode } from './types.js';

const inflatePromise = promisify(inflate);

/**
 * Decompress a buffer if the compression flag is set.
 * WhatsApp may zlib-compress large payloads; this handles both cases.
 */
export async function decompressingIfRequired(buffer: Buffer): Promise<Buffer> {
  if (2 & buffer.readUInt8(0)) {
    // Compression flag set — strip prefix and inflate
    return Buffer.from(await inflatePromise(buffer.subarray(1)));
  }
  // No compression — just strip the prefix byte
  return buffer.subarray(1);
}

/**
 * Decode a decompressed binary buffer into a BinaryNode.
 * This is the synchronous core decoder used after decompression.
 */
export function decodeDecompressedBinaryNode(
  buffer: Buffer,
  opts: BinaryNodeCodingOptions = constants,
  indexRef: { index: number } = { index: 0 },
): BinaryNode {
  const { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS } = opts;

  const checkEOS = (length: number): void => {
    if (indexRef.index + length > buffer.length) {
      throw new Error('end of stream');
    }
  };

  const next = (): number => {
    const value = buffer[indexRef.index];
    indexRef.index += 1;
    return value;
  };

  const readByte = (): number => {
    checkEOS(1);
    return next();
  };

  const readBytes = (n: number): Buffer => {
    checkEOS(n);
    const value = buffer.subarray(indexRef.index, indexRef.index + n);
    indexRef.index += n;
    return Buffer.from(value);
  };

  const readStringFromChars = (length: number): string => {
    return readBytes(length).toString('utf-8');
  };

  const readInt = (n: number, littleEndian = false): number => {
    checkEOS(n);
    let val = 0;
    for (let i = 0; i < n; i++) {
      const shift = littleEndian ? i : n - 1 - i;
      val |= next() << (shift * 8);
    }
    return val;
  };

  const readInt20 = (): number => {
    checkEOS(3);
    return ((next() & 15) << 16) + (next() << 8) + next();
  };

  const unpackHex = (value: number): number => {
    if (value >= 0 && value < 16) {
      return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10;
    }
    throw new Error('invalid hex: ' + value);
  };

  const unpackNibble = (value: number): number => {
    if (value >= 0 && value <= 9) {
      return '0'.charCodeAt(0) + value;
    }
    switch (value) {
      case 10:
        return '-'.charCodeAt(0);
      case 11:
        return '.'.charCodeAt(0);
      case 15:
        return '\0'.charCodeAt(0);
      default:
        throw new Error('invalid nibble: ' + value);
    }
  };

  const unpackByte = (tag: number, value: number): number => {
    if (tag === TAGS.NIBBLE_8) {
      return unpackNibble(value);
    }
    if (tag === TAGS.HEX_8) {
      return unpackHex(value);
    }
    throw new Error('unknown tag: ' + tag);
  };

  const readPacked8 = (tag: number): string => {
    const startByte = readByte();
    let value = '';
    for (let i = 0; i < (startByte & 127); i++) {
      const curByte = readByte();
      value += String.fromCharCode(unpackByte(tag, (curByte & 0xf0) >> 4));
      value += String.fromCharCode(unpackByte(tag, curByte & 0x0f));
    }
    if (startByte >> 7 !== 0) {
      value = value.slice(0, -1);
    }
    return value;
  };

  const isListTag = (tag: number): boolean => {
    return tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16;
  };

  const readListSize = (tag: number): number => {
    switch (tag) {
      case TAGS.LIST_EMPTY:
        return 0;
      case TAGS.LIST_8:
        return readByte();
      case TAGS.LIST_16:
        return readInt(2);
      default:
        throw new Error('invalid tag for list size: ' + tag);
    }
  };

  const readJidPair = (): string => {
    const i = readString(readByte());
    const j = readString(readByte());
    if (j) {
      return (i || '') + '@' + j;
    }
    throw new Error('invalid jid pair: ' + i + ', ' + j);
  };

  const readAdJid = (): string => {
    const rawDomainType = readByte();
    const domainType = Number(rawDomainType);
    const device = readByte();
    const user = readString(readByte());

    let server = 's.whatsapp.net';
    if (domainType === WAJIDDomains.LID) {
      server = 'lid';
    } else if (domainType === WAJIDDomains.HOSTED) {
      server = 'hosted';
    } else if (domainType === WAJIDDomains.HOSTED_LID) {
      server = 'hosted.lid';
    }

    return jidEncode(user, server, device);
  };

  const getTokenDouble = (index1: number, index2: number): string => {
    const dict = DOUBLE_BYTE_TOKENS[index1];
    if (!dict) {
      throw new Error(`Invalid double token dict (${index1})`);
    }
    const value = dict[index2];
    if (typeof value === 'undefined') {
      throw new Error(`Invalid double token (${index2})`);
    }
    return value;
  };

  const readString = (tag: number): string => {
    if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
      return SINGLE_BYTE_TOKENS[tag] || '';
    }

    switch (tag) {
      case TAGS.DICTIONARY_0:
      case TAGS.DICTIONARY_1:
      case TAGS.DICTIONARY_2:
      case TAGS.DICTIONARY_3:
        return getTokenDouble(tag - TAGS.DICTIONARY_0, readByte());
      case TAGS.LIST_EMPTY:
        return '';
      case TAGS.BINARY_8:
        return readStringFromChars(readByte());
      case TAGS.BINARY_20:
        return readStringFromChars(readInt20());
      case TAGS.BINARY_32:
        return readStringFromChars(readInt(4));
      case TAGS.JID_PAIR:
        return readJidPair();
      case TAGS.AD_JID:
        return readAdJid();
      case TAGS.HEX_8:
      case TAGS.NIBBLE_8:
        return readPacked8(tag);
      default:
        throw new Error('invalid string with tag: ' + tag);
    }
  };

  const readList = (tag: number): BinaryNode[] => {
    const items: BinaryNode[] = [];
    const size = readListSize(tag);
    for (let i = 0; i < size; i++) {
      items.push(decodeDecompressedBinaryNode(buffer, opts, indexRef));
    }
    return items;
  };

  // --- Main decoding logic ---

  const listSize = readListSize(readByte());
  const header = readString(readByte());

  if (!listSize || !header.length) {
    throw new Error('invalid node');
  }

  const attrs: Record<string, string> = {};
  let data: BinaryNode['content'];

  if (listSize === 0 || !header) {
    throw new Error('invalid node');
  }

  // Read attributes
  const attributesLength = (listSize - 1) >> 1;
  for (let i = 0; i < attributesLength; i++) {
    const key = readString(readByte());
    const value = readString(readByte());
    attrs[key] = value;
  }

  // Read content if even list size
  if (listSize % 2 === 0) {
    const tag = readByte();
    if (isListTag(tag)) {
      data = readList(tag);
    } else {
      switch (tag) {
        case TAGS.BINARY_8:
          data = readBytes(readByte());
          break;
        case TAGS.BINARY_20:
          data = readBytes(readInt20());
          break;
        case TAGS.BINARY_32:
          data = readBytes(readInt(4));
          break;
        default:
          data = readString(tag);
          break;
      }
    }
  }

  return {
    tag: header,
    attrs,
    content: data,
  };
}

/**
 * Decode a binary buffer into a BinaryNode.
 * Handles decompression automatically.
 */
export async function decodeBinaryNode(buff: Buffer): Promise<BinaryNode> {
  const decompBuff = await decompressingIfRequired(buff);
  return decodeDecompressedBinaryNode(decompBuff, constants);
}

/**
 * Synchronous decode for buffers that are already decompressed.
 * The buffer should NOT have the prefix byte — call decompressingIfRequired first
 * or use this when you know the data format.
 */
export function decodeBinaryNodeSync(buffer: Buffer): BinaryNode {
  return decodeDecompressedBinaryNode(buffer, constants);
}

/**
 * Decode a stream of length-prefixed BinaryNodes.
 */
export async function decodeBinaryNodes(data: Buffer): Promise<BinaryNode[]> {
  const nodes: BinaryNode[] = [];
  let offset = 0;

  while (offset < data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset);
    const length = view.getUint32(0);
    offset += 4;

    const nodeData = data.subarray(offset, offset + length);
    nodes.push(await decodeBinaryNode(nodeData));
    offset += length;
  }

  return nodes;
}
