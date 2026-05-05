/**
 * Keepalive watchdog — periodic ping + connection-lost detection.
 *
 * Ported from Baileys' `socket.js` `startKeepAliveRequest`. Sends a
 * WhatsApp ping IQ every `keepAliveIntervalMs` and triggers
 * `onConnectionLost` when the server hasn't responded within
 * `keepAliveIntervalMs + 5000` ms.
 */
import type { Logger } from 'pino';

export interface KeepAliveOptions {
  logger: Logger;
  /** Interval between pings in ms. Baileys defaults to 30_000. */
  keepAliveIntervalMs: number;
  /** Called to send a ping frame. Should reject on send failure. */
  sendPing: () => Promise<void>;
  /** Called when the connection is deemed lost (no reply within grace). */
  onConnectionLost: (reason: string) => void;
}

export interface KeepAliveController {
  /** Call on every received frame to reset the liveness timer. */
  receivedFrame(): void;
  /** Start the keepalive interval. Safe to call multiple times. */
  start(): void;
  /** Stop the keepalive interval. Idempotent. */
  stop(): void;
}

export function createKeepAlive({
  logger,
  keepAliveIntervalMs,
  sendPing,
  onConnectionLost,
}: KeepAliveOptions): KeepAliveController {
  let lastDateRecv: Date | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const receivedFrame = (): void => {
    lastDateRecv = new Date();
  };

  const start = (): void => {
    if (intervalId !== null) return;

    intervalId = setInterval(() => {
      if (!lastDateRecv) {
        lastDateRecv = new Date();
      }
      const diff = Date.now() - lastDateRecv.getTime();
      if (diff > keepAliveIntervalMs + 5000) {
        logger.warn({ diff }, 'keepalive: connection lost');
        onConnectionLost('Connection was lost');
        return;
      }
      logger.trace('keepalive: sending ping');
      sendPing().catch((err: unknown) => {
        logger.error({ err }, 'keepalive: ping failed');
      });
    }, keepAliveIntervalMs);
  };

  const stop = (): void => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  return { receivedFrame, start, stop };
}
