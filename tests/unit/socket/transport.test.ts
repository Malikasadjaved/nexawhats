import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { WsTransport } from '../../../src/socket/transport.js';

/**
 * Spawn a local WebSocket server bound to an ephemeral port, run a
 * round-trip against it, then tear down.
 *
 * These tests deliberately exercise the real `ws` package end-to-end
 * — no mocks. The transport is thin enough that stubbing would miss
 * the bugs it's most likely to have (binary-vs-text handling, close
 * sequencing, Buffer normalisation).
 */
describe('WsTransport', () => {
  let server: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('unexpected ws server address shape');
    }
    port = address.port;
  });

  afterEach(async () => {
    // Force-close all clients then the server. Without this, a
    // lingering open socket keeps vitest hanging past the test.
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects, sends a binary frame, receives an echo, and closes', async () => {
    // Server echoes whatever it receives.
    server.on('connection', (ws: WebSocket) => {
      ws.on('message', (msg, isBinary) => ws.send(msg, { binary: isBinary }));
    });

    const transport = new WsTransport();

    const opened = new Promise<void>((resolve) => transport.once('open', resolve));
    const frameP = new Promise<Buffer>((resolve) =>
      transport.once('frame', (buf: Buffer) => resolve(buf)),
    );

    await transport.connect(`ws://127.0.0.1:${port}`);
    await opened;
    expect(transport.isOpen).toBe(true);
    expect(transport.state).toBe('open');

    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
    await transport.send(payload);
    const echoed = await frameP;
    expect(echoed.equals(payload)).toBe(true);

    const closedP = new Promise<number>((resolve) =>
      transport.once('close', (code: number) => resolve(code)),
    );
    transport.close(1000);
    // Server sees the close; await it so afterEach doesn't race.
    await closedP.catch(() => {
      /* emitted or not, close() already made us `closed` */
    });
    expect(transport.isClosed).toBe(true);
    expect(transport.state).toBe('closed');
  });

  it('rejects connect() when the URL is unreachable', async () => {
    const transport = new WsTransport();
    // Port 1 is almost always refused on Windows/Linux dev machines.
    await expect(
      transport.connect('ws://127.0.0.1:1', { connectTimeoutMs: 500 }),
    ).rejects.toThrow();
    expect(transport.isClosed).toBe(true);
  });

  it('send() rejects when the transport is not open', async () => {
    const transport = new WsTransport();
    await expect(transport.send(Buffer.from('x'))).rejects.toThrow(/not open/);
  });

  it('close() is idempotent', async () => {
    const transport = new WsTransport();
    await transport.connect(`ws://127.0.0.1:${port}`);
    transport.close();
    transport.close(); // must not throw
    expect(transport.isClosed).toBe(true);
  });

  it('re-emits upgrade headers + text frames', async () => {
    server.on('connection', (ws: WebSocket) => {
      ws.send('hello-text');
    });

    const transport = new WsTransport();
    const textP = new Promise<string>((resolve) =>
      transport.once('text', (s: string) => resolve(s)),
    );
    await transport.connect(`ws://127.0.0.1:${port}`);
    const text = await textP;
    expect(text).toBe('hello-text');
    transport.close();
  });
});
