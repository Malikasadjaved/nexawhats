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
//
// PRE-STATE SNAPSHOTS (D4.5 replay requirement)
// ─────────────────────────────────────────────
// For byte-identical replay we need the auth state EXACTLY as it was BEFORE
// the real Baileys call mutated it. This harness:
//   • snapshots (pre-key, session, signed-pre-key, sender-key) BEFORE calling
//     real.decryptMessage / decryptGroupMessage / processSenderKeyDistributionMessage,
//   • computes the correct storage keys via jidToSignalProtocolAddress and
//     SenderKeyName (the previous version keyed sender-key by the raw groupId,
//     which never matched — snapshots came back as empty `{}`),
//   • also snapshots the `after` state so replay assertions can verify side
//     effects (e.g. SKDM storing a new sender key).
//
// Replay in tests/unit/signal/repository.test.ts:
//   const store = hydrateFromSnapshot(fixture.authSnapshot.before, fixture.meta.creds)
//   const repo  = makeLibSignalRepository({ creds, keys: store }, silentLogger)
//   const out   = await repo.decryptMessage(fixture.input)
//   expect(out.toString('hex')).toBe(fixture.output.plaintext)

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

// Signal helpers — borrow the real implementations so storage-key computation
// is bit-identical to what Baileys writes.
const { makeLibSignalRepository } = req('@whiskeysockets/baileys/lib/Signal/libsignal.js');
const { SenderKeyName } = req('@whiskeysockets/baileys/lib/Signal/Group/sender-key-name.js');
const wabinary = req('@whiskeysockets/baileys/lib/WABinary/index.js');
const { jidDecode, WAJIDDomains } = wabinary;
const libsignal = req('libsignal');

// Re-implement jidToSignalProtocolAddress locally so we can generate the exact
// session/storage key Baileys uses without reaching into its non-exported
// internals.
function jidToSignalProtocolAddress(jid) {
  const decoded = jidDecode(jid);
  if (!decoded) throw new Error(`Could not decode JID: "${jid}"`);
  const { user, device, server, domainType } = decoded;
  if (!user) throw new Error(`JID decoded but user is empty: "${jid}"`);
  const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
  const finalDevice = device || 0;
  if (device === 99 && server !== 'hosted' && server !== 'hosted.lid') {
    throw new Error(`Unexpected non-hosted device JID with device 99: ${jid}`);
  }
  return new libsignal.ProtocolAddress(signalUser, finalDevice);
}

function jidToSignalSenderKeyName(group, user) {
  return new SenderKeyName(group, jidToSignalProtocolAddress(user));
}

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
function makeCapturingSignalRepository(auth, logger, pnToLIDFunc) {
  const real = makeLibSignalRepository(auth, logger, pnToLIDFunc);

  // Pull a targeted slice of the auth store. Returns a plain object shape:
  //   { [type]: { [id]: value|null } }
  // where missing ids show up as `null` so the replay hydrator can tell
  // "not present" from "present but empty".
  async function snapshotKeys(spec) {
    const out = {};
    for (const [t, ids] of Object.entries(spec)) {
      const uniq = Array.from(new Set(ids.filter((x) => x != null)));
      if (uniq.length === 0) {
        out[t] = {};
        continue;
      }
      try {
        const got = await auth.keys.get(t, uniq);
        const normalized = {};
        for (const id of uniq) {
          normalized[id] = got[id] ?? null;
        }
        out[t] = normalized;
      } catch (err) {
        out[t] = { __error: err.message };
      }
    }
    return out;
  }

  // Hex-encode a Buffer/Uint8Array. Previous implementation did
  // `Buffer.from(buf.buffer ?? buf)` which, for a Node Buffer, returns the
  // ENTIRE underlying ArrayBuffer pool (8KB+ of unrelated memory) instead of
  // the actual byte window. `Buffer.from(b)` on a Buffer/Uint8Array copies
  // only the window.
  const toHex = (buf) => {
    if (buf == null) return String(buf);
    if (Buffer.isBuffer(buf) || buf instanceof Uint8Array) {
      return Buffer.from(buf).toString('hex');
    }
    // Legacy { type: 'Buffer', data: [...] } shape
    if (typeof buf === 'object' && Array.isArray(buf.data)) {
      return Buffer.from(buf.data).toString('hex');
    }
    return String(buf);
  };

  // Extract pre-key IDs that libsignal will load while decrypting a pkmsg.
  // We don't know which yet — snapshot ALL pre-keys listed in creds so the
  // fixture is self-contained. (Baileys' PreKey store is keyed by numeric id
  // as string.)
  async function allPreKeyIds() {
    try {
      const nextId = auth.creds?.nextPreKeyId ?? 0;
      const firstId = 1;
      const ids = [];
      for (let i = firstId; i < nextId; i++) ids.push(String(i));
      return ids;
    } catch {
      return [];
    }
  }

  return {
    ...real,

    async decryptMessage(opts) {
      const t0 = Date.now();
      const addr = jidToSignalProtocolAddress(opts.jid).toString();
      const spec = {
        session: [addr, opts.jid],
        'pre-key': opts.type === 'pkmsg' ? await allPreKeyIds() : [],
      };
      const before = await snapshotKeys(spec);
      const plaintext = await real.decryptMessage(opts);
      const after = await snapshotKeys(spec);
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
        authSnapshot: { before, after },
        signalAddress: addr,
        meta: {
          ourJid: auth.creds?.me?.id ?? null,
          registrationId: auth.creds?.registrationId ?? null,
        },
      });
      return plaintext;
    },

    async decryptGroupMessage(opts) {
      const t0 = Date.now();
      const senderKeyId = jidToSignalSenderKeyName(opts.group, opts.authorJid).toString();
      const spec = { 'sender-key': [senderKeyId] };
      const before = await snapshotKeys(spec);
      const plaintext = await real.decryptGroupMessage(opts);
      const after = await snapshotKeys(spec);
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
        authSnapshot: { before, after },
        senderKeyId,
      });
      return plaintext;
    },

    async processSenderKeyDistributionMessage(opts) {
      const senderKeyId = jidToSignalSenderKeyName(
        opts.item.groupId,
        opts.authorJid,
      ).toString();
      const spec = { 'sender-key': [senderKeyId] };
      const before = await snapshotKeys(spec);
      await real.processSenderKeyDistributionMessage(opts);
      const after = await snapshotKeys(spec);
      writeFixture('senderkey', {
        capturedAt: new Date().toISOString(),
        input: {
          authorJid: opts.authorJid,
          groupId: opts.item.groupId,
          axolotlSenderKeyDistributionMessage: toHex(opts.item.axolotlSenderKeyDistributionMessage),
        },
        authSnapshot: { before, after },
        senderKeyId,
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
