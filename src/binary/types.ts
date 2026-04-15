/**
 * WhatsApp's internal binary message format.
 * All wire protocol communication is encoded as BinaryNode trees.
 */
export interface BinaryNode {
  /** XML-like tag name */
  tag: string;
  /** Key-value attributes */
  attrs: Record<string, string>;
  /** Child nodes, text content, or binary data */
  content?: BinaryNode[] | string | Uint8Array;
}

/** Helper to check if a BinaryNode has child nodes */
export function hasChildNodes(node: BinaryNode): node is BinaryNode & { content: BinaryNode[] } {
  return Array.isArray(node.content);
}

/** Helper to get text content from a BinaryNode */
export function getTextContent(node: BinaryNode): string | undefined {
  if (typeof node.content === 'string') return node.content;
  return undefined;
}

/** Helper to get binary content from a BinaryNode */
export function getBinaryContent(node: BinaryNode): Uint8Array | undefined {
  if (node.content instanceof Uint8Array) return node.content;
  return undefined;
}

/** Find a child node by tag */
export function findChildNode(node: BinaryNode, tag: string): BinaryNode | undefined {
  if (!Array.isArray(node.content)) return undefined;
  return node.content.find((child) => child.tag === tag);
}

/** Get all child nodes with a given tag */
export function findChildNodes(node: BinaryNode, tag: string): BinaryNode[] {
  if (!Array.isArray(node.content)) return [];
  return node.content.filter((child) => child.tag === tag);
}
