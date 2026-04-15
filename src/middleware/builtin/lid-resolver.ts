import { isLidUser } from '../../utils/jid.js';
import type { Middleware } from '../types.js';

/**
 * Middleware that automatically resolves LID JIDs to phone-number JIDs.
 *
 * WhatsApp's LID migration (2023-2025) introduced local identifiers that
 * replace phone numbers in some contexts. This middleware transparently
 * resolves them so downstream handlers always see phone-number JIDs.
 */
export function lidResolver(): Middleware {
  return async (ctx, next) => {
    if (isLidUser(ctx.jid)) {
      try {
        ctx.jid = await ctx.resolveLID(ctx.jid);
      } catch {
        // If resolution fails, keep the LID — don't break the pipeline
      }
    }
    await next();
  };
}
