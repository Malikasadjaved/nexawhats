/**
 * Signal Protocol repository interface.
 *
 * Re-exports the live implementation from `libsignal.ts` (Track B D4.4g).
 * Left as a thin alias so existing importers of `./repository.js` keep
 * working.
 */
export type {
  E2ESession,
  SenderKeyDistributionItem,
  SessionMigrationResult,
  SessionValidationResult,
  SignalRepository,
  SignalSessionCiphertext,
} from './libsignal.js';
export { jidToSignalProtocolAddress, makeLibSignalRepository } from './libsignal.js';
