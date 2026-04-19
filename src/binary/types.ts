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
  content?: BinaryNode[] | string | Uint8Array | Buffer;
}

// ---------- Node helpers ----------

/** Helper to check if a BinaryNode has child nodes */
export function hasChildNodes(
  node: BinaryNode,
): node is BinaryNode & { content: BinaryNode[] } {
  return Array.isArray(node.content);
}

/** Helper to get text content from a BinaryNode.
 *  Handles both string content (constructed in-memory) and Buffer content
 *  (decoded from the wire — the binary format can't distinguish string vs binary). */
export function getTextContent(node: BinaryNode): string | undefined {
  if (typeof node.content === 'string') return node.content;
  if (Buffer.isBuffer(node.content) || node.content instanceof Uint8Array) {
    return Buffer.from(node.content).toString('utf-8');
  }
  return undefined;
}

/** Helper to get binary content from a BinaryNode */
export function getBinaryContent(node: BinaryNode): Uint8Array | undefined {
  if (Buffer.isBuffer(node.content) || node.content instanceof Uint8Array) {
    return node.content;
  }
  return undefined;
}

/** Find a child node by tag */
export function findChildNode(
  node: BinaryNode,
  tag: string,
): BinaryNode | undefined {
  if (!Array.isArray(node?.content)) return undefined;
  return node.content.find((child) => child.tag === tag);
}

/** Get all child nodes with a given tag */
export function findChildNodes(node: BinaryNode, tag: string): BinaryNode[] {
  if (!Array.isArray(node?.content)) return [];
  return node.content.filter((child) => child.tag === tag);
}

// ---------- Baileys-compatible generic utils ----------

/** Get all children with a given tag (alias for findChildNodes) */
export const getBinaryNodeChildren = findChildNodes;

/** Get first child with a given tag (alias for findChildNode) */
export const getBinaryNodeChild = findChildNode;

/** Get all children regardless of tag */
export function getAllBinaryNodeChildren(node: BinaryNode): BinaryNode[] {
  if (Array.isArray(node?.content)) return node.content;
  return [];
}

/** Get buffer content from a child node by tag */
export function getBinaryNodeChildBuffer(
  node: BinaryNode,
  childTag: string,
): Buffer | Uint8Array | undefined {
  const child = findChildNode(node, childTag)?.content;
  if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
    return child;
  }
  return undefined;
}

/** Get string content from a child node by tag */
export function getBinaryNodeChildString(
  node: BinaryNode,
  childTag: string,
): string | undefined {
  const child = findChildNode(node, childTag)?.content;
  if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
    return Buffer.from(child).toString('utf-8');
  }
  if (typeof child === 'string') return child;
  return undefined;
}

/** Get unsigned integer from a child node's buffer */
export function getBinaryNodeChildUInt(
  node: BinaryNode,
  childTag: string,
  length: number,
): number | undefined {
  const buff = getBinaryNodeChildBuffer(node, childTag);
  if (buff) {
    let a = 0;
    for (let i = 0; i < length; i++) {
      a = 256 * a + buff[i];
    }
    return a;
  }
  return undefined;
}

/** Throw if the node contains an error child */
export function assertNodeErrorFree(node: BinaryNode): void {
  const errNode = findChildNode(node, 'error');
  if (errNode) {
    const code = errNode.attrs.code ? +errNode.attrs.code : undefined;
    const err = new Error(errNode.attrs.text || 'Unknown error') as Error & {
      data: number | undefined;
    };
    err.data = code;
    throw err;
  }
}

/** Reduce children with a given tag to a key-value dictionary */
export function reduceBinaryNodeToDictionary(
  node: BinaryNode,
  tag: string,
): Record<string, string> {
  const nodes = findChildNodes(node, tag);
  return nodes.reduce(
    (dict, { attrs }) => {
      if (typeof attrs.name === 'string') {
        dict[attrs.name] = attrs.value || attrs.config_value;
      } else {
        dict[attrs.config_code] = attrs.value || attrs.config_value;
      }
      return dict;
    },
    {} as Record<string, string>,
  );
}

/** Pretty-print a BinaryNode as XML-like text (for debugging) */
export function binaryNodeToString(
  node: BinaryNode | BinaryNode[] | Uint8Array | string | undefined,
  indent = 0,
): string {
  const tabs = '\t'.repeat(indent);

  if (!node) return '';
  if (typeof node === 'string') return tabs + node;
  if (node instanceof Uint8Array) {
    return tabs + Buffer.from(node).toString('hex');
  }
  if (Array.isArray(node)) {
    return node
      .map((x) => '\t'.repeat(indent + 1) + binaryNodeToString(x, indent + 1))
      .join('\n');
  }

  const children = binaryNodeToString(node.content as any, indent + 1);
  const attrStr = Object.entries(node.attrs || {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}='${v}'`)
    .join(' ');
  const tag = `<${node.tag} ${attrStr}`;
  const content = children
    ? `>\n${children}\n${tabs}</${node.tag}>`
    : '/>';

  return tag + content;
}
