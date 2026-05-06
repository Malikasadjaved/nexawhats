import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuthenticationCreds } from '../../src/types/auth.js';

const { FileAuthStore, createClient } = await import('../../src/index.js');

// ── Config from env ──────────────────────────────────────────────────

const DURATION_S = Number(process.env.SMOKE_DURATION_S ?? 3600);
const TARGET_JID = process.env.SMOKE_TARGET_JID ?? '';
const ECHO_CHECK = process.env.SMOKE_ECHO_CHECK === '1';
const QUICK = process.env.SMOKE_QUICK === '1';

const effectiveDuration = QUICK ? 60 : DURATION_S;
const shouldSend = !!TARGET_JID && !QUICK;

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

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg: string): void {
  console.log(`[smoke ${timestamp()}] ${msg}`);
}

function fatal(msg: string): never {
  console.error(`[smoke ${timestamp()}] FATAL: ${msg}`);
  process.exit(1);
}

log(`Loading creds from ${credsPath}`);
const raw = JSON.parse(readFileSync(credsPath, 'utf8'));
const creds = raw.creds ?? raw;

// Revive Buffer fields from JSON (base64 or {type:'Buffer',data:[...]})
function reviveBuffers(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Uint8Array) return obj;
  if (
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    'type' in obj &&
    (obj as Record<string, unknown>).type === 'Buffer' &&
    'data' in obj
  ) {
    const d = (obj as { data: string | number[] }).data;
    return Buffer.from(
      typeof d === 'string' ? d : Buffer.from(d).toString('base64'),
      typeof d === 'string' ? 'base64' : undefined,
    );
  }
  if (Array.isArray(obj)) return obj.map(reviveBuffers);
  if (typeof obj === 'object' && obj !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = reviveBuffers(v);
    }
    return out;
  }
  return obj;
}

const revived = reviveBuffers(creds) as Record<string, unknown>;

// Validate required fields
const REQUIRED_CREDS = [
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'registrationId',
  'advSecretKey',
];
for (const k of REQUIRED_CREDS) {
  if (!revived[k]) fatal(`Missing required creds field: ${k}`);
}

const meId = (revived.me as { id?: string } | undefined)?.id;
if (!meId) fatal('creds missing me.id');

log(`Authenticating as ${meId}`);

// ── Stats ────────────────────────────────────────────────────────────

const stats = {
  connected: false,
  connectAttempts: 0,
  messagesSent: 0,
  messagesReceived: 0,
  textMessagesReceived: 0,
  receipts: 0,
  connectionLosses: 0,
  errors: 0,
  startTime: 0,
  connectedAt: 0,
};

