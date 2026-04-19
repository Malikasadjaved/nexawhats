/**
 * Basic bot example — minimal NexaWhats client with middleware + logging.
 *
 * This example shows the smallest useful setup:
 *   1. Persistent auth via FileAuthStore (Baileys-compatible layout).
 *   2. Middleware pipeline logging every inbound message.
 *   3. An echo handler that replies to any direct (non-group) text.
 *
 * Run (manual, against live WhatsApp):
 *   npx tsx examples/basic-bot/index.ts
 *
 * On first run you will see a QR code in the terminal — scan it from
 * WhatsApp → Linked Devices. The session is persisted under
 * `./auth/` and subsequent runs skip the QR step.
 *
 * NOTE: v0.1.0 ships transport + middleware + queue end-to-end, but
 * message encrypt/decrypt is deferred to 0.2.0. Until then `client.send`
 * throws NotImplementedError. This example remains useful as an
 * integration-smoke harness for the stores, queue, and middleware.
 */

import {
  antiBan,
  createClient,
  FileAuthStore,
  lidResolver,
  messageLogger,
} from 'nexawhats';

async function main(): Promise<void> {
  const store = new FileAuthStore('./auth');
  const state = await store.loadState();

  const client = createClient({
    auth: state ?? { creds: {}, keys: store },
    queue: { messagesPerMinute: 20, humanLikeTiming: true },
    metrics: { prometheus: true, port: 9100 },
  });

  // LID → phone translation so your middleware only sees canonical JIDs.
  client.use(lidResolver());
  // Gaussian delay between sends — reduces ban risk.
  client.use(antiBan({ minDelay: 1000, maxDelay: 3000 }));
  // Structured console log of every inbound ctx.
  client.use(messageLogger());

  // Custom middleware: reply to direct text messages.
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
