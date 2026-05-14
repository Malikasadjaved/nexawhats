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
import { performHandshake } from '../socket/handshake.js';
import { type KeepAliveController, createKeepAlive } from '../socket/keepalive.js';
import { type NoiseHandler, makeNoiseHandler } from '../socket/noise.js';
import { WsTransport } from '../socket/transport.js';
import type { AuthenticationCreds } from '../types/auth.js';
import type { WABrowserDescription, WAVersion } from '../types/socket.js';
import { type RawKeyPair, generateMessageId } from '../utils/crypto.js';

/** Default WhatsApp WebSocket endpoint. */
export const DEFAULT_WA_URL = 'wss://web.whatsapp.com/ws/chat';

/** Default keepalive interval (matches Baileys). */
const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 30_000;

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
  /** Keep-alive interval in ms (default 30_000). */
  keepAliveIntervalMs?: number;
  /** Called when the transport closes unexpectedly (keepalive timeout, server close). */
  onUnexpectedClose?: (reason: string) => void;
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
  onUnexpectedClose,
}: ConnectOnceOptions): Promise<ConnectOnceResult> {
  // Append routingInfo to URL if present (matches Baileys: edge_routing
  // supplies routing info that must be sent on reconnect).
  let effectiveUrl = waUrl;
  if (creds.routingInfo) {
    const sep = waUrl.includes('?') ? '&' : '?';
    effectiveUrl = `${waUrl}${sep}ED=${creds.routingInfo.toString('base64url')}`;
  }

  const transport = new WsTransport();

  // ── 1. Open WebSocket ────────────────────────────────────────────
  logger.info({ url: effectiveUrl }, 'connecting');
  await transport.connect(effectiveUrl, { connectTimeoutMs });

  // ── 2. Noise handshake ───────────────────────────────────────────
  const noise = makeNoiseHandler({
    keyPair: ephemeralKeyPair,
    logger,
    routingInfo: creds.routingInfo,
  });

  await performHandshake({
    noise,
    creds: { noiseKey: creds.noiseKey },
    ephemeralPublic: ephemeralKeyPair.public,
    clientPayload,
    transport,
    logger,
    timeoutMs: connectTimeoutMs,
  });

  logger.info('handshake complete');

  // ── 3. Wire frame pump (post-handshake, decoded BinaryNodes) ─────
  transport.on('frame', (buf: Buffer) => {
    noise
      .decodeFrame(buf, (node) => {
        if (Buffer.isBuffer(node)) {
          logger.trace({ len: node.length }, 'unexpected raw frame post-handshake');
          return;
        }
        onFrame(node);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'decodeFrame error');
      });
  });

  // ── 4. Mark connection as failed when transport closes ───────────
  let closeReported = false;
  transport.on('close', () => {
    if (!closeReported) {
      closeReported = true;
      onUnexpectedClose?.('Transport closed');
    }
  });

  // ── 5. Keepalive ────────────────────────────────────────────────
  const keepAlive = createKeepAlive({
    logger,
    keepAliveIntervalMs,
    sendPing: async () => {
      if (!transport.isOpen) {
        logger.warn('keepalive ping skipped — transport not open');
        return;
      }
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
      closeReported = true;
      transport.close(1001, reason);
      onUnexpectedClose?.(reason);
    },
  });

  // Mark initial frame receipt so the watchdog doesn't fire immediately.
  keepAlive.receivedFrame();

  // Reset the liveness timer on every frame.
  transport.on('frame', () => keepAlive.receivedFrame());

  keepAlive.start();

  // ── 6. sendNode helper ───────────────────────────────────────────
  const sendNode = async (node: BinaryNode): Promise<void> => {
    if (!transport.isOpen) {
      throw new Error('Cannot send — transport is not open');
    }
    const encoded = encodeBinaryNode(node);
    const framed = noise.encodeFrame(encoded);
    await transport.send(framed);
  };

  // ── 7. Disposer ──────────────────────────────────────────────────
  const dispose = (): void => {
    keepAlive.stop();
    transport.close(1000, 'client disconnect');
  };

  return { noise, transport, keepAlive, sendNode, dispose };
}