function healthSnapshot(): string {
  const uptime = stats.startTime ? Math.floor((Date.now() - stats.startTime) / 1000) : 0;
  return [
    `uptime=${uptime}s`,
    `connected=${stats.connected}`,
    `sent=${stats.messagesSent}`,
    `recv=${stats.messagesReceived}`,
    `texts=${stats.textMessagesReceived}`,
    `receipts=${stats.receipts}`,
    `losses=${stats.connectionLosses}`,
    `errors=${stats.errors}`,
  ].join(' ');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Use a dedicated auth dir so smoke tests don't clobber a real session
  const store = new FileAuthStore('./auth-smoke');
  const existingState = await store.loadState();

  const client = createClient({
    auth: existingState ?? { creds: revived as AuthenticationCreds, keys: store },
    queue: { messagesPerMinute: 20, humanLikeTiming: true },
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 25_000,
    browser: ['NexaWhats', 'Chrome', '22.0'],
  });

  // ── Events ───────────────────────────────────────────────────────

  client.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    log(`connection → ${connection}`);
    if (qr) {
      log('QR code received — scan from WhatsApp → Linked Devices');
      log(`QR length: ${qr.length} chars`);
    }
    if (connection === 'connected') {
      stats.connected = true;
      stats.connectAttempts++;
      stats.connectedAt = Date.now();
    }
    if (connection === 'disconnected' || connection === 'connecting') {
      if (stats.connected) {
        stats.connectionLosses++;
        stats.connected = false;
      }
    }
    if (lastDisconnect?.error) {
      log(`last disconnect error: ${lastDisconnect.error}`);
    }
  });

  client.on('creds.update', async () => {
    // Persist creds on every change so a reconnect can reuse them
    await store.saveState({
      creds: client.config.auth.creds,
      keys: store,
    });
    log('creds saved');
  });

  client.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      stats.messagesReceived++;
      const content = msg.message as Record<string, unknown> | undefined;
      const text =
        (content?.conversation as string) ??
        (content?.extendedTextMessage as { text?: string })?.text ??
        (content?.imageMessage as { caption?: string })?.caption ??
        '';
      if (text) {
        stats.textMessagesReceived++;
        log(`recv ← ${msg.key.remoteJid}: ${text.slice(0, 120)}`);
      }

      // Echo verification
      if (ECHO_CHECK && text.includes('smoke-ping')) {
        log('ECHO CHECK PASSED — ping response received');
      }
    }
  });

  client.on('message-receipt.update', (receipts) => {
    stats.receipts += receipts.length;
    for (const r of receipts.slice(0, 2)) {
      log(`receipt user=${r.receipt.userJid} id=${r.key.id}`);
    }
  });

  client.on('messages.update', (updates) => {
    for (const u of updates as Array<Record<string, unknown>>) {
      log(`msg update key=${JSON.stringify(u.key)}`);
    }
  });

  // ── Connect ──────────────────────────────────────────────────────

  stats.startTime = Date.now();
  log('Starting connect...');

  try {
    await client.connect();
  } catch (err) {
    stats.errors++;
    fatal(`Connection failed: ${(err as Error).message}`);
  }

  log('Connected to WhatsApp');
  stats.connected = true;

  // ── Send test ping ───────────────────────────────────────────────

  if (shouldSend) {
    const pingId = `smoke-ping-${Date.now()}`;
    log(`Sending test ping "${pingId}" to ${TARGET_JID}...`);
    try {
      await client.send(TARGET_JID, {
        text: pingId,
      });
      stats.messagesSent++;
      log('Test ping sent');
    } catch (err) {
      stats.errors++;
      log(`Failed to send test ping: ${(err as Error).message}`);
    }
  }

  // ── Periodics ────────────────────────────────────────────────────

  const healthInterval = setInterval(() => {
    log(`HEALTH | ${healthSnapshot()}`);
  }, 60_000);

  const donePromise = new Promise<void>((resolve) => {
    setTimeout(resolve, effectiveDuration * 1000);
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down...`);
    clearInterval(healthInterval);
    try {
      await client.disconnect();
    } catch {
      // best effort
    }
    log(`FINAL | ${healthSnapshot()}`);

    // Persist final state for next run
    try {
      await store.saveState({
        creds: client.config.auth.creds,
        keys: store,
      });
    } catch {
      // best effort
    }

    const exitCode = stats.errors > 0 ? 1 : 0;
    const verdict = exitCode === 0 ? 'OK' : `FAILED (${stats.errors} errors)`;
    log(`Test complete — ${verdict}`);

    // Write a summary file for CI
    try {
      writeFileSync(
        resolve(process.cwd(), 'smoke-result.json'),
        JSON.stringify(
          {
            verdict,
            duration: effectiveDuration,
            meId,
            targetJid: TARGET_JID || null,
            ...stats,
            finishedAt: timestamp(),
          },
          null,
          2,
        ),
      );
    } catch {
      // non-critical
    }

    process.exit(exitCode);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log(
    `Running for ${effectiveDuration}s (${(effectiveDuration / 60).toFixed(0)}m), Ctrl+C to stop`,
  );

  await donePromise;

  // Timed completion
  clearInterval(healthInterval);
  await shutdown('timer');
}

main().catch((err) => {
  console.error(`[smoke ${timestamp()}] FATAL:`, err);
  process.exit(1);
});
