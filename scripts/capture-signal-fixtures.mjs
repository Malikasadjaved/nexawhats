// Capture Signal Protocol fixtures from a live Baileys session.
//
// Track B / Deliverable 4 requires real encrypted frames paired with their
// plaintexts so the nexawhats port can be tested for byte-identical decrypt.
// Unit tests alone are not sufficient — E2E decrypt bugs are silent.
//
// Strategy:
//   1. Borrow Baileys from my-bot via NODE_PATH (same pattern as
//      generate-noise-fixtures.mjs).
//   2. Pair WhatsApp via pairing code (mirroring the 5 bug fixes from
//      D:/Digital Fte/body/my-bot/src/whatsapp-auth.ts).
//   3. Inject a wrapped `makeSignalRepository` into makeWASocket that proxies
//      every method call and records (inputs, outputs) as fixtures.
//   4. Stop after quota: 1 pkmsg + 1 sender-key + 5 plain msg + 1 reaction +
//      1 edit. Exit cleanly.
//
// Usage (from D:/nexawhats):
//   NODE_PATH="D:/Digital Fte/body/my-bot/node_modules" \
//     node scripts/capture-signal-fixtures.mjs --phone 923394572313
//
// Output (gitignored by default):
//   tests/fixtures/auth-capture/                 <- live auth state
//   tests/fixtures/signal/pkmsg.local.json
//   tests/fixtures/signal/senderkey.local.json
//   tests/fixtures/signal/msg-1.local.json ... msg-5.local.json
//   tests/fixtures/signal/reaction.local.json
//   tests/fixtures/signal/edit.local.json
//
// The `.local.json` suffix keeps them out of git. After review, sanitize and
// commit selected fixtures as `<name>.json` by hand.
//
// SAFETY NOTE: The emitted fixtures embed fragments of auth state (session
// bytes, sender keys). Do NOT commit the raw `.local.json` files — only
// curated fixtures where you've stripped any non-test identifiers.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

// ── Parse --phone ──────────────────────────────────────────────────────────────
const idx = process.argv.indexOf('--phone');
const phoneArg = idx !== -1 ? process.argv[idx + 1] : undefined;
if (!phoneArg) {
  console.error('Usage: node scripts/capture-signal-fixtures.mjs --phone 923xxxxxxxx');
  process.exit(1);
}
const PHONE = phoneArg.trim().replace(/\D/g, '');
if (PHONE.length < 10) {
  console.error('Invalid phone number. Use digits only with country code, e.g. 923394572313');
  process.exit(1);
}

// ── Load Baileys via NODE_PATH ────────────────────────────────────────────────
let baileys;
try {
  baileys = req('@whiskeysockets/baileys');
} catch (err) {
  console.error('Could not load @whiskeysockets/baileys.');
  console.error(
    'Run with: NODE_PATH="D:/Digital Fte/body/my-bot/node_modules" node scripts/capture-signal-fixtures.mjs --phone ...',
  );
  console.error('Underlying error:', err.message);
  process.exit(1);
}

