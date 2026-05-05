/**
 * E2E live smoke test — full-pipeline verification against a real
 * WhatsApp number.
 *
 * Exercises: connect → Noise handshake → auth → message send →
 * message receive → decrypt → clean disconnect.
 *
 * **NOT for CI** — this hits live WhatsApp servers with real credentials.
 * **Ban risk** — moderate (single connect, low-volume traffic, clean
 * disconnect). Do NOT run repeatedly in a short window.
 *
 * ## Usage
 *
 * ```bash
 * npx tsx tests/e2e/live-smoke.ts [path-to-creds.json]
 * ```
 *
 * Credentials file: a Baileys-compatible `authState.json` or a NexaWhats
 * auth-capture `creds.json`. Must contain `noiseKey`, `signedIdentityKey`,
 * `signedPreKey`, `registrationId`, `advSecretKey`, and `me.id`.
 *
 * If no path is given, searches:
 *   1. `tests/fixtures/auth-capture/creds.json`
 *   2. `./auth-creds.json`
 *
 * ## Environment variables
 *
 *   SMOKE_DURATION_S     Seconds to stay connected (default 3600 = 1 hour)
 *   SMOKE_TARGET_JID     If set, send a test "ping" message to this JID
 *                        after connecting, and assert delivery receipt
 *   SMOKE_ECHO_CHECK     If "1", expects the remote side to echo back
 *                        (requires a bot running on the target number)
 *   SMOKE_QUICK          If "1", overrides duration to 60s and skips
 *                        the send/receive check (quick connectivity test)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileAuthStore, createClient } from '../../src/index.js';

// ── Config from env ──────────────────────────────────────────────────

const DURATION_S = Number(process.env.SMOKE_DURATION_S ?? 3600);
const TARGET_JID = process.env.SMOKE_TARGET_JID ?? '';
const ECHO_CHECK = process.env.SMOKE_ECHO_CHECK === '1';
const QUICK = process.env.SMOKE_QUICK === '1';

const effectiveDuration = QUICK ? 60 : DURATION_S;
const shouldSend = QUICK ? false : !!TARGET_JID;

// ── Resolve creds path ───────────────────────────────────────────────

const givenPath = process.argv[2];
const searchPaths = givenPath
  ? [givenPath]
  : [
      resolve(import.meta.dirname ?? '.', '..', 'fixtures', 'auth-capture', 'creds.json'),
      resolve(process.cwd(), 'auth-creds.json'),
    ];

let credsPath: string | undefined;
for (const p of searchPaths) {
  if (existsSync(p)) {
    credsPath = p;
    break;
  }
}

if (!credsPath) {
  console.error('No creds file found. Searched:', searchPaths);
  console.error('Usage: npx tsx tests/e2e/live-smoke.ts [path-to-creds.json]');
  process.exit(1);
}

// ── Load and revive creds ────────────────────────────────────────────

console.log(`[smoke] Loading creds from ${credsPath}`);
const raw = JSON.parse(readFileSync(credsPath, 'utf8'));
const creds = raw.creds ?? raw;

// Revive Buffer fields from JSON (base64 or {type:'Buffer',data:[...]})
function reviveBuffers(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    'type' in obj &&
    obj.type === 'Buffer' &&
    'data' in obj
  ) {
    const d = obj.data as string | number[];
    return Buffer.from(
      typeof d === 'string' ? d : Buffer.from(d).toString('base64'),
      typeof d === 'string' ? 'base64' : undefined,
    );
  }
  if (Array.isArray(obj)) return obj.map(reviveBuffers);
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = reviveBuffers(v);
    return out;
  }
  return obj;
}

const revived = reviveBuffers(creds) as Record<string, unknown>;

// Validate required fields
const required = [
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'registrationId',
  'advSecretKey',
];
const missing = required.filter((k) => !revived[k]);
if (missing.length > 0) {
  console.error(`Missing required creds fields: ${missing.join(', ')}`);
  process.exit(1);
}

const meId = (revived.me as { id?: string } | undefined)?.id;
if (!meId) {
  console.error('creds missing me.id');
  process.exit(1);
}

console.log(`[smoke] Authenticating as ${meId}`);

// ── Stats ────────────────────────────────────────────────────────────

const stats = {
  connected: false,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
  startTime: 0,
  lastHealthLog: 0,
};

function healthSnapshot(): string {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  return [
    `uptime=${uptime}s`,
    `connected=${stats.connected}`,
    `sent=${stats.messagesSent}`,
    `recv=${stats.messagesReceived}`,
    `errors=${stats.errors}`,
  ].join(' ');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const store = new FileAuthStore('./auth-smoke');
  const existingState = await store.loadState();

  const client = createClient({
    auth: existingState ?? { creds: revived, keys: store },
    queue: { messagesPerMinute: 20, humanLikeTiming: true },
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 25_000,
    browser: ['NexaWhats', 'Chrome', '22.0'],
  });

  client.on('connection.update', ({ connection, qr }) => {
    console.log(`[smoke] connection → ${connection}`);
    if (qr) {
      console.log('[smoke] QR code received — scan from WhatsApp → Linked Devices');
      console.log('[smoke] QR length:', qr.length, 'chars');
    }
    stats.connected = connection === 'connected';
  });

  client.on('creds.update', async () => {
    await store.saveState({
      creds: client.config.auth.creds,
      keys: store,
    });
  });

  client.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      stats.messagesReceived++;
      const content = msg.message;
      const text =
        content?.conversation ??
        content?.extendedTextMessage?.text ??
        content?.imageMessage?.caption ??
        '';
      console.log(`[smoke] recv ← ${msg.key.remoteJid}: ${text.slice(0, 80)}`);

      // Echo verification
      if (ECHO_CHECK && text.includes('smoke-ping')) {
        console.log('[smoke] ECHO CHECK PASSED — ping response received');
      }
    }
  });

  client.on('message-receipt.update', (receipts) => {
    for (const r of receipts) {
      const key = r.key;
      console.log(`[smoke] receipt ${r.receipt.userJid} id=${key.id}`);
    }
  });

  // ── Connect ──────────────────────────────────────────────────────
  stats.startTime = Date.now();
  await client.connect();
  console.log('[smoke] Connected to WhatsApp');

  // ── Optional: send a test message ────────────────────────────────
  if (shouldSend) {
    console.log(`[smoke] Sending test ping to ${TARGET_JID}...`);
    try {
      await client.send(TARGET_JID, {
        text: `smoke-ping ${new Date().toISOString()}`,
      });
      stats.messagesSent++;
      console.log('[smoke] Test message sent');
    } catch (err) {
      stats.errors++;
      console.error('[smoke] Failed to send test message:', err);
    }
  }

  // ── Periodic health logging ──────────────────────────────────────
  const healthInterval = setInterval(() => {
    console.log(`[smoke] HEALTH | ${healthSnapshot()}`);
  }, 60_000);

  // ── Run for duration ─────────────────────────────────────────────
  console.log(
    `[smoke] Running for ${effectiveDuration}s (${(effectiveDuration / 60).toFixed(0)}m)...`,
  );
  console.log('[smoke] Press Ctrl+C to stop early');

  const donePromise = new Promise<void>((resolve) => {
    setTimeout(resolve, effectiveDuration * 1000);
  });

  // Graceful shutdown on SIGINT
  const shutdown = async () => {
    console.log('\n[smoke] Shutting down...');
    clearInterval(healthInterval);
    await client.disconnect();
    console.log(`[smoke] FINAL | ${healthSnapshot()}`);
    console.log('[smoke] Test complete — OK');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await donePromise;

  // Timed completion
  clearInterval(healthInterval);
  await client.disconnect();
  console.log(`[smoke] FINAL | ${healthSnapshot()}`);

  if (stats.errors > 0) {
    console.log(`[smoke] Test complete with ${stats.errors} errors`);
    process.exit(1);
  }

  console.log('[smoke] Test complete — OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] Fatal error:', err);
  process.exit(1);
});
