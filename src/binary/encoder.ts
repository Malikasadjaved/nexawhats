/**
 * WhatsApp Binary Protocol Encoder
 *
 * Encodes BinaryNode trees into WhatsApp's compact binary format.
 * Uses token compression, nibble/hex packing, and JID-aware encoding.
 *
 * Ported from Baileys WABinary/encode.js with TypeScript types.
 */

import { jidDecode } from '../utils/jid.js';
import * as constants from './constants.js';
import type { BinaryNode } from './types.js';

export interface BinaryNodeCodingOptions {
  TAGS: typeof constants.TAGS;
  TOKEN_MAP: typeof constants.TOKEN_MAP;
  SINGLE_BYTE_TOKENS: typeof constants.SINGLE_BYTE_TOKENS;
  DOUBLE_BYTE_TOKENS: typeof constants.DOUBLE_BYTE_TOKENS;
}

/**
 * Encode a BinaryNode tree into WhatsApp's binary format.
 *
 * @param node - The node to encode
 * @param opts - Token tables (defaults to built-in constants)
 * @param buffer - Output buffer (defaults to [0] prefix byte)
 * @returns Buffer containing the encoded binary data
 */
export function encodeBinaryNode(
  node: BinaryNode,
  opts: BinaryNodeCodingOptions = constants,
  buffer: number[] = [0],
): Buffer {
  const encoded = encodeBinaryNodeInner(node, opts, buffer);
  return Buffer.from(encoded);
}

