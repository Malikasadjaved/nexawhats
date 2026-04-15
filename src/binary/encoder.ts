import type { BinaryNode } from './types.js';

/**
 * Encode a BinaryNode tree into WhatsApp's binary XML format.
 *
 * This is a placeholder that will be replaced with the actual encoding logic
 * forked from Baileys' WABinary/encode in Phase 1.
 *
 * The encoding uses a custom binary format with:
 * - Tag dictionary (single-byte lookups for common tags)
 * - Attribute encoding (JID compression, nibble/hex encoding for numbers)
 * - Varint length prefixes
 */
export function encodeBinaryNode(node: BinaryNode): Uint8Array {
  // Phase 1: This will be replaced with the full Baileys encoder
  // For now, a simple JSON-based encoding for testing
  const json = JSON.stringify({
    tag: node.tag,
    attrs: node.attrs,
    content:
      node.content instanceof Uint8Array
        ? { type: 'binary', data: Array.from(node.content) }
        : node.content,
  });
  return new TextEncoder().encode(json);
}

/**
 * Encode a list of BinaryNodes with a length prefix.
 */
export function encodeBinaryNodes(nodes: BinaryNode[]): Uint8Array {
  const encoded = nodes.map(encodeBinaryNode);
  const totalLength = encoded.reduce((sum, buf) => sum + buf.length + 4, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const buf of encoded) {
    // 4-byte big-endian length prefix
    const view = new DataView(result.buffer, offset);
    view.setUint32(0, buf.length);
    offset += 4;
    result.set(buf, offset);
    offset += buf.length;
  }

  return result;
}
