/**
 * Echo bot — minimal NexaWhats bot with middleware, commands, and
 * persistent session storage.
 *
 * Features:
 *   - QR-based pairing on first run (scan from WhatsApp → Linked Devices)
 *   - Session persistence via FileAuthStore — subsequent runs skip pairing
 *   - Middleware pipeline: LID resolution → anti-ban delays → logging → commands
 *   - Echo: replies to any direct (non-group) text message
 *   - /ping and /help commands
 *   - Prometheus metrics + /health endpoint on port 9100
 *
 * Usage:
 *   npx tsx examples/basic-bot/index.ts
 *
 * On first run, scan the QR code printed to the console.
 * Subsequent runs reuse the saved session under `./auth/`.
 */

import pino from 'pino';
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

  const logger = pino({ level: 'trace' });

  const client = createClient({
    auth: state ?? { creds: {}, keys: store },
    phoneNumber: '923367400783',
    queue: { messagesPerMinute: 20, humanLikeTiming: true },
    metrics: { prometheus: true, port: 9101 },
    logger,
  });

  // ── Middleware pipeline ────────────────────────────────────────────

  // Resolve LID → PN so handlers only see canonical phone-number JIDs.
  client.use(lidResolver());

  // Add Gaussian timing jitter to sends (reduces ban risk).
  client.use(antiBan({ minDelay: 1000, maxDelay: 3000 }));

  // Structured console log of every inbound message.
  client.use(messageLogger());

  // ── Command handler ────────────────────────────────────────────────
  client.use(async (ctx, next) => {
    if (ctx.isGroup || ctx.message.key.fromMe || !ctx.text) {
      return next();
    }

    const text = ctx.text.trim();

    if (text === '/ping') {
      await ctx.reply({ text: 'pong' });
      return;
    }

    if (text === '/help') {
      await ctx.reply({
        text:
          'NexaWhats echo bot\n' +
          '/ping  — connectivity check\n' +
          '/help  — this message\n' +
          '/info  — bot runtime info\n' +
          'anything else → echoed back',
      });
      return;
    }

    if (text === '/info') {
      const uptime = Math.floor((Date.now() - startedAt) / 1000);
      const mem = process.memoryUsage();
      await ctx.reply({
        text: [
          `uptime: ${uptime}s`,
          `heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
          `rss: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
          `health: http://localhost:9101/health`,
        ].join('\n'),
      });
      return;
    }

    // Default: echo back
    await ctx.reply({ text: `echo: ${text}` });

    await next();
  });

  // ── Events ─────────────────────────────────────────────────────────

  client.on('connection.update', ({ connection, qr }) => {
    if (qr) {
      console.log(
        '\n' +
        '══════════════════════════════════════════════\n' +
        '  Scan this QR code in WhatsApp:\n' +
        '  Linked Devices → Link a Device\n' +
        '══════════════════════════════════════════════\n' +
        `${qr.slice(0, 80)}...\n` +
        '══════════════════════════════════════════════\n',
      );
    }
    console.log(`[connection] → ${connection}`);
  });

  client.on('creds.update', async () => {
    await store.saveState({
      creds: client.config.auth.creds,
      keys: store,
    });
  });

  client.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      const content = msg.message as Record<string, unknown> | undefined;
      const keys = content ? Object.keys(content).filter(k => k !== 'senderKeyDistributionMessage') : [];
      const hasConversation = !!content?.conversation;
      const hasExtendedText = !!(content?.extendedTextMessage as Record<string, unknown>)?.text;
      const hasProtocol = !!content?.protocolMessage;
      const hasReaction = !!content?.reactionMessage;
      const msgType = content
        ? keys.join(',')
        : 'NO-CONTENT';
      console.log(
        `[MSG-IN] fromMe=${msg.key.fromMe} remoteJid=${msg.key.remoteJid} ` +
        `id=${msg.key.id} type=${msgType} ` +
        `conv=${hasConversation} extText=${hasExtendedText} proto=${hasProtocol} react=${hasReaction} ` +
        `realMsgCheck=${keys.length > 0 && !hasProtocol && !hasReaction ? 'would-pass' : 'BLOCKED'}`,
      );
      if (content?.conversation) {
        console.log(`  → text: "${content.conversation}"`);
      } else if ((content?.extendedTextMessage as Record<string, unknown>)?.text) {
        console.log(`  → extText: "${(content.extendedTextMessage as Record<string, unknown>).text}"`);
      }
    }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  const startedAt = Date.now();

  process.on('SIGINT', async () => {
    console.log('\nshutting down...');
    await client.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await client.disconnect();
    process.exit(0);
  });

  console.log('NexaWhats echo bot starting...');
  await client.connect();

  console.log('bot online');
  console.log('health endpoint: http://localhost:9101/health');
  console.log('metrics endpoint: http://localhost:9101/metrics');
}

main().catch((err) => {
  console.error('bot failed to start:', err);
  process.exit(1);
});
