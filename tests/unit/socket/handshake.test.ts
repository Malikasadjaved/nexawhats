/**
 * Handshake driver unit tests — exercises performHandshake() against
 * mocked NoiseHandler + HandshakeTransport to verify protocol sequencing
 * without a live WhatsApp server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandshakeTransport, PerformHandshakeOptions } from '../../../src/socket/handshake.js';
import { performHandshake } from '../../../src/socket/handshake.js';

// ── Pino stub ───────────────────────────────────────────────────────
// biome-ignore lint/suspicious/noExplicitAny: minimal pino stub
const silentLogger: any = {
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  level: 'silent',
};

// ── Test key material ──────────────────────────────────────────────
const noiseKeyPair = {
  private: Buffer.alloc(32, 0x07),
  public: Buffer.alloc(32, 0x09),
};

const ephemeralPublic = Buffer.alloc(32, 0x42);

// Default server hello the mock decodes to.
const defaultServerHello = {
  serverHello: {
    ephemeral: Buffer.alloc(32, 0xaa),
    static: Buffer.alloc(32, 0xbb),
    payload: Buffer.alloc(16),
  },
};

// ── Mock proto module — HandshakeMessage + ClientPayload encode/decode
const mockHandshakeEncode = vi.fn().mockReturnValue({
  finish: () => Buffer.from('mock-handshake-encoded'),
});
const mockHandshakeDecode = vi.fn().mockReturnValue(defaultServerHello);

const mockClientPayloadEncode = vi.fn().mockReturnValue({
  finish: () => Buffer.from('mock-payload-encoded'),
});

vi.mock('../../../src/proto/index.js', () => ({
  proto: new Proxy(
    {},
    {
      get(_target: unknown, prop: string) {
        if (prop === 'HandshakeMessage') {
          return {
            encode: mockHandshakeEncode,
            decode: mockHandshakeDecode,
          };
        }
        if (prop === 'ClientPayload') {
          return { encode: mockClientPayloadEncode };
        }
        throw new Error(`unexpected proto access: ${prop}`);
      },
    },
  ),
}));

// ── Helpers ─────────────────────────────────────────────────────────
function mockNoiseHandler(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    encodeFrame: vi.fn((data: Buffer) => {
      const frame = Buffer.alloc(3 + data.length);
      frame.writeUInt8(data.length >> 16, 0);
      frame.writeUInt16BE(data.length & 0xffff, 1);
      frame.set(data, 3);
      return frame;
    }),
    processHandshake: vi.fn().mockResolvedValue(Buffer.from('encrypted-static-key')),
    encrypt: vi.fn((data: Buffer) => {
      const tag = Buffer.alloc(16, 0xfe);
      return Buffer.concat([tag, data]);
    }),
    finishInit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Build a mock transport — an EventEmitter-like object with send/on/off. */
function mockTransport(
  serverReply: Buffer = Buffer.from([0x00, 0x00, 0x05, 0x0a, 0x01, 0x02, 0x03, 0x04]),
  { delayReply = false } = {},
) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const send = vi.fn().mockResolvedValue(undefined);

  // If delayReply is false, emit the server reply synchronously on next
  // event-loop tick (mimics real network). If true, the test controls
  // when the reply arrives.
  if (!delayReply) {
    send.mockImplementation(() => {
      // Only emit on the FIRST send (ClientHello). The second send is
      // ClientFinish and should NOT emit a second server reply.
      if (send.mock.calls.length === 1) {
        // Schedule the reply to arrive after a microtask — after all
        // synchronous listeners have been wired.
        queueMicrotask(() => {
          const frameListeners = listeners['frame'] ?? [];
          for (const fn of frameListeners) fn(serverReply);
        });
      }
      return Promise.resolve();
    });
  }

  return {
    send,
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      const arr = listeners[event];
      if (arr) {
        const idx = arr.indexOf(listener);
        if (idx !== -1) arr.splice(idx, 1);
      }
    },
    listeners,
    /** Simulate a close during handshake. */
    emitClose() {
      for (const fn of listeners['close'] ?? []) fn();
    },
    /** Simulate a server reply frame. */
    emitFrame(buf: Buffer) {
      for (const fn of listeners['frame'] ?? []) fn(buf);
    },
  };
}

function buildOptions(overrides: Partial<PerformHandshakeOptions> = {}): PerformHandshakeOptions {
  return {
    noise: mockNoiseHandler() as unknown as PerformHandshakeOptions['noise'],
    creds: { noiseKey: noiseKeyPair },
    ephemeralPublic,
    clientPayload: { passive: true, pull: true },
    transport: mockTransport() as unknown as HandshakeTransport,
    logger: silentLogger,
    ...overrides,
  };
}

// Reset shared proto mocks between tests.
beforeEach(() => {
  vi.clearAllMocks();
  mockHandshakeDecode.mockReturnValue(defaultServerHello);
  mockHandshakeEncode.mockReturnValue({ finish: () => Buffer.from('mock-handshake-encoded') });
  mockClientPayloadEncode.mockReturnValue({ finish: () => Buffer.from('mock-payload-encoded') });
});

