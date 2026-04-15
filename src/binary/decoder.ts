import type { BinaryNode } from './types.js';

/**
 * Decode WhatsApp's binary XML format into a BinaryNode tree.
 *
 * This is a placeholder that will be replaced with the actual decoding logic
 * forked from Baileys' WABinary/decode in Phase 1.
 */
export function decodeBinaryNode(data: Uint8Array): BinaryNode {
  // Phase 1: This will be replaced with the full Baileys decoder
  // For now, a simple JSON-based decoding for testing
  const json = new TextDecoder().decode(data);
  const parsed = JSON.parse(json);

  let content: BinaryNode['content'];
  if (parsed.content && typeof parsed.content === 'object' && parsed.content.type === 'binary') {
    content = new Uint8Array(parsed.content.data);
  } else {
    content = parsed.content;
  }

  return {
    tag: parsed.tag,
    attrs: parsed.attrs ?? {},
    content,
  };
}

/**
 * Decode a stream of length-prefixed BinaryNodes.
 */
export function decodeBinaryNodes(data: Uint8Array): BinaryNode[] {
  const nodes: BinaryNode[] = [];
  let offset = 0;

  while (offset < data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset);
    const length = view.getUint32(0);
    offset += 4;

    const nodeData = data.subarray(offset, offset + length);
    nodes.push(decodeBinaryNode(nodeData));
    offset += length;
  }

  return nodes;
}
