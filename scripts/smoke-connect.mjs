#!/usr/bin/env node
/**
 * D5 live smoke — opens a real WhatsApp WebSocket, runs the Noise
 * handshake, and logs inbound frames for 60 seconds.
 *
 * NOT for CI — this hits live WhatsApp servers with real credentials.
 * Ban risk: moderate (single connect → idle → clean disconnect).
 *
 * Usage:
 *   node scripts/smoke-connect.mjs [path-to-creds.json]
 *
 * Credentials format: a Baileys `authState.json` file or a
 * NexaWhats auth-capture `creds.json`. The file must contain at
 * least `noiseKey`, `signedIdentityKey`, `signedPreKey`,
 * `registrationId`, and `advSecretKey`.
 *
 * If no path is given, looks for:
 *   1. tests/fixtures/auth-capture/creds.json
 *   2. ./auth-creds.json
 *
 * Env vars:
 *   SMOKE_DURATION_S  — seconds to stay connected (default 30)
 *   NODE_PATH         — path to Baileys node_modules for WAProto
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { proto, isProtoAvailable } from '../dist/proto/index.js';
import { makeNoiseHandler } from '../dist/socket/noise.js';
import { WsTransport } from '../dist/socket/transport.js';
import { performHandshake } from '../dist/socket/handshake.js';
import { generateLoginNode, DEFAULT_BROWSER, DEFAULT_VERSION } from '../dist/proto/payload.js';
import { Curve } from '../dist/utils/crypto.js';
import { createKeepAlive } from '../dist/socket/keepalive.js';
import { encodeBinaryNode } from '../dist/binary/encoder.js';
import { S_WHATSAPP_NET } from '../dist/binary/jid.js';
import { generateMessageId } from '../dist/utils/crypto.js';

const DURATION_S = Number(process.env.SMOKE_DURATION_S ?? 30);

// ── Minimal pino logger ─────────────────────────────────────────────
const logger = {
  child: () => logger,
  trace: (...args) => console.log('[trace]', ...args),
  debug: (...args) => console.log('[debug]', ...args),
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
  fatal: (...args) => console.error('[fatal]', ...args),
  level: 'trace',
};

// ── Resolve creds ───────────────────────────────────────────────────
const givenPath = process.argv[2];
const searchPaths = givenPath
  ? [givenPath]
  : [
      resolve(import.meta.dirname ?? '.', '..', 'tests', 'fixtures', 'auth-capture', 'creds.json'),
      resolve(process.cwd(), 'auth-creds.json'),
    ];

let credsPath;
for (const p of searchPaths) {
  if (existsSync(p)) {
    credsPath = p;
    break;
  }
}

if (!credsPath) {
  console.error('No creds file found. Searched:', searchPaths);
  console.error('Usage: node scripts/smoke-connect.mjs [path-to-creds.json]');
  process.exit(1);
}

console.log(`[smoke] Loading creds from ${credsPath}`);
const raw = JSON.parse(readFileSync(credsPath, 'utf8'));

// Support both { creds: {...} } (authState) and flat creds shapes.
const creds = raw.creds ?? raw;

// Revive Buffer fields from JSON (base64 or {type:'Buffer',data:[...]}).
function reviveBuffers(obj) {
  if (obj === null || obj === undefined) return obj;
  if (obj.type === 'Buffer' && obj.data) {
    return Buffer.from(
      typeof obj.data === 'string' ? obj.data : obj.data,
      typeof obj.data === 'string' ? 'base64' : undefined,
    );
  }
  if (Array.isArray(obj)) return obj.map(reviveBuffers);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = reviveBuffers(v);
    return out;
  }
  return obj;
}

const revived = reviveBuffers(creds);

// Validate required fields.
const required = ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'registrationId', 'advSecretKey'];
const missing = required.filter((k) => !revived[k]);
if (missing.length > 0) {
  console.error(`Missing required creds fields: ${missing.join(', ')}`);
  process.exit(1);
}

// ── Check proto ─────────────────────────────────────────────────────
if (!isProtoAvailable()) {
  console.error(
    'WAProto not available. Set NODE_PATH to a Baileys installation, e.g.:\n' +
      '  NODE_PATH="D:/Digital Fte/body/my-bot/node_modules" node scripts/smoke-connect.mjs',
  );
  process.exit(1);
}

console.log('[smoke] WAProto loaded.');

// ── Build client payload ────────────────────────────────────────────
const payloadConfig = {
  version: DEFAULT_VERSION,
  browser: DEFAULT_BROWSER,
  countryCode: 'US',
};

const userJid = revived.me?.id ?? revived.me?.jid;
if (!userJid) {
  console.error('creds missing me.id — cannot build login payload');
  process.exit(1);
}

const clientPayload = generateLoginNode(userJid, payloadConfig);
console.log('[smoke] ClientPayload built for', userJid);

// ── Connect ─────────────────────────────────────────────────────────
async function main() {
  const waUrl = 'wss://web.whatsapp.com/ws/chat';
  const transport = new WsTransport();

  // Ephemeral keypair
  const ephemeralKeyPair = Curve.generateKeyPair();

  // Noise handler
  const noise = makeNoiseHandler({ keyPair: ephemeralKeyPair, logger });

  try {
    // Open WebSocket
    console.log('[smoke] Connecting to', waUrl);
    await transport.connect(waUrl, { connectTimeoutMs: 20_000 });
    console.log('[smoke] WebSocket open');

    // Handshake IO
    const handshakeIO = {
      sendFrame: (frame) => transport.send(frame),
      waitForHandshakeReply: (timeoutMs) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            transport.off('frame', onRawFrame);
            reject(new Error(`ServerHello timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          const onRawFrame = (buf) => {
            clearTimeout(timer);
            transport.off('frame', onRawFrame);
            resolve(buf);
          };
          transport.once('frame', onRawFrame);
          transport.once('error', (err) => {
            clearTimeout(timer);
            transport.off('frame', onRawFrame);
            reject(err);
          });
        }),
    };

    // Handshake
    console.log('[smoke] Starting Noise handshake...');
    await performHandshake({
      noise,
      creds: { noiseKey: revived.noiseKey },
      ephemeralPublic: ephemeralKeyPair.public,
      clientPayload,
      io: handshakeIO,
      logger,
      timeoutMs: 20_000,
    });
    console.log('[smoke] Handshake complete');

    // Frame pump
    let framesReceived = 0;
    transport.on('frame', (buf) => {
      noise.decodeFrame(buf, (node) => {
        framesReceived++;
        if (Buffer.isBuffer(node)) {
          console.log(`[frame #${framesReceived}] raw buffer, ${node.length} bytes`);
          return;
        }
        console.log(
          `[frame #${framesReceived}] <${node.tag}>`,
          node.attrs ? JSON.stringify(node.attrs) : '',
        );
      }).catch((err) => {
        console.error('[decode error]', err);
      });
    });

    // Keepalive
    const keepAlive = createKeepAlive({
      logger,
      keepAliveIntervalMs: 25_000,
      sendPing: async () => {
        const pingNode = {
          tag: 'iq',
          attrs: {
            id: generateMessageId(),
            to: S_WHATSAPP_NET,
            type: 'get',
            xmlns: 'w:p',
          },
          content: [{ tag: 'ping', attrs: {} }],
        };
        const encoded = encodeBinaryNode(pingNode);
        transport.send(noise.encodeFrame(encoded));
      },
      onConnectionLost: (reason) => {
        console.error('[smoke] Connection lost:', reason);
        transport.close(1001, reason);
      },
    });

    keepAlive.receivedFrame();
    transport.on('frame', () => keepAlive.receivedFrame());
    keepAlive.start();
    console.log('[smoke] Keepalive started');

    // Wait for the specified duration
    console.log(`[smoke] Listening for ${DURATION_S}s...`);
    await new Promise((resolve) => setTimeout(resolve, DURATION_S * 1000));
    console.log(`[smoke] Done. Received ${framesReceived} frames in ${DURATION_S}s`);

    // Clean shutdown
    keepAlive.stop();
    transport.close(1000, 'smoke complete');
    console.log('[smoke] Disconnected cleanly. OK.');
    process.exit(0);
  } catch (err) {
    console.error('[smoke] Fatal error:', err);
    transport.close(1011, 'smoke error');
    process.exit(1);
  }
}

main();