const {
  default: makeWASocket,
  Browsers,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = baileys;

// Baileys exports makeWASocket via `module.exports.default = ...` — in CJS the
// shim we `req()` above already gives it back flat, but handle both shapes.
const wasocket = typeof makeWASocket === 'function' ? makeWASocket : baileys.makeWASocket;

// Silent logger (pino-compatible shape Baileys needs internally)
const silentLogger = {
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  level: 'silent',
};

// ── Paths ─────────────────────────────────────────────────────────────────────
const authDir = resolve(__dirname, '../tests/fixtures/auth-capture');
const fixtureDir = resolve(__dirname, '../tests/fixtures/signal');
mkdirSync(authDir, { recursive: true });
mkdirSync(fixtureDir, { recursive: true });

// ── Fixture quota ─────────────────────────────────────────────────────────────
const QUOTA = {
  pkmsg: 1, // fresh session / pre-key whisper message
  senderkey: 1, // group sender-key distribution
  msg: 5, // plain 1:1 whisper messages
  reaction: 1, // message reaction (protocol message)
  edit: 1, // message edit (protocol message)
};
const counts = { pkmsg: 0, senderkey: 0, msg: 0, reaction: 0, edit: 0 };
const quotaFull = () => Object.entries(QUOTA).every(([k, v]) => counts[k] >= v);

// ── Fixture writer ────────────────────────────────────────────────────────────
function writeFixture(category, payload) {
  const n = ++counts[category];
  if (n > QUOTA[category]) return; // already satisfied, ignore overflow
  const name = QUOTA[category] === 1 ? category : `${category}-${n}`;
  const file = resolve(fixtureDir, `${name}.local.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`  [${category}:${n}/${QUOTA[category]}] -> ${file}`);
  if (quotaFull()) {
    console.log('\n✓ All fixture quotas met. Exiting in 3s.');
    setTimeout(() => process.exit(0), 3000);
  }
}

// ── Wrapped signal repository factory ─────────────────────────────────────────
// Baileys will call this with (auth, logger, pnToLIDFunc). We delegate to the
// real makeLibSignalRepository and proxy every method to record I/O.
const { makeLibSignalRepository } = req('@whiskeysockets/baileys/lib/Signal/libsignal.js');

function makeCapturingSignalRepository(auth, logger, pnToLIDFunc) {
  const real = makeLibSignalRepository(auth, logger, pnToLIDFunc);

  // Snapshot a minimal slice of auth state so fixtures are self-contained
  // enough to replay. We copy signed/pre keys and any relevant session IDs
  // via the existing AuthStore get() API.
  async function snapshotKeys(types, ids) {
    const out = {};
    for (const t of types) {
      try {
        out[t] = await auth.keys.get(t, ids);
      } catch (err) {
        out[t] = { __error: err.message };
      }
    }
    return out;
  }

  const toHex = (buf) =>
    buf && typeof buf === 'object' ? Buffer.from(buf.buffer ?? buf).toString('hex') : String(buf);

  return {
    ...real,

    async decryptMessage(opts) {
      const t0 = Date.now();
      const plaintext = await real.decryptMessage(opts);
      const keys = await snapshotKeys(
        ['pre-key', 'session', 'signed-pre-key'],
        [opts.jid.split('@')[0], opts.jid],
      );
      const category = opts.type === 'pkmsg' ? 'pkmsg' : 'msg';
      writeFixture(category, {
        capturedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        input: {
          jid: opts.jid,
          type: opts.type,
          ciphertext: toHex(opts.ciphertext),
        },
        output: { plaintext: toHex(plaintext) },
        authSnapshot: keys,
        meta: {
          ourJid: auth.creds?.me?.id ?? null,
          registrationId: auth.creds?.registrationId ?? null,
        },
      });
      return plaintext;
    },

    async decryptGroupMessage(opts) {
      const t0 = Date.now();
      const plaintext = await real.decryptGroupMessage(opts);
      const keys = await snapshotKeys(
        ['sender-key'],
        [`${opts.group}::${opts.authorJid}`, opts.group],
      );
      writeFixture('msg', {
        capturedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        input: {
          kind: 'groupMessage',
          group: opts.group,
          authorJid: opts.authorJid,
          ciphertext: toHex(opts.msg),
        },
        output: { plaintext: toHex(plaintext) },
        authSnapshot: keys,
      });
      return plaintext;
    },

    async processSenderKeyDistributionMessage(opts) {
      const before = await snapshotKeys(['sender-key'], [opts.item.groupId]);
      await real.processSenderKeyDistributionMessage(opts);
      const after = await snapshotKeys(['sender-key'], [opts.item.groupId]);
      writeFixture('senderkey', {
        capturedAt: new Date().toISOString(),
        input: {
          authorJid: opts.authorJid,
          groupId: opts.item.groupId,
          axolotlSenderKeyDistributionMessage: toHex(opts.item.axolotlSenderKeyDistributionMessage),
        },
        authSnapshot: { before, after },
      });
    },
  };
}

// ── Classify Baileys `messages.upsert` payloads for reaction / edit ───────────
// decryptMessage captures plain `msg` and `pkmsg` frames. But reactions and
// edits arrive as "protocol messages" inside an already-decrypted envelope;
// we snapshot those on the messages.upsert event instead.
function hookProtocolMessages(sock) {
  sock.ev.on('messages.upsert', (evt) => {
    if (quotaFull()) return;
    for (const m of evt.messages ?? []) {
      if (!m?.message) continue;
      const protoKeys = Object.keys(m.message);
      if (m.message.reactionMessage && counts.reaction < QUOTA.reaction) {
        writeFixture('reaction', {
          capturedAt: new Date().toISOString(),
          source: 'messages.upsert',
          messageKey: m.key,
          protocolKeys: protoKeys,
          reactionMessage: m.message.reactionMessage,
        });
      }
      if (m.message.protocolMessage?.type === 14 /* MESSAGE_EDIT */ && counts.edit < QUOTA.edit) {
        writeFixture('edit', {
          capturedAt: new Date().toISOString(),
          source: 'messages.upsert',
          messageKey: m.key,
          protocolKeys: protoKeys,
          protocolMessage: m.message.protocolMessage,
        });
      }
      if (m.message.editedMessage && counts.edit < QUOTA.edit) {
        writeFixture('edit', {
          capturedAt: new Date().toISOString(),
          source: 'messages.upsert',
          messageKey: m.key,
          protocolKeys: protoKeys,
          editedMessage: m.message.editedMessage,
        });
      }
    }
  });
}

// ── Progress printer ──────────────────────────────────────────────────────────
function printStatus() {
  if (quotaFull()) return;
  const pending = Object.entries(QUOTA)
    .filter(([k]) => counts[k] < QUOTA[k])
    .map(([k, v]) => `${k}:${counts[k]}/${v}`)
    .join('  ');
  console.log(`[status] waiting for ${pending}`);
}

// ── Connect + pair (mirrors whatsapp-auth.ts) ─────────────────────────────────
async function connectSocket(isReconnect = false) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  if (!isReconnect && state.creds.registered) {
    console.log(`[auth] already registered as ${state.creds.me?.id ?? '?'} — skipping pairing`);
  }

  const { version } = await fetchLatestBaileysVersion();

  const sock = wasocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    printQRInTerminal: false,
    logger: silentLogger,
    browser: Browsers.ubuntu('Chrome'),
    makeSignalRepository: makeCapturingSignalRepository,
  });

  let pairingCodeRequested = false;

  sock.ev.on('creds.update', saveCreds);
  hookProtocolMessages(sock);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !pairingCodeRequested && !state.creds.registered) {
      pairingCodeRequested = true;
      sock
        .requestPairingCode(PHONE)
        .then((code) => {
          console.log('\n========================================');
          console.log(`  Phone : +${PHONE}`);
          console.log(`  Code  : ${code}`);
          console.log('========================================');
          console.log('\nWhatsApp -> Linked Devices -> Link a Device');
          console.log('-> Link with phone number -> enter code above\n');
          console.log('Waiting for pairing...\n');
        })
        .catch((err) => {
          console.error('Failed to request pairing code:', err.message);
          process.exit(1);
        });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        console.error('\nLogged out. Delete tests/fixtures/auth-capture/ and retry.');
        process.exit(1);
      }
      if (reason === 403 || reason === 405) {
        console.error(`\nConnection rejected (${reason}). Number is rate-limited or banned.`);
        console.error('  Switch to a mobile hotspot (different IP) and retry.');
        console.error('  If still failing: wait 24-72h or use a different number.');
        process.exit(1);
      }
      if (reason === 515) {
        console.log('\n[auth] post-pairing handshake - reconnecting...');
        connectSocket(true);
        return;
      }

      console.error(`\nDisconnected (${reason ?? 'unknown'}). Exiting.`);
      process.exit(1);
    }

    if (connection === 'open') {
      console.log(`\n[ok] Connected as ${sock.authState.creds.me?.id ?? '?'}`);
      console.log('\nNext steps — send traffic FROM ANOTHER NUMBER to this one:');
      console.log('  1) pkmsg: text me from a number that has NEVER messaged this account before');
      console.log('  2) senderkey: add me to a NEW group and have someone post a message');
      console.log('  3) msg x5: send 5 plain texts from any existing contact');
      console.log("  4) reaction: react (any emoji) to any message I've sent");
      console.log('  5) edit: edit any message you sent me');
      console.log(
        '\nFixtures will auto-write as each category fills. Script exits when all 5 quotas hit.\n',
      );
      setInterval(printStatus, 30_000);
    }
  });
}

connectSocket().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
