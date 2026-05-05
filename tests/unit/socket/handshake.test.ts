/**
 * Handshake driver unit tests — exercises performHandshake() against
 * mocked NoiseHandler + HandshakeIO to verify protocol sequencing
 * without a live WhatsApp server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandshakeIO, PerformHandshakeOptions } from '../../../src/socket/handshake.js';
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

function mockIO(
  serverReply: Buffer = Buffer.from([0x00, 0x00, 0x05, 0x0a, 0x01, 0x02, 0x03, 0x04]),
) {
  return {
    sendFrame: vi.fn().mockResolvedValue(undefined),
    waitForHandshakeReply: vi.fn().mockResolvedValue(serverReply),
  };
}

function buildOptions(overrides: Partial<PerformHandshakeOptions> = {}): PerformHandshakeOptions {
  return {
    noise: mockNoiseHandler() as unknown as PerformHandshakeOptions['noise'],
    creds: { noiseKey: noiseKeyPair },
    ephemeralPublic,
    clientPayload: { passive: true, pull: true },
    io: mockIO() as unknown as HandshakeIO,
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
    const io = mockIO();
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        io: io as unknown as HandshakeIO,
      }),
    );

    // ClientHello + ClientFinish = 2 frames sent
    expect(io.sendFrame).toHaveBeenCalledTimes(2);
    const firstSend = (io.sendFrame as ReturnType<typeof vi.fn>).mock.calls[0][0] as Buffer;
    expect(firstSend.length).toBeGreaterThan(0);
  });

  it('calls HandshakeMessage.encode with clientHello containing ephemeral', async () => {
    await performHandshake(buildOptions());

    // First call to HandshakeMessage.encode is ClientHello
    const clientHelloCall = mockHandshakeEncode.mock.calls[0][0];
    expect(clientHelloCall.clientHello).toBeDefined();
    expect(clientHelloCall.clientHello.ephemeral).toBe(ephemeralPublic);
  });

  it('awaits the server reply via waitForHandshakeReply', async () => {
    const io = mockIO();
    await performHandshake(buildOptions({ io: io as unknown as HandshakeIO }));
    expect(io.waitForHandshakeReply).toHaveBeenCalledWith(20_000);
  });

  it('passes a custom timeoutMs to waitForHandshakeReply', async () => {
    const io = mockIO();
    await performHandshake(buildOptions({ io: io as unknown as HandshakeIO, timeoutMs: 10_000 }));
    expect(io.waitForHandshakeReply).toHaveBeenCalledWith(10_000);
  });

  it('decodes the server frame as a HandshakeMessage', async () => {
    const serverFrame = Buffer.from('custom-server-frame');
    const io = mockIO(serverFrame);

    await performHandshake(buildOptions({ io: io as unknown as HandshakeIO }));

    expect(mockHandshakeDecode).toHaveBeenCalledWith(serverFrame);
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
    const io = mockIO();
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        io: io as unknown as HandshakeIO,
      }),
    );

    // Second sendFrame is ClientFinish
    const secondSend = (io.sendFrame as ReturnType<typeof vi.fn>).mock.calls[1][0] as Buffer;
    expect(secondSend.length).toBeGreaterThan(0);

    // ClientFinish HandshakeMessage encode should include static + payload
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

    // finishInit is called once, and AFTER processHandshake + encrypt
    expect(noise.finishInit).toHaveBeenCalledOnce();
    // processHandshake resolves before encrypt; encrypt before finishInit.
    // Verify the call order within the noise mock itself:
    const procIdx = (noise.processHandshake as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const encIdx = (noise.encrypt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const finIdx = (noise.finishInit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(procIdx).toBeLessThan(encIdx);
    expect(encIdx).toBeLessThan(finIdx);
  });

  it('ensures ClientHello is sent before awaiting ServerHello', async () => {
    const io = mockIO();
    const noise = mockNoiseHandler();

    await performHandshake(
      buildOptions({
        noise: noise as unknown as PerformHandshakeOptions['noise'],
        io: io as unknown as HandshakeIO,
      }),
    );

    // The first sendFrame invocation (ClientHello) must precede
    // waitForHandshakeReply in invocation order.
    const sendIdx = (io.sendFrame as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const waitIdx = (io.waitForHandshakeReply as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(sendIdx).toBeLessThan(waitIdx);
  });
});