describe('performHandshake', () => {
  it('sends ClientHello with ephemeral public key as first frame', async () => {
    const transport = mockTransport();
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        transport: transport as unknown as HandshakeTransport,
      }),
    );

    // ClientHello + ClientFinish = 2 frames sent
    expect(transport.send).toHaveBeenCalledTimes(2);
    const firstSend = (transport.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as Buffer;
    expect(firstSend.length).toBeGreaterThan(0);
  });

  it('calls HandshakeMessage.encode with clientHello containing ephemeral', async () => {
    await performHandshake(buildOptions());

    const clientHelloCall = mockHandshakeEncode.mock.calls[0][0];
    expect(clientHelloCall.clientHello).toBeDefined();
    expect(clientHelloCall.clientHello.ephemeral).toBe(ephemeralPublic);
  });

  it('awaits the server reply via transport frame event', async () => {
    const transport = mockTransport();
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        transport: transport as unknown as HandshakeTransport,
      }),
    );

    // ClientHello + ClientFinish = 2 sends
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('rejects when transport emits close during handshake', async () => {
    const transport = mockTransport(
      Buffer.from([0x00, 0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]),
      { delayReply: true },
    );
    const noise = mockNoiseHandler();

    const promise = performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        transport: transport as unknown as HandshakeTransport,
      }),
    );

    // Emit close before the server reply
    transport.emitClose();

    await expect(promise).rejects.toThrow(/closed during handshake/);
  });

  it('decodes the server frame as a HandshakeMessage', async () => {
    const serverFrame = Buffer.from([0x00, 0x00, 0x08, 0xc0, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const transport = mockTransport(serverFrame);
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        transport: transport as unknown as HandshakeTransport,
      }),
    );

    expect(mockHandshakeDecode).toHaveBeenCalledWith(serverFrame.subarray(3));
  });

  it('throws when the decoded handshake lacks serverHello', async () => {
    mockHandshakeDecode.mockReset().mockReturnValue({});

    await expect(performHandshake(buildOptions())).rejects.toThrow(/missing serverHello/);
  });

  it('calls noise.processHandshake with the decoded handshake and noise key', async () => {
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
      }),
    );

    expect(noise.processHandshake).toHaveBeenCalledWith(defaultServerHello, noiseKeyPair);
  });

  it('encodes the clientPayload via ClientPayload.encode and encrypts it', async () => {
    const noise = mockNoiseHandler();
    const payload = { passive: true, pull: true };

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        clientPayload: payload,
      }),
    );

    expect(mockClientPayloadEncode).toHaveBeenCalledWith(payload);
    expect(noise.encrypt).toHaveBeenCalledWith(Buffer.from('mock-payload-encoded'));
  });

  it('sends ClientFinish as the second frame with encrypted static + payload', async () => {
    const transport = mockTransport();
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        transport: transport as unknown as HandshakeTransport,
      }),
    );

    const secondSend = (transport.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as Buffer;
    expect(secondSend.length).toBeGreaterThan(0);

    const clientFinishCall = mockHandshakeEncode.mock.calls[1][0];
    expect(clientFinishCall.clientFinish).toBeDefined();
    expect(clientFinishCall.clientFinish.static).toBeDefined();
    expect(clientFinishCall.clientFinish.payload).toBeDefined();
  });

  it('calls noise.finishInit after sending ClientFinish', async () => {
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
      }),
    );

    expect(noise.finishInit).toHaveBeenCalledOnce();
    const procIdx = (noise.processHandshake as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const encIdx = (noise.encrypt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const finIdx = (noise.finishInit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(procIdx).toBeLessThan(encIdx);
    expect(encIdx).toBeLessThan(finIdx);
  });

  it('sets up frame listener before sending ClientHello', async () => {
    const transport = mockTransport(
      Buffer.from([0x00, 0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]),
      { delayReply: true },
    );
    const noise = mockNoiseHandler();

    // Track whether 'on' was called before 'send'
    const calls: string[] = [];
    const origOn = transport.on.bind(transport);
    const origSend = transport.send.bind(transport);

    transport.on = (event: string, listener: (...args: unknown[]) => void) => {
      calls.push(`on:${event}`);
      return origOn(event, listener);
    };
    (transport.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push('send');
      return Promise.resolve();
    });

    const promise = performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        transport: transport as unknown as HandshakeTransport,
      }),
    );

    // Emit the frame to resolve the handshake
    queueMicrotask(() => {
      transport.emitFrame(Buffer.from([0x00, 0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]));
    });

    await promise;

    // 'on' for frame/close/error should all be called before first 'send'
    const firstSendIdx = calls.indexOf('send');
    const lastOnIdx = Math.max(
      calls.lastIndexOf('on:frame'),
      calls.lastIndexOf('on:close'),
      calls.lastIndexOf('on:error'),
    );
    // All listeners must be wired before the first send
    expect(lastOnIdx).toBeLessThan(firstSendIdx);
  });
});
