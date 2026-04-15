// Main entry point — NexaWhats
export { NexaWhatsClient, createClient } from './client.js';

// Types
export type * from './types/index.js';

// Errors
export * from './errors/index.js';

// Store
export { type AuthStore, storeToAuthState } from './store/interface.js';
export { MemoryAuthStore } from './store/memory.js';

// Socket
export { ConnectionStateMachine } from './socket/state-machine.js';
export { CircuitBreaker } from './socket/circuit-breaker.js';

// Queue
export { MessageQueue, RateLimiter, DeadLetterQueue } from './queue/index.js';

// Middleware
export {
  MiddlewarePipeline,
  type Middleware,
  type Context,
  type NextFn,
} from './middleware/index.js';
export { lidResolver } from './middleware/builtin/lid-resolver.js';
export { antiBan } from './middleware/builtin/anti-ban.js';
export { messageLogger } from './middleware/builtin/logger.js';

// Messages
export {
  MessageSender,
  extractText,
  isFromMe,
  isGroupMessage,
  isStatusBroadcast,
  getSenderJid,
  getChatJid,
  hasMedia,
  getMediaType,
  resolveMediaUpload,
} from './messages/index.js';

// Binary
export type { BinaryNode } from './binary/types.js';
export {
  encodeBinaryNode,
  decodeBinaryNode,
  findChildNode,
  findChildNodes,
  hasChildNodes,
  getTextContent,
  getBinaryContent,
} from './binary/index.js';

// Signal
export type { SignalRepository } from './signal/repository.js';
export { CacheableSignalKeyStore } from './signal/keys.js';

// Utils
export {
  jidEncode,
  jidDecode,
  jidNormalizedUser,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  isLidUser,
  isJidUser,
  phoneFromJid,
  areJidsSameUser,
} from './utils/jid.js';
export { retry, sleep, calculateBackoff } from './utils/retry.js';
export { generateMessageId } from './utils/crypto.js';
export { createLogger, defaultLogger, silentLogger } from './utils/logger.js';
export { getPlatform, getDefaultDataDir } from './utils/platform.js';

// Proto (placeholder — full WAProto in Phase 1)
export type { proto } from './proto/index.js';
