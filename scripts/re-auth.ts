/**
 * Re-auth script — pairs a WhatsApp number fresh and saves credentials.
 *
 * Usage:
 *   npx tsx scripts/re-auth.ts <phone> [--qr]
 *
 *   npx tsx scripts/re-auth.ts 923124166950        # pairing code (default)
 *   npx tsx scripts/re-auth.ts 923124166950 --qr   # QR code
 *
 * Output: tests/fixtures/auth-capture/creds.json
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import { createClient, FileAuthStore } from '../src/index.js';

const PHONE = process.argv[2];
const USE_QR = process.argv.includes('--qr');

if (!PHONE) {
  console.error('Usage: npx tsx scripts/re-auth.ts <phone> [--qr]');
  console.error('Example: npx tsx scripts/re-auth.ts 923124166950');
  process.exit(1);
}

const digits = PHONE.replace(/\D/g, '');
if (digits.length < 10) {
  console.error('Invalid phone — use digits with country code, e.g. 923124166950');
  process.exit(1);
}

const OUT_DIR = resolve(import.meta.dirname ?? '.', '..', 'tests', 'fixtures', 'auth-capture');
const OUT_FILE = resolve(OUT_DIR, 'creds.json');

function log(msg: string): void {
  console.log(`[re-auth ${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  const store = new FileAuthStore('./auth-smoke');
  const existingState = await store.loadState();

  // Simple console logger so we can see connection errors
  const logger: Logger = {
    info: (obj: unknown, msg?: string) => {
      const detail = msg && typeof obj === 'object' && obj !== null ? ' ' + JSON.stringify(obj) : '';
      console.log('[INFO]', msg ?? obj, detail);
    },
    warn: (obj: unknown, msg?: string) => {
      const detail = msg && typeof obj === 'object' && obj !== null ? ' ' + JSON.stringify(obj) : '';
      console.warn('[WARN]', msg ?? obj, detail);
    },
    error: (obj: unknown, msg?: string) => {
      const o = obj as Record<string, unknown>;
      const detail = o.reason ?? o.err ?? o.text ?? '';
      console.error('[ERROR]', msg ?? '', String(detail));
    },
    debug: () => {},
    trace: () => {},
    fatal: (obj: unknown, msg?: string) => {
      console.error('[FATAL]', msg ?? obj);
      process.exit(1);
    },
    child: () => logger,
    level: 'info',
    silent: false,
  } as unknown as Logger;

  let pairingCodePrinted = false;
  let pairingDone = false;
  let fatalSeen = false;

  // Build a proper SignalKeyStore wrapper even for the fallback path.
  // FileAuthStore has getKeys/setKeys/clear; SignalKeyStore expects get/set/clear.
  const signalKeys = {
    get: async (type: string, ids: string[]) => store.getKeys(type, ids),
    set: async (data: Record<string, unknown>) => store.setKeys(data),
    clear: async () => store.clear(),
  };

  const config: Record<string, unknown> = {
    auth: existingState ?? { creds: {}, keys: signalKeys },
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    logger,
  };

  if (!USE_QR) {
    config.phoneNumber = digits;
  }

  const client = createClient(config as Parameters<typeof createClient>[0]);

  // ── Event handlers ──────────────────────────────────────────────────

  client.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    log(`connection → ${connection}`);

    const err = lastDisconnect?.error;
    if (err) {
      log(`last disconnect: ${err}`);
    }

    if (qr && !pairingCodePrinted) {
      if (USE_QR) {
        pairingCodePrinted = true;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
        log('──────────────────────────────────────────────');
        log('QR CODE — open this URL in a browser and scan with WhatsApp:');
        log(`  ${qrUrl}`);
        log('──────────────────────────────────────────────');
        log('');
        log('WhatsApp → Linked Devices → Link a Device → Scan QR');
        log('');
        log('Waiting for you to scan...');
      } else {
        // Pairing code mode — show the 8-char code
        pairingCodePrinted = true;
        const pc = (client.config.auth.creds as Record<string, unknown>)
          ?.pairingCode as string;
        log('════════════════════════════════════════════');
        log(`  Phone : +${digits}`);
        log(`  Code  : ${pc ?? 'generating...'}`);
        log('════════════════════════════════════════════');
        log('');
        log('WhatsApp → Linked Devices → Link a Device');
        log('→ Link with phone number → enter code above');
        log('');
        log('Waiting for you to enter the code...');
      }
    }

    if (connection === 'connected') {
      log('PAIRED SUCCESSFULLY');
      pairingDone = true;
    }

    if (connection === 'disconnected' && !pairingDone && !fatalSeen) {
      // Server drops connection after pairing code is issued — reconnect.
      // Small delay to let the transport fully close before reconnecting.
      log('Reconnecting in 3s...');
      setTimeout(() => {
        if (!pairingDone && !fatalSeen) {
          client.connect().catch(() => {
            log('Reconnect failed, retrying...');
          });
        }
      }, 3000);
    }
  });

  client.on('creds.update', async (creds) => {
    // Persist on every change so we never lose progress
    const state = { creds, keys: store };
    await store.saveState(state);

    // Write canonical creds file
    const credsObj = creds as Record<string, unknown>;
    const me = credsObj.me as { id?: string } | undefined;

    const serialized = JSON.parse(
      JSON.stringify(creds, (_, v) => {
        if (v && v.type === 'Buffer' && Array.isArray(v.data)) return v;
        if (Buffer.isBuffer(v)) return { type: 'Buffer', data: Array.from(v) };
        return v;
      }),
    );

    writeFileSync(OUT_FILE, JSON.stringify({ creds: serialized, me: creds.me }, null, 2));

    if (me?.id) {
      log(`creds saved → ${me.id}`);
    }

    // If we have the full identity (pair-success processed), exit cleanly
    if (me?.id && (credsObj.registered as boolean)) {
      log('Registration complete — credentials saved.');
      log(`File: ${OUT_FILE}`);
      // Don't exit here — the server will close the connection and the
      // client will reconnect with a login node. Wait for the 'connected'
      // event instead.
    }
  });

  // ── Connect ──────────────────────────────────────────────────────────

  log('Connecting...');

  try {
    await client.connect();
  } catch (err) {
    log(`Connection error: ${(err as Error).message}`);
    // If the error is fatal (401/403/405), the client sets stopReconnect.
    // If not fatal, the connection.update handler will reconnect.
    fatalSeen = true;
  }

  // Keep-alive — if no pair within 90 seconds, exit
  setTimeout(() => {
    if (!pairingDone) {
      log('Pairing timed out after 90 seconds');
      client.disconnect().catch(() => {});
      process.exit(1);
    }
  }, 90_000);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
