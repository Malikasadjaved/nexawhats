/**
 * Single-connection driver — opens a WebSocket, runs the Noise
 * handshake, starts the frame pump, and returns a disposal handle.
 *
 * Pure function — owns no global state. The caller (client.ts) wraps
 * this in a retry loop with circuit breaker + reconnect backoff.
 */
import type { Logger } from 'pino';
import { encodeBinaryNode } from '../binary/encoder.js';
import type { BinaryNode } from '../binary/index.js';
import { S_WHATSAPP_NET } from '../binary/jid.js';
import { type HandshakeIO, performHandshake } from '../socket/handshake.js';
import { type KeepAliveController, createKeepAlive } from '../socket/keepalive.js';
import { type NoiseHandler, makeNoiseHandler } from '../socket/noise.js';
import { WsTransport } from '../socket/transport.js';
import type { AuthenticationCreds } from '../types/auth.js';
import type { WABrowserDescription, WAVersion } from '../types/socket.js';
import { type RawKeyPair, generateMessageId } from '../utils/crypto.js';

/** Default WhatsApp WebSocket endpoint. */
export const DEFAULT_WA_URL = 'wss://web.whatsapp.com/ws/chat';

/** Default keepalive interval (matches Baileys). */
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 25_000;

// ── Options ─────────────────────────────────────────────────────────

export interface ConnectOnceOptions {
  /** WhatsApp WebSocket URL. */
  waUrl?: string;
  /** Full auth credentials (noiseKey used for handshake static). */
  creds: AuthenticationCreds;
  /**
   * Ephemeral keypair for this connection. The caller generates a fresh
   * one per connect attempt; the public half is sent in ClientHello.
   */
  ephemeralKeyPair: RawKeyPair;
  /** ClientPayload — either login (registered) or registration (fresh pair). */
  clientPayload: unknown;
  /** Called for each decoded binary node from the server post-handshake. */
  onFrame: (node: BinaryNode) => void;
  /** Logger. */
  logger: Logger;
  /** Browser triple for the User-Agent / pairing fingerprint. */
  browser: WABrowserDescription;
  /** WA Web version tuple. */
  version: WAVersion;
  /** Connection timeout in ms (default 20_000). */
  connectTimeoutMs?: number;
  /** Keep-alive interval in ms (default 25_000). */
  keepAliveIntervalMs?: number;
}

// ── Result ──────────────────────────────────────────────────────────

export interface ConnectOnceResult {
  /** Post-handshake noise handler (encrypt/decrypt ready). */
  noise: NoiseHandler;
  /** The open transport. */
  transport: WsTransport;
  /** Keepalive controller — caller can stop/start. */
  keepAlive: KeepAliveController;
  /** Send a binary node (encodes → noise-frames → sends). */
  sendNode: (node: BinaryNode) => Promise<void>;
  /** Close transport and stop keepalive. */
  dispose: () => void;
}

// ── Driver ──────────────────────────────────────────────────────────

export async function connectOnce({
  waUrl = DEFAULT_WA_URL,
  creds,
  ephemeralKeyPair,
  clientPayload,
  onFrame,
  logger,
  connectTimeoutMs = 20_000,
  keepAliveIntervalMs = DEFAULT_KEEP_ALIVE_INTERVAL_MS,
}: ConnectOnceOptions): Promise<ConnectOnceResult> {
  const transport = new WsTransport();

  // ── 1. Open WebSocket ────────────────────────────────────────────
  logger.info({ url: waUrl }, 'connecting');
  await transport.connect(waUrl, { connectTimeoutMs });

  // ── 2. Noise handshake ───────────────────────────────────────────
  const noise = makeNoiseHandler({
    keyPair: ephemeralKeyPair,
    logger,
  });

  // Build handshake IO over the transport.
  // `waitForHandshakeReply` captures the SINGLE raw ServerHello frame
  // that arrives between ClientHello and ClientFinish.
  const handshakeIO: HandshakeIO = {
    sendFrame: (frame: Buffer) => transport.send(frame),
    waitForHandshakeReply: (timeoutMs: number) =>
      new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          transport.off('frame', onRawFrame);
          reject(new Error(`ServerHello timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const onRawFrame = (buf: Buffer): void => {
          clearTimeout(timer);
          transport.off('frame', onRawFrame);
          resolve(buf);
        };

        transport.once('frame', onRawFrame);
        // Also handle transport errors during the wait.
        transport.once('error', (err: Error) => {
          clearTimeout(timer);
          transport.off('frame', onRawFrame);
          reject(err);
        });
      }),
  };

  await performHandshake({
    noise,
    creds: { noiseKey: creds.noiseKey },
    ephemeralPublic: ephemeralKeyPair.public,
    clientPayload,
    io: handshakeIO,
    logger,
    timeoutMs: connectTimeoutMs,
  });

  logger.info('handshake complete');

  // ── 3. Wire frame pump (post-handshake, decoded BinaryNodes) ─────
  // After the handshake, every frame from the transport goes through
  // noise.decodeFrame — which decrypts + decodes into BinaryNodes.
  transport.on('frame', (buf: Buffer) => {
    noise
      .decodeFrame(buf, (node) => {
        if (Buffer.isBuffer(node)) {
          // Pre-handshake raw frames shouldn't arrive after handshake,
          // but handle gracefully.
          logger.trace({ len: node.length }, 'unexpected raw frame post-handshake');
          return;
        }
        onFrame(node);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'decodeFrame error');
      });
  });

  // ── 4. Keepalive ────────────────────────────────────────────────
  const keepAlive = createKeepAlive({
    logger,
    keepAliveIntervalMs,
    sendPing: async () => {
      const pingNode: BinaryNode = {
        tag: 'iq',
        attrs: {
          id: generateMessageId(),
          to: S_WHATSAPP_NET,
          type: 'get',
          xmlns: 'w:p',
        },
        content: [{ tag: 'ping', attrs: {} }],
      };
      const encoded = encodeBinaryNode(pingNode);
      const framed = noise.encodeFrame(encoded);
      await transport.send(framed);
    },
    onConnectionLost: (reason: string) => {
      logger.warn({ reason }, 'connection lost — keepalive timeout');
      transport.close(1001, reason);
    },
  });

  // Mark initial frame receipt so the watchdog doesn't fire immediately.
  keepAlive.receivedFrame();

  // Reset the liveness timer on every frame.
  transport.on('frame', () => keepAlive.receivedFrame());

  keepAlive.start();

  // ── 5. sendNode helper ───────────────────────────────────────────
  const sendNode = async (node: BinaryNode): Promise<void> => {
    const encoded = encodeBinaryNode(node);
    const framed = noise.encodeFrame(encoded);
    await transport.send(framed);
  };

  // ── 6. Disposer ──────────────────────────────────────────────────
  const dispose = (): void => {
    keepAlive.stop();
    transport.close(1000, 'client disconnect');
  };

  return { noise, transport, keepAlive, sendNode, dispose };
}
