// Types
export type { BinaryNode } from './types.js';
export {
  hasChildNodes,
  getTextContent,
  getBinaryContent,
  findChildNode,
  findChildNodes,
  getAllBinaryNodeChildren,
  getBinaryNodeChildren,
  getBinaryNodeChild,
  getBinaryNodeChildBuffer,
  getBinaryNodeChildString,
  getBinaryNodeChildUInt,
  assertNodeErrorFree,
  reduceBinaryNodeToDictionary,
  binaryNodeToString,
} from './types.js';

// Encoder
export { encodeBinaryNode, encodeBinaryNodes } from './encoder.js';
export type { BinaryNodeCodingOptions } from './encoder.js';

// Decoder
export {
  decodeBinaryNode,
  decodeBinaryNodeSync,
  decodeBinaryNodes,
  decodeDecompressedBinaryNode,
  decompressingIfRequired,
} from './decoder.js';

// Constants
export { TAGS, SINGLE_BYTE_TOKENS, DOUBLE_BYTE_TOKENS, TOKEN_MAP } from './constants.js';
export type { TokenEntry } from './constants.js';

// JID utilities
export {
  S_WHATSAPP_NET,
  OFFICIAL_BIZ_JID,
  SERVER_JID,
  PSA_WID,
  STORIES_JID,
  META_AI_JID,
  WAJIDDomains,
  getServerFromDomainType,
  jidEncode,
  jidDecode,
  areJidsSameUser,
  isJidMetaAI,
  isPnUser,
  isLidUser,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  isJidNewsletter,
  isHostedPnUser,
  isHostedLidUser,
  isJidBot,
  jidNormalizedUser,
  transferDevice,
} from './jid.js';
export type { JidDecoded } from './jid.js';
