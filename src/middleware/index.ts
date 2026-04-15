import type { Context, Middleware } from './types.js';

export type { Context, Middleware, NextFn } from './types.js';

/**
 * Koa-style middleware pipeline.
 *
 * @example
 * const pipeline = new MiddlewarePipeline();
 * pipeline.use(async (ctx, next) => {
 *   console.log('before');
 *   await next();
 *   console.log('after');
 * });
 * await pipeline.execute(ctx);
 */
export class MiddlewarePipeline {
  private readonly stack: Middleware[] = [];

  /** Add middleware to the pipeline */
  use(middleware: Middleware): this {
    this.stack.push(middleware);
    return this;
  }

  /** Execute the pipeline with a context */
  async execute(ctx: Context): Promise<void> {
    await this.compose(this.stack)(ctx);
  }

  /** Compose middleware stack into a single function */
  private compose(middlewares: Middleware[]): (ctx: Context) => Promise<void> {
    return (ctx: Context) => {
      let index = -1;

      const dispatch = async (i: number): Promise<void> => {
        if (i <= index) {
          throw new Error('next() called multiple times');
        }
        index = i;

        const fn = middlewares[i];
        if (!fn) return;

        await fn(ctx, () => dispatch(i + 1));
      };

      return dispatch(0);
    };
  }

  /** Get the number of registered middleware */
  get size(): number {
    return this.stack.length;
  }
}
