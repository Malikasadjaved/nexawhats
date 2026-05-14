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
 * Minimal transport interface — the caller must provide a send function
 * and an EventEmitter-like object that emits 'frame' (Buffer) and
 * 'close' / 'error' events during the handshake window.
 */
export interface HandshakeTransport {
  send(frame: Buffer): Promise<void>;
  on(event: 'frame' | 'close' | 'error', listener: (...args: any[]) => void): void;
  off(event: 'frame' | 'close' | 'error', listener: (...args: any[]) => void): void;
}

export interface PerformHandshakeOptions {
  noise: NoiseHandler;
  creds: Pick<AuthenticationCreds, 'noiseKey'>;
  /**
   * Public half of the ephemeral keypair the NoiseHandler was built with.
   */
  ephemeralPublic: Buffer | Uint8Array;
  /** ClientPayload protobuf message (from generateLogin/RegistrationNode). */
  clientPayload: unknown;
  /** The open transport. */
  transport: HandshakeTransport;
  logger: Logger;
  timeoutMs?: number;
}

/**
 * Drives the handshake. Sets up the ServerHello listener BEFORE sending
 * the ClientHello (matching Baileys' awaitNextMessage pattern), then
 * processes the handshake and sends ClientFinish.
 */
export async function performHandshake({
  noise,
  creds,
  ephemeralPublic,
  clientPayload,
  transport,
  logger,
  timeoutMs = 20_000,
}: PerformHandshakeOptions): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const HandshakeMessage = (proto as any).HandshakeMessage;
  // biome-ignore lint/suspicious/noExplicitAny: proto runtime types
  const ClientPayload = (proto as any).ClientPayload;

  const clientHello = HandshakeMessage.encode({
    clientHello: { ephemeral: ephemeralPublic },
  }).finish();

  // ── Set up ServerHello listener BEFORE sending ClientHello ──────
  // This matches Baileys' awaitNextMessage() pattern: listeners are
  // wired synchronously, then the send happens. If the server responds
  // between the send resolving and the next microtask, the listener is
  // already in place.
  const serverFrame = await new Promise<Buffer>((resolve, reject) => {
    let settled = false;

    const onFrame = (buf: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buf);
    };

    const onClose = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Transport closed during handshake'));
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`ServerHello timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      transport.off('frame', onFrame);
      transport.off('close', onClose);
      transport.off('error', onError);
    };

    transport.on('frame', onFrame);
    transport.on('close', onClose);
    transport.on('error', onError);

    // Send ClientHello AFTER listeners are in place
    logger.trace('sending ClientHello');
    transport.send(noise.encodeFrame(clientHello)).catch((err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });

  logger.trace('ServerHello received');

  // Strip the 3-byte noise length prefix from the raw WebSocket frame
  const serverPayload = serverFrame.subarray(3);

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

  await transport.send(noise.encodeFrame(clientFinish));

  logger.trace('finishInit');
  await noise.finishInit();
}
