import { describe, expect, it, vi } from 'vitest';
import { MiddlewarePipeline } from '../../../src/middleware/index.js';
import type { Context } from '../../../src/middleware/types.js';

function createMockContext(overrides: Partial<Context> = {}): Context {
  return {
    message: { key: { remoteJid: '123@s.whatsapp.net', fromMe: false, id: 'msg1' } },
    jid: '123@s.whatsapp.net',
    senderName: 'Test',
    isGroup: false,
    text: 'hello',
    timestamp: Math.floor(Date.now() / 1000),
    store: {} as Context['store'],
    reply: vi.fn(),
    resolveLID: vi.fn().mockResolvedValue('123@s.whatsapp.net'),
    state: {},
    ...overrides,
  };
}

describe('MiddlewarePipeline', () => {
  it('should execute middleware in order', async () => {
    const pipeline = new MiddlewarePipeline();
    const order: number[] = [];

    pipeline.use(async (_ctx, next) => {
      order.push(1);
      await next();
      order.push(4);
    });
    pipeline.use(async (_ctx, next) => {
      order.push(2);
      await next();
      order.push(3);
    });

    await pipeline.execute(createMockContext());
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('should allow middleware to short-circuit (skip next)', async () => {
    const pipeline = new MiddlewarePipeline();
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    pipeline.use(async (_ctx, _next) => {
      fn1();
      // Not calling next() — pipeline stops here
    });
    pipeline.use(async (_ctx, next) => {
      fn2();
      await next();
    });

    await pipeline.execute(createMockContext());
    expect(fn1).toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('should throw if next() called multiple times', async () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use(async (_ctx, next) => {
      await next();
      await expect(next()).rejects.toThrow('next() called multiple times');
    });

    await pipeline.execute(createMockContext());
  });

  it('should propagate errors', async () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use(async (_ctx, _next) => {
      throw new Error('middleware error');
    });

    await expect(pipeline.execute(createMockContext())).rejects.toThrow('middleware error');
  });

  it('should allow middleware to modify context', async () => {
    const pipeline = new MiddlewarePipeline();

    pipeline.use(async (ctx, next) => {
      ctx.state.processed = true;
      await next();
    });

    pipeline.use(async (ctx, next) => {
      expect(ctx.state.processed).toBe(true);
      await next();
    });

    await pipeline.execute(createMockContext());
  });

  it('should handle empty pipeline', async () => {
    const pipeline = new MiddlewarePipeline();
    await expect(pipeline.execute(createMockContext())).resolves.toBeUndefined();
  });

  it('should report correct size', () => {
    const pipeline = new MiddlewarePipeline();
    expect(pipeline.size).toBe(0);
    pipeline.use(async (_ctx, next) => next());
    expect(pipeline.size).toBe(1);
    pipeline.use(async (_ctx, next) => next());
    expect(pipeline.size).toBe(2);
  });
});
