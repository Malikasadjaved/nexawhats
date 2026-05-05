// Main entry point — NexaWhats
export { NexaWhatsClient, createClient } from './client.js';

// Types
export type * from './types/index.js';

// Errors
export * from './errors/index.js';

// Store
export { type AuthStore, storeToAuthState } from './store/interface.js';
export { MemoryAuthStore } from './store/memory.js';
export { FileAuthStore } from './store/file.js';
export {
  SQLiteAuthStore,
  type SQLiteAuthStoreOptions,
} from './store/sqlite.js';
export {
  migrateFromBaileys,
  type MigrationResult,
} from './store/migrate.js';
export { encodeAuthValue, decodeAuthValue } from './store/serialize.js';

// Observability
export {
  NexaWhatsMetrics,
  type NexaWhatsMetricsOptions,
  HealthServer,
  type HealthServerOptions,
  type HealthSnapshot,
} from './observability/index.js';

// Socket
export { ConnectionStateMachine } from './socket/state-machine.js';
export { CircuitBreaker } from './socket/circuit-breaker.js';
export {
  WsTransport,
  DEFAULT_WS_ORIGIN,
  type WsTransportOptions,
  type WsTransportState,
} from './socket/transport.js';
export {
  makeNoiseHandler,
  CertificateMismatchError,
  NOISE_MODE,
  NOISE_WA_HEADER,
  WA_CERT_DETAILS,
  type NoiseHandler,
  type MakeNoiseHandlerOptions,
  type NoiseHandshakeMessage,
  type NoiseServerHello,
  type RoutingInfo,
} from './socket/noise.js';
export {
  performHandshake,
  type HandshakeIO,
  type PerformHandshakeOptions,
} from './socket/handshake.js';
export {
  createKeepAlive,
  type KeepAliveOptions,
  type KeepAliveController,
} from './socket/keepalive.js';
export {
  bytesToCrockford,
  derivePairingCodeKey,
  generatePairingCode,
  generatePairingKey,
  buildPairDeviceIQ,
  processPairSuccess,
} from './socket/pairing.js';
export {
  connectOnce,
  DEFAULT_WA_URL,
  type ConnectOnceOptions,
  type ConnectOnceResult,
} from './client/connect.js';

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
  decodeBinaryNodeSync,
  decodeBinaryNodes,
  decompressingIfRequired,
  findChildNode,
  findChildNodes,
  hasChildNodes,
  getTextContent,
  getBinaryContent,
  getAllBinaryNodeChildren,
  getBinaryNodeChildren,
  getBinaryNodeChild,
  getBinaryNodeChildBuffer,
  getBinaryNodeChildString,
  getBinaryNodeChildUInt,
  assertNodeErrorFree,
  reduceBinaryNodeToDictionary,
  binaryNodeToString,
  TAGS,
  SINGLE_BYTE_TOKENS,
  DOUBLE_BYTE_TOKENS,
  TOKEN_MAP,
} from './binary/index.js';

// Signal
export type {
  E2ESession,
  SenderKeyDistributionItem,
  SessionMigrationResult,
  SessionValidationResult,
  SignalRepository,
  SignalSessionCiphertext,
} from './signal/libsignal.js';
export { jidToSignalProtocolAddress, makeLibSignalRepository } from './signal/libsignal.js';
export { LIDMappingStore, type LIDPNPair, type PnToLidFunc } from './signal/lid-mapping.js';
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
  isPnUser,
  isJidMetaAI,
  isJidBot,
  isJidStatusBroadcast,
  isHostedPnUser,
  isHostedLidUser,
  phoneFromJid,
  areJidsSameUser,
  transferDevice,
  getServerFromDomainType,
} from './utils/jid.js';
export { retry, sleep, calculateBackoff } from './utils/retry.js';
export {
  generateMessageId,
  generateRandomBytes,
  hkdf,
  hmacSha256,
  hmacSign,
  sha1,
  sha256,
  md5,
  aesEncrypt,
  aesDecrypt,
  aesEncryptGCM,
  aesDecryptGCM,
  Curve,
  type RawKeyPair,
} from './utils/crypto.js';
export { initAuthCreds } from './utils/auth.js';
export { createLogger, defaultLogger, silentLogger } from './utils/logger.js';
export { getPlatform, getDefaultDataDir } from './utils/platform.js';

// Groups
export {
  makeGroupOperations,
  extractGroupMetadata,
  type GroupOperations,
  type GroupOperationsConfig,
} from './groups/index.js';

// Proto — dynamic WAProto bridge over optional `@whiskeysockets/baileys` dep.
// `proto` is a runtime proxy; consumers wanting strict protobuf types
// should import them directly from `@whiskeysockets/baileys`.
export { proto, isProtoAvailable, loadProto } from './proto/index.js';
export type { protoTypes } from './proto/index.js';
