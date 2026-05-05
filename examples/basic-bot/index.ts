/**
 * Basic bot example — minimal NexaWhats client with middleware + echo.
 *
 *   1. Persistent auth via FileAuthStore (Baileys-compatible layout).
 *   2. Middleware pipeline logging every inbound message.
 *   3. An echo handler that replies to any direct (non-group) text.
 *
 * Run (manual, against live WhatsApp):
 *   npx tsx examples/basic-bot/index.ts
 *
 * On first run scan the QR code from WhatsApp → Linked Devices.
 * The session persists under `./auth/` — subsequent runs skip the QR step.
 */

import {
  FileAuthStore,
  antiBan,
  createClient,
  lidResolver,
  messageLogger,
} from '../../src/index.js';

async function main(): Promise<void> {
  const store = new FileAuthStore('./auth');
  const state = await store.loadState();

  const client = createClient({
    auth: state ?? { creds: {}, keys: store },
    queue: { messagesPerMinute: 20, humanLikeTiming: true },
    metrics: { prometheus: true, port: 9100 },
  });

  // LID → phone translation so middleware only sees canonical JIDs.
  client.use(lidResolver());
  // Gaussian delay between sends — reduces ban risk.
  client.use(antiBan({ minDelay: 1000, maxDelay: 3000 }));
  // Structured console log of every inbound message.
  client.use(messageLogger());

  // Echo handler — reply to any direct (non-group) text not from self.
  client.use(async (ctx, next) => {
    if (!ctx.isGroup && ctx.text && !ctx.message.key.fromMe) {
      await ctx.reply({ text: `echo: ${ctx.text}` });
    }
    await next();
  });

  client.on('connection.update', ({ connection }) => {
    console.log(`[connection] → ${connection}`);
  });

  client.on('creds.update', async () => {
    // Re-persist auth on every credential change.
    await store.saveState({
      creds: client.config.auth.creds,
      keys: store,
    });
  });

  process.on('SIGINT', async () => {
    console.log('\nshutting down...');
    await client.disconnect();
    process.exit(0);
  });

  await client.connect();
  console.log('bot up — health on http://localhost:9100/health');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