function encodeBinaryNodeInner(
  { tag, attrs, content }: BinaryNode,
  opts: BinaryNodeCodingOptions,
  buffer: number[],
): number[] {
  const { TAGS, TOKEN_MAP } = opts;

  const pushByte = (value: number): void => {
    buffer.push(value & 0xff);
  };

  const pushInt = (value: number, n: number, littleEndian = false): void => {
    for (let i = 0; i < n; i++) {
      const curShift = littleEndian ? i : n - 1 - i;
      buffer.push((value >> (curShift * 8)) & 0xff);
    }
  };

  const pushBytes = (bytes: ArrayLike<number>): void => {
    for (let i = 0; i < bytes.length; i++) {
      buffer.push(bytes[i]);
    }
  };

  const pushInt16 = (value: number): void => {
    pushBytes([(value >> 8) & 0xff, value & 0xff]);
  };

  const pushInt20 = (value: number): void => {
    pushBytes([
      (value >> 16) & 0x0f,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  };

  const writeByteLength = (length: number): void => {
    if (length >= 4294967296) {
      throw new Error('string too large to encode: ' + length);
    }
    if (length >= 1 << 20) {
      pushByte(TAGS.BINARY_32);
      pushInt(length, 4);
    } else if (length >= 256) {
      pushByte(TAGS.BINARY_20);
      pushInt20(length);
    } else {
      pushByte(TAGS.BINARY_8);
      pushByte(length);
    }
  };

  const writeStringRaw = (str: string): void => {
    const bytes = Buffer.from(str, 'utf-8');
    writeByteLength(bytes.length);
    pushBytes(bytes);
  };

  const writeJid = ({
    domainType,
    device,
    user,
    server,
  }: {
    domainType?: number;
    device?: number;
    user: string;
    server: string;
  }): void => {
    if (typeof device !== 'undefined') {
      pushByte(TAGS.AD_JID);
      pushByte(domainType || 0);
      pushByte(device || 0);
      writeString(user);
    } else {
      pushByte(TAGS.JID_PAIR);
      if (user.length) {
        writeString(user);
      } else {
        pushByte(TAGS.LIST_EMPTY);
      }
      writeString(server);
    }
  };

  const packNibble = (char: string): number => {
    switch (char) {
      case '-':
        return 10;
      case '.':
        return 11;
      case '\0':
        return 15;
      default:
        if (char >= '0' && char <= '9') {
          return char.charCodeAt(0) - '0'.charCodeAt(0);
        }
        throw new Error(`invalid byte for nibble "${char}"`);
    }
  };

  const packHex = (char: string): number => {
    if (char >= '0' && char <= '9') {
      return char.charCodeAt(0) - '0'.charCodeAt(0);
    }
    if (char >= 'A' && char <= 'F') {
      return 10 + char.charCodeAt(0) - 'A'.charCodeAt(0);
    }
    if (char >= 'a' && char <= 'f') {
      return 10 + char.charCodeAt(0) - 'a'.charCodeAt(0);
    }
    if (char === '\0') {
      return 15;
    }
    throw new Error(`Invalid hex char "${char}"`);
  };

  const writePackedBytes = (str: string, type: 'nibble' | 'hex'): void => {
    if (str.length > TAGS.PACKED_MAX) {
      throw new Error('Too many bytes to pack');
    }
    pushByte(type === 'nibble' ? TAGS.NIBBLE_8 : TAGS.HEX_8);
    let roundedLength = Math.ceil(str.length / 2.0);
    if (str.length % 2 !== 0) {
      roundedLength |= 128;
    }
    pushByte(roundedLength);
    const packFunction = type === 'nibble' ? packNibble : packHex;
    const packBytePair = (v1: string, v2: string): number => {
      return (packFunction(v1) << 4) | packFunction(v2);
    };
    const strLengthHalf = Math.floor(str.length / 2);
    for (let i = 0; i < strLengthHalf; i++) {
      pushByte(packBytePair(str[2 * i], str[2 * i + 1]));
    }
    if (str.length % 2 !== 0) {
      pushByte(packBytePair(str[str.length - 1], '\x00'));
    }
  };

  const isNibble = (str: string): boolean => {
    if (!str || str.length > TAGS.PACKED_MAX) return false;
    for (const char of str) {
      const isInNibbleRange = char >= '0' && char <= '9';
      if (!isInNibbleRange && char !== '-' && char !== '.') return false;
    }
    return true;
  };

  const isHex = (str: string): boolean => {
    if (!str || str.length > TAGS.PACKED_MAX) return false;
    for (const char of str) {
      const isInNibbleRange = char >= '0' && char <= '9';
      if (!isInNibbleRange && !(char >= 'A' && char <= 'F')) return false;
    }
    return true;
  };

  const writeString = (str: string | undefined | null): void => {
    if (str === undefined || str === null) {
      pushByte(TAGS.LIST_EMPTY);
      return;
    }
    const tokenIndex = TOKEN_MAP[str];
    if (tokenIndex) {
      if (typeof tokenIndex.dict === 'number') {
        pushByte(TAGS.DICTIONARY_0 + tokenIndex.dict);
      }
      pushByte(tokenIndex.index);
    } else if (isNibble(str)) {
      writePackedBytes(str, 'nibble');
    } else if (isHex(str)) {
      writePackedBytes(str, 'hex');
    } else if (str) {
      const decodedJid = jidDecode(str);
      if (decodedJid) {
        writeJid(decodedJid);
      } else {
        writeStringRaw(str);
      }
    }
  };

  const writeListStart = (listSize: number): void => {
    if (listSize === 0) {
      pushByte(TAGS.LIST_EMPTY);
    } else if (listSize < 256) {
      pushBytes([TAGS.LIST_8, listSize]);
    } else {
      pushByte(TAGS.LIST_16);
      pushInt16(listSize);
    }
  };

  // --- Main encoding logic ---

  if (!tag) {
    throw new Error('Invalid node: tag cannot be undefined');
  }

  const validAttributes = Object.keys(attrs || {}).filter(
    (k) => typeof (attrs as Record<string, string>)[k] !== 'undefined' && (attrs as Record<string, string>)[k] !== null,
  );

  writeListStart(
    2 * validAttributes.length + 1 + (typeof content !== 'undefined' ? 1 : 0),
  );
  writeString(tag);

  for (const key of validAttributes) {
    if (typeof attrs[key] === 'string') {
      writeString(key);
      writeString(attrs[key]);
    }
  }

  if (typeof content === 'string') {
    writeString(content);
  } else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    writeByteLength(content.length);
    pushBytes(content);
  } else if (Array.isArray(content)) {
    const validContent = content.filter(
      (item) =>
        item &&
        (item.tag ||
          Buffer.isBuffer(item) ||
          item instanceof Uint8Array ||
          typeof item === 'string'),
    );
    writeListStart(validContent.length);
    for (const item of validContent) {
      encodeBinaryNodeInner(item as BinaryNode, opts, buffer);
    }
  } else if (typeof content === 'undefined') {
    // do nothing
  } else {
    throw new Error(
      `invalid children for header "${tag}": ${content} (${typeof content})`,
    );
  }

  return buffer;
}

/**
 * Encode a list of BinaryNodes with 4-byte big-endian length prefixes.
 */
export function encodeBinaryNodes(nodes: BinaryNode[]): Uint8Array {
  const encoded = nodes.map((n) => encodeBinaryNode(n));
  const totalLength = encoded.reduce((sum, buf) => sum + buf.length + 4, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const buf of encoded) {
    const view = new DataView(result.buffer, offset);
    view.setUint32(0, buf.length);
    offset += 4;
    result.set(buf, offset);
    offset += buf.length;
  }

  return result;
}
