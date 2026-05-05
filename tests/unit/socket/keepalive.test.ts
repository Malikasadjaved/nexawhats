/**
 * Keepalive watchdog unit tests — exercises createKeepAlive with
 * vitest fake timers to control interval ticks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeepAlive } from '../../../src/socket/keepalive.js';

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

function buildOpts(overrides: Record<string, unknown> = {}) {
  return {
    logger: silentLogger,
    keepAliveIntervalMs: 30_000,
    sendPing: vi.fn().mockResolvedValue(undefined),
    onConnectionLost: vi.fn(),
    ...overrides,
  };
}

describe('createKeepAlive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() begins a recurring interval that calls sendPing', () => {
    const opts = buildOpts();
    const ka = createKeepAlive(opts);

    ka.start();
    expect(opts.sendPing).not.toHaveBeenCalled();

    // Advance one interval — ping should fire
    vi.advanceTimersByTime(30_000);
    expect(opts.sendPing).toHaveBeenCalledTimes(1);

    // Advance another — second ping
    vi.advanceTimersByTime(30_000);
    expect(opts.sendPing).toHaveBeenCalledTimes(2);
  });

  it('start() is idempotent — calling twice does not double-tick', () => {
    const opts = buildOpts();
    const ka = createKeepAlive(opts);

    ka.start();
    ka.start();

    vi.advanceTimersByTime(30_000);
    expect(opts.sendPing).toHaveBeenCalledTimes(1);
  });

  it('stop() halts the interval', () => {
    const opts = buildOpts();
    const ka = createKeepAlive(opts);

    ka.start();
    vi.advanceTimersByTime(30_000);
    expect(opts.sendPing).toHaveBeenCalledTimes(1);

    ka.stop();
    vi.advanceTimersByTime(60_000);
    // No additional pings after stop
    expect(opts.sendPing).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent', () => {
    const opts = buildOpts();
    const ka = createKeepAlive(opts);

    ka.start();
    ka.stop();
    ka.stop(); // must not throw
  });

  it('receivedFrame() resets the liveness timer', () => {
    const opts = buildOpts();
    const ka = createKeepAlive(opts);

    ka.start();

    // Simulate receiving a frame right before the ping
    vi.advanceTimersByTime(29_000);
    ka.receivedFrame();
    vi.advanceTimersByTime(1_000);

    // Ping fires — but lastDateRecv is just 1s ago, so onConnectionLost NOT called
    expect(opts.sendPing).toHaveBeenCalledTimes(1);
    expect(opts.onConnectionLost).not.toHaveBeenCalled();
  });

  it('calls onConnectionLost when no frame received within grace period', () => {
    const opts = buildOpts();
    const ka = createKeepAlive(opts);

    ka.start();

    // Tick 1 at 30s: initializes lastDateRecv, diff=0 < 35s, sends ping
    vi.advanceTimersByTime(30_000);
    expect(opts.onConnectionLost).not.toHaveBeenCalled();

    // Tick 2 at 60s: lastDateRecv = 30s (tick 1), diff=30s < 35s, sends ping
    vi.advanceTimersByTime(30_000);
    expect(opts.onConnectionLost).not.toHaveBeenCalled();

    // Tick 3 at 90s: lastDateRecv = 30s, diff=60s > 35s → connection lost
    vi.advanceTimersByTime(30_001);
    expect(opts.onConnectionLost).toHaveBeenCalledWith('Connection was lost');
  });

  it('does not call onConnectionLost when receivedFrame is called within the grace', () => {
    const opts = buildOpts();
    const ka = createKeepAlive(opts);

    ka.start();

    // Advance to just before the third tick, calling receivedFrame along the way
    vi.advanceTimersByTime(30_000); // tick 1
    vi.advanceTimersByTime(25_000); // 55s total
    ka.receivedFrame(); // resets last seen to 55s
    vi.advanceTimersByTime(5_000); // 60s → tick 2, diff=5s < 35s
    vi.advanceTimersByTime(30_000); // 90s → tick 3, diff=35s (not > 35s)
    expect(opts.onConnectionLost).not.toHaveBeenCalled();
  });

  it('sendPing rejection is logged but does not crash the interval', async () => {
    const errorLogger = {
      ...silentLogger,
      error: vi.fn(),
    };
    const opts = buildOpts({
      logger: errorLogger,
      sendPing: vi.fn().mockRejectedValue(new Error('send failed')),
    });
    const ka = createKeepAlive(opts);

    ka.start();
    vi.advanceTimersByTime(30_000);

    // Let the rejected promise microtask flush
    await Promise.resolve();

    // Ping was attempted
    expect(opts.sendPing).toHaveBeenCalledTimes(1);
    // Error was logged
    expect(errorLogger.error).toHaveBeenCalled();
    // Next tick still fires
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(opts.sendPing).toHaveBeenCalledTimes(2);
  });
});
