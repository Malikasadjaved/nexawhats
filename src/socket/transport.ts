/**
 * Thin EventEmitter wrapper around the `ws` package.
 *
 * Responsibilities are deliberately narrow:
 * - Establish a WebSocket connection to the given URL with custom
 *   headers, origin, and timeouts
 * - Surface binary frames as `frame` events (Buffer)
 * - Surface lifecycle as `open`, `close`, `error` events
 * - Offer `send(frame)` and `close(code?, reason?)` methods
 *
 * Non-responsibilities (lived elsewhere):
 * - Noise handshake          → socket/noise.ts
 * - Reconnect / backoff      → socket/state-machine.ts + client.ts
 * - Keepalive ping           → client.ts keeps a timer
 *
 * This class is transport-agnostic: the consumer hands us a URL and
 * we hand back frames. It does NOT know anything about WhatsApp.
 */
import { EventEmitter } from 'node:events';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

/** Default origin WhatsApp Web asserts — matches Baileys. */
export const DEFAULT_WS_ORIGIN = 'https://web.whatsapp.com';

export interface WsTransportOptions {
  /** Sent as the `Origin:` header — WA rejects connections without it. */
  origin?: string;
  /** Additional request headers. */
  headers?: Record<string, string>;
  /** WS handshake timeout in ms. Default 20_000. */
  connectTimeoutMs?: number;
  /**
   * Optional HTTP(S) agent — needed for proxies. Kept as `unknown` so
   * callers can pass any `http.Agent`-compatible value without pulling
   * in `http` types here.
   */
  // biome-ignore lint/suspicious/noExplicitAny: ws accepts any Agent
  agent?: any;
}

/** Lifecycle states the transport can be in. */
export type WsTransportState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

/**
 * Events emitted:
 *
 * - `open`                         — the socket handshake completed
 * - `frame` (data: Buffer)         — a binary frame arrived
 * - `text` (data: string)          — a text frame arrived (rare on WA)
 * - `close` (code: number, reason: Buffer)
 * - `error` (err: Error)
 */
export class WsTransport extends EventEmitter {
  private socket: WebSocket | null = null;
  private _state: WsTransportState = 'idle';

  /** URL the transport was last asked to connect to (or `null`). */
  private _url: string | null = null;

  get state(): WsTransportState {
    return this._state;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get isClosed(): boolean {
    return this.socket === null || this.socket.readyState === WebSocket.CLOSED;
  }

  /**
   * Open a new WebSocket to `url`. If a socket already exists this
   * call is a no-op (matches Baileys' `WebSocketClient.connect()`).
   *
   * Returns a promise that resolves on `open` or rejects on `error`/
   * connect timeout. The caller may alternatively listen on the
   * events directly and ignore the return value.
   */
  connect(url: string, opts: WsTransportOptions = {}): Promise<void> {
    if (this.socket !== null) {
      return Promise.resolve();
    }

    const wsOptions: ClientOptions = {
      origin: opts.origin ?? DEFAULT_WS_ORIGIN,
      headers: opts.headers,
      handshakeTimeout: opts.connectTimeoutMs ?? 20_000,
      agent: opts.agent,
    };

    this._url = url;
    this._state = 'connecting';
    const socket = new WebSocket(url, wsOptions);
    this.socket = socket;
    socket.setMaxListeners(0);
    // Prefer Node Buffers over ArrayBuffer — cheaper for downstream
    // framing code that uses `Buffer.concat`.
    socket.binaryType = 'nodebuffer';

    return new Promise((resolve, reject) => {
      let settled = false;

      const onOpen = (): void => {
        this._state = 'open';
        this.emit('open');
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const onError = (err: Error): void => {
        // EventEmitter throws when `error` is emitted with no
        // listeners — swallow the emit when the caller hasn't hooked
        // `error` yet. The returned promise still rejects below.
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        if (!settled) {
          settled = true;
          this._state = 'closed';
          this.socket = null;
          reject(err);
        }
      };

      const onClose = (code: number, reason: Buffer): void => {
        this._state = 'closed';
        this.socket = null;
        this.emit('close', code, reason);
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `websocket closed before open (code=${code}, reason=${reason.toString('utf8')})`,
            ),
          );
        }
      };

      const onMessage = (data: RawData, isBinary: boolean): void => {
        if (isBinary) {
          // `RawData` can be Buffer | ArrayBuffer | Buffer[]; normalise.
          const buf = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data as ArrayBuffer);
          this.emit('frame', buf);
        } else {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Buffer.from(data as ArrayBuffer).toString('utf8');
          this.emit('text', text);
        }
      };

      socket.on('open', onOpen);
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.on('message', onMessage);

      // Passthrough for debugging — matches Baileys' listener list.
      socket.on('upgrade', (res) => this.emit('upgrade', res));
      socket.on('unexpected-response', (req, res) => this.emit('unexpected-response', req, res));
      socket.on('ping', (data) => this.emit('ping', data));
      socket.on('pong', (data) => this.emit('pong', data));
    });
  }

  /** Send a binary frame. Returns `true` if the socket accepted it. */
  send(frame: Buffer | Uint8Array): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('transport is not open'));
    }
    return new Promise<void>((resolve, reject) => {
      // biome-ignore lint/style/noNonNullAssertion: checked above
      this.socket!.send(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Close the WebSocket. Safe to call multiple times — subsequent
   * calls are no-ops.
   */
  close(code = 1000, reason?: string): void {
    if (!this.socket) return;
    this._state = 'closing';
    try {
      this.socket.close(code, reason);
    } catch {
      // `ws` throws on invalid codes — fall through and ensure the
      // reference is dropped so `isClosed` goes true.
    }
    this.socket = null;
    this._state = 'closed';
  }

  /** The URL last passed to `connect()`, or `null` if never connected. */
  get url(): string | null {
    return this._url;
  }
}
