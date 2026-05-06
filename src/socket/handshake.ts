/**
 * Noise handshake driver — orchestrates ClientHello → ServerHello →
 * ClientFinish for a WsTransport. Produces a fully initialised
 * NoiseHandler (encrypt/decrypt ready) by the time it resolves.
 *
 * Pure function — owns no transport lifecycle. Caller opens the
 * transport, calls us, and continues pumping frames through
 * `noise.decodeFrame` for the rest of the session.
 */
import type { Logger } from 'pino';
import { proto } from '../proto/index.js';
import type { AuthenticationCreds } from '../types/auth.js';
import type { RawKeyPair } from '../utils/crypto.js';
import type { NoiseHandler, NoiseHandshakeMessage } from './noise.js';

/**
 * Drives the handshake. Sends ClientHello, awaits the single raw
 * pre-handshake frame that contains ServerHello, derives keys, sends
 * ClientFinish, and calls `noise.finishInit()`. After resolution the
 * caller can start pumping encrypted frames.
 *
 * `sendFrame` writes a framed payload (already wrapped by
 * `noise.encodeFrame`) to the wire. `waitForFrame` returns a promise
 * that resolves with the next buffer the transport emits — the caller
 * is expected to hook this into whatever event plumbing it has.
 */
export interface HandshakeIO {
  sendFrame(frame: Buffer): Promise<void>;
  /** Resolves with the next raw pre-handshake frame (ServerHello). */
  waitForHandshakeReply(timeoutMs: number): Promise<Buffer>;
}

export interface PerformHandshakeOptions {
  noise: NoiseHandler;
  creds: Pick<AuthenticationCreds, 'noiseKey'>;
  /**
   * Public half of the ephemeral keypair the NoiseHandler was built with.
   * Baileys uses a fresh per-connection ephemeral for ClientHello; the
   * long-lived `creds.noiseKey` is only used as the static key via
   * `processHandshake`. The caller (`connect.ts`) generates this pair
   * and wires both into the handler and this call.
   */
  ephemeralPublic: Buffer | Uint8Array;
  /** ClientPayload protobuf message (from generateLogin/RegistrationNode). */
  clientPayload: unknown;
  io: HandshakeIO;
  logger: Logger;
  timeoutMs?: number;
}

export async function performHandshake({
  noise,
  creds,
  ephemeralPublic,
  clientPayload,
  io,
  logger,
  timeoutMs = 20_000,
}: PerformHandshakeOptions): Promise<void> {
  logger.trace('sending ClientHello');
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const HandshakeMessage = (proto as any).HandshakeMessage;
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const ClientPayload = (proto as any).ClientPayload;

  const clientHello = HandshakeMessage.encode({
    clientHello: { ephemeral: ephemeralPublic },
  }).finish();

  await io.sendFrame(noise.encodeFrame(clientHello));

  logger.trace('awaiting ServerHello');
  const serverFrame = await io.waitForHandshakeReply(timeoutMs);

  // The raw WebSocket frame includes a 3-byte noise length prefix
  // (big-endian uint24 payload length at bytes 0-2). Strip it before
  // protobuf decoding — same as noise.decodeFrame's subarray(3, size+3).
  const serverPayload = serverFrame.subarray(3);

  // ServerHello is a HandshakeMessage; decode it.
  const handshake = HandshakeMessage.decode(serverPayload) as NoiseHandshakeMessage;
  if (!handshake.serverHello) {
    throw new Error('handshake reply missing serverHello');
  }

  logger.trace('processing ServerHello');
  const keyEnc = await noise.processHandshake(handshake, creds.noiseKey as RawKeyPair);

  logger.trace('encoding + sending ClientFinish');
  const payloadBytes = ClientPayload.encode(clientPayload).finish();
  const payloadEnc = noise.encrypt(payloadBytes);
  const clientFinish = HandshakeMessage.encode({
    clientFinish: { static: keyEnc, payload: payloadEnc },
  }).finish();

  await io.sendFrame(noise.encodeFrame(clientFinish));

  logger.trace('finishInit');
  await noise.finishInit();
}
