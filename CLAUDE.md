# CLAUDE.md — NexaWhats

Context for Claude Code when working in this repository.

---

## Project Overview

**NexaWhats** is a production-grade WhatsApp Web API for Node.js — a
drop-in replacement for Baileys with pluggable auth stores, middleware,
observability, and a cleaner TypeScript surface.

- **Current version:** `0.1.0` → heading toward `0.2.0`
- **Target version:** `0.2.0` — first release that can actually
  send/receive WhatsApp messages
- **Source of truth for the protocol port:** Baileys v7.0.0-rc.9 at
  `D:/Digital Fte/body/my-bot/node_modules/@whiskeysockets/baileys`
- **Track plan:** `C:/Users/HP/.claude/plans/nexawhats-track-b.md`

---

## Directory Structure

```
D:/nexawhats/
├── CLAUDE.md                          # This file
├── README.md
├── CONTRIBUTING.md
├── DISCLAIMER.md
├── package.json                       # "nexawhats" 0.1.0 — ESM + CJS dual build
├── tsconfig.json                      # strict, NodeNext modules
├── biome.json                         # formatter + linter config
├── vitest.config.ts
│
├── src/
│   ├── index.ts                       # Public barrel — exports client, stores, types, middleware
│   ├── client.ts                      # NexaWhatsClient — full connect loop with retry, events, middleware
│   ├── client/
│   │   └── connect.ts                 # Single-connection driver (WebSocket + Noise + keepalive)
│   ├── binary/
│   │   ├── index.ts                   # Barrel (codec + jid utils)
│   │   ├── codec.ts                   # decodeBinaryNode / encodeBinaryNode
│   │   └── jid.ts                     # Port of Baileys WABinary/jid-utils (D4.4b)
│   ├── signal/
│   │   ├── libsignal.ts               # Signal repository orchestrator (D4.4g — shipped)
│   │   ├── lid-mapping.ts             # LIDMappingStore (D4.4f)
│   │   ├── keys.ts                    # CacheableSignalKeyStore wrapper
│   │   └── group/                     # Signal Group ciphers (D4.4d + D4.4e)
│   │       ├── index.ts               # Barrel
│   │       ├── buffer-json.ts         # Buffer↔JSON replacer/reviver
│   │       ├── sender-key-name.ts     # (group, sender) identifier
│   │       ├── sender-key-record.ts   # Versioned state container
│   │       ├── sender-key-state.ts    # Chain + signing key state
│   │       ├── sender-chain-key.ts    # HKDF ratchet
│   │       ├── sender-message-key.ts  # Per-message key derivation
│   │       ├── keyhelper.ts           # sender-key / signing-key generation
│   │       ├── ciphertext-message.ts  # v1/v2 framing base
│   │       ├── sender-key-message.ts  # HMAC-signed encrypted body
│   │       ├── sender-key-distribution-message.ts   # SKDM envelope
│   │       ├── group-cipher.ts        # Encrypt/decrypt with SenderKeyStore
│   │       ├── group-session-builder.ts
│   │       └── libsignal-crypto.d.ts  # Ambient types for libsignal/src/*.js
│   ├── socket/
│   │   ├── index.ts                   # Barrel
│   │   ├── noise.ts                   # Noise XX handshake (D2)
│   │   ├── transport.ts               # WsTransport (D3)
│   │   ├── handshake.ts               # Handshake orchestrator (ClientHello → ServerHello → ClientFinish)
│   │   ├── keepalive.ts               # Ping/pong keepalive watchdog
│   │   ├── pairing.ts                 # QR + pairing-code device linking
│   │   ├── state-machine.ts           # Connection state machine
│   │   └── circuit-breaker.ts         # Failure-based circuit breaker
│   ├── proto/
│   │   ├── index.ts                   # Dynamic require('baileys/WAProto') bridge (D1)
│   │   └── payload.ts                 # generateLoginNode / generateRegistrationNode
│   ├── store/
│   │   ├── interface.ts               # AuthStore + storeToAuthState adapter
│   │   ├── memory.ts                  # MemoryAuthStore
│   │   ├── file.ts                    # FileAuthStore (Baileys-compatible JSON)
│   │   ├── sqlite.ts                  # SQLiteAuthStore (production default)
│   │   ├── migrate.ts                 # Baileys → SQLite migration
│   │   ├── serialize.ts               # Buffer-aware serialize/deserialize
│   │   └── index.ts                   # Barrel
│   ├── types/
│   │   ├── auth.ts                    # AuthenticationCreds, SignalKeyStore, SignalDataTypeMap
│   │   ├── events.ts                  # NexaWhatsEventMap
│   │   ├── group.ts                   # GroupMetadataFull, GroupAction, etc.
│   │   ├── message.ts                 # WAMessage, AnyMessageContent, etc.
│   │   ├── socket.ts                  # ClientConfig, ConnectionState, etc.
│   │   ├── errors.ts
│   │   └── index.ts
│   ├── queue/                         # Message queue + rate limiter + dead letter
│   ├── middleware/                     # Pluggable pipeline — builtin/ (anti-ban, lid-resolver, logger)
│   ├── observability/                 # prom-client metrics + /health endpoint
│   ├── errors/
│   ├── utils/
│   │   ├── auth.ts                    # initAuthCreds (D5/D6)
│   │   ├── crypto.ts                  # hkdf, aesGcm, sha256, Curve.sharedKey, generateSignalPubKey
│   │   └── logger.ts                  # pino wrapper
│   ├── groups/                        # Group operations (create, leave, metadata, participants, etc.)
│   │   ├── index.ts                   # makeGroupOperations + extractGroupMetadata
│   │   └── types.ts                   # Re-exports from types/group.ts
│   └── messages/                      # Message send + receive pipeline
│       ├── index.ts                   # Barrel
│       ├── encode.ts                  # generateWAMessage / generateWAMessageContent (AnyMessageContent → proto)
│       ├── send.ts                    # MessageSender (queue wrapping)
│       ├── send-relay.ts              # makeMessageRelay — encrypt, build stanzas, route to devices
│       ├── receive.ts                 # extractText, getSenderJid, getChatJid, hasMedia, getMediaType
│       ├── recv.ts                    # decryptMessageNode, decodeMessageNode, cleanMessage
│       ├── media.ts                   # resolveMediaUpload
│       └── types.ts                   # Re-exports
│
├── scripts/
│   ├── generate-noise-fixtures.mjs    # D2 fixture regenerator
│   ├── capture-signal-fixtures.mjs    # D4 live capture harness
│   ├── smoke-connect.mjs              # D5 handshake-level smoke test
│   └── re-auth.ts                     # Fresh pairing tool (QR + pairing code)
│
├── auth-smoke/                        # Session store for re-auth script (gitignored)
│
├── examples/
│   ├── README.md
│   ├── basic-bot/index.ts             # Minimal echo bot with FileAuthStore + middleware
│   ├── multi-account/index.ts         # Multiple WhatsApp numbers from one process
│   ├── media-download/index.ts        # Media detection in incoming messages
│   └── group-management/index.ts      # Group event listening
│
├── tests/
│   ├── unit/
│   │   ├── binary/ (codec, jid, circuit-breaker, state-machine)
│   │   ├── signal/ (repository, lid-mapping, group/)
│   │   ├── socket/ (noise, transport, keepalive, pairing, handshake)
│   │   ├── store/ (sqlite, file, memory, migrate, serialize)
│   │   ├── messages/ (encode, recv, media)
│   │   ├── groups/ (index)
│   │   ├── proto/ (proto, payload)
│   │   ├── utils/ (auth, crypto, jid, retry)
│   │   ├── middleware/ (pipeline)
│   │   ├── observability/ (metrics, health)
│   │   ├── errors/ (errors)
│   │   └── queue/ (rate-limiter, dead-letter)
│   ├── fixtures/
│   │   ├── noise/basic.json                       # D2 (committed)
│   │   ├── signal/*.local.json                    # D4 — 9 live captures (GITIGNORED)
│   │   └── auth-capture/                          # D4 — live auth state (GITIGNORED)
│   └── e2e/                                       # Live smoke — NOT in CI (ban risk)
│       └── live-smoke.ts                          # Full-pipeline e2e test (D6)
│
└── .gitignore                         # excludes tests/fixtures/auth-capture/ + *.local.json
```

---

## Track B Progress

| Deliverable | Status | Commit |
|-------------|--------|--------|
| D1 — WAProto integration | ✅ Shipped | cf37864 |
| D2 — Noise handshake | ✅ Shipped | cf37864 |
| D3 — WebSocket transport | ✅ Shipped | cf37864 |
| D4 prep — capture harness, jid utils, crypto helpers, libsignal dep | ✅ Shipped | 588f304 |
| D4.4a — add libsignal dep | ✅ In prep commit | 588f304 |
| D4.4b — port `WABinary/jid-utils.ts` | ✅ In prep commit | 588f304 |
| D4.4c — `KEY_BUNDLE_TYPE` + `generateSignalPubKey` | ✅ In prep commit | 588f304 |
| D4.4d — Group data classes (6 files, 207 LoC) | ✅ Shipped | 804a94c |
| D4.4e — message types + ciphers (~250 LoC) | ✅ Shipped | 804a94c |
| D4.4f — `LIDMappingStore` | ✅ Shipped | 804a94c |
| D4.4g — `libsignal.ts` orchestrator (465 LoC) | ✅ Shipped | (uncommitted) |
| D4.5 — fixture replay tests (`repository.test.ts`, 7 tests) | ✅ Shipped | (uncommitted) |
| D5 — wire `client.connect()` end-to-end | ✅ Shipped | (uncommitted) |
| D6 — messages + groups (~2,200 LoC) | ✅ Shipped | (uncommitted) |

**Current gate state:**
- `npx tsc --noEmit` → 0 errors
- `npx vitest run` → **502 passing**, 4 skipped, 0 failures (36 test files)
- `npx vitest run tests/unit/signal/` → 64/64 passing
- `npx biome check src/ tests/` → clean

**Remaining for 0.2.0 release gate:**
- `tests/e2e/live-smoke.ts` — 1-hour live smoke against real WhatsApp number
- `examples/basic-bot/index.ts` — echo bot verified against live server

---

## Critical Gotchas

### `SignalKeyStore` has no `transaction()`
Baileys wraps writes in `keys.transaction(work, key)` for batching +
retry. Our `SignalKeyStore` interface doesn't. Workaround: issue a
single atomic `setKeys({ 'type': { ... } })` call with every mutation
batched in — SQLite WAL gives the same atomicity. Applied in both
`lid-mapping.ts` and `libsignal.ts`.

### Fixture schema differs from the plan
Our `capture-signal-fixtures.mjs` records
`{ input, output, authSnapshot, meta }` — NOT the
`{ encryptedFrame, expectedPlaintext, authState }` shape the Track B
plan originally specified. D4.5 replay tests must destructure the
actual shape (see `tests/unit/signal/group/message-types.test.ts` for
the pattern — it extracts the inner SKDM via
`proto.Message.decode(wrapper).senderKeyDistributionMessage.axolotlSenderKeyDistributionMessage`).

### Protocol fixtures (reaction + edit) are NOT repository-level
`reaction.local.json` and `edit.local.json` were captured via
`messages.upsert` — they arrive inside already-decrypted envelopes and
don't hit `decryptMessage`. They belong to D6's `messages-recv` tests,
not D4.5.

### `libsignal` is the git tarball, not the npm publication
Baileys uses
`"libsignal": "git+https://github.com/whiskeysockets/libsignal-node"`
which publishes internally as `"name": "libsignal"`. There's a
separate `@whiskeysockets/libsignal-node@2.0.1` on npm — do NOT use
it. Match Baileys.

### `isLidUser('foo@hosted.lid')` is `false`
`'foo@hosted.lid'.endsWith('@lid')` is `false` — the period breaks the
suffix match. This is Baileys' behaviour and we preserve it
faithfully. Hosted LIDs are matched by `isHostedLidUser` only.

### `jidDecode()` preserves device IDs
PN JIDs like `923315244441:3@s.whatsapp.net` decode to
`{ user: '923315244441', device: 3 }`. The LID mapping keys by `user`
only (device-independent); the device is re-attached on output.
Never key storage by a device-suffixed string.

### Pre-key bundle IQ uses `skey`, NOT `signed_pre_key`
The WhatsApp XMPP protocol expects the signed pre-key element as
`<skey>` in the pre-key upload IQ. Using `signed_pre_key` causes the
server to silently ignore the entire IQ → 30s timeout. Baileys'
`xmppSignedPreKey` (signal.js:41) uses tag `skey`. Also matches the
registration payload's `eSkeyId`/`eSkeyVal`/`eSkeySig` naming.

### `connect()` MUST wait for login outcome before returning
`connectOnce()` returns immediately after the Noise handshake —
the server's login response (success/failure/pair-success) arrives
later via the `onFrame` callback. The connect loop uses a
`loginOutcome` promise that the `onFrame` handler resolves when it
sees `success`, `failure`, or `pair-success`. The post-connectOnce
code awaits this promise and either returns (success), continues the
loop (pair-success → reconnect for login), or retries (failure).

### Pairing flow: pair-success → stream error → reconnect → login
When pairing via QR or pairing code, the server:
1. Sends `pair-device` IQs (QR cycling)
2. On successful pair: sends `pair-success` IQ
3. Then sends `stream:error` to force a reconnect
4. On reconnect: sends `success` (login, now that `creds.registered` is true)
The `pairSuccessReceived` flag skips the "stream error" warning when set.

### `phoneNumber` config triggers new pairing code unless guarded
In `client.ts`, if `!creds.pairingCode && !creds.registered && this.config.phoneNumber`,
a fresh pairing code is generated. Without the `!creds.registered` guard,
an already-paired session with `phoneNumber` set would regenerate a
pairing code and overwrite `creds.me`, causing a 401 on the next login
attempt. The re-auth script sets `phoneNumber`; the echo bot should
NOT set it when reusing a saved session.

### `FileAuthStore` paths are relative to CWD, not the script
`new FileAuthStore('./auth')` resolves relative to `process.cwd()`.
When running `npx tsx examples/basic-bot/index.ts` from the repo root,
`./auth` resolves to `D:/nexawhats/auth/`, not `examples/basic-bot/auth/`.
The re-auth script uses `./auth-smoke` consistently.
Always verify the auth directory exists after startup.

### Use `scripts/re-auth.ts` for fresh pairing, not the echo bot
`scripts/re-auth.ts` has a battle-tested pairing flow:
- `npx tsx scripts/re-auth.ts <phone>` — pairing code mode (8-char code)
- `npx tsx scripts/re-auth.ts <phone> --qr` — QR code mode (scan URL)
- Saves to `./auth-smoke/` and `tests/fixtures/auth-capture/creds.json`
- Handles disconnect/reconnect after pairing automatically
- 90s timeout, exits cleanly after successful registration

---

## Live Capture Harness

`scripts/capture-signal-fixtures.mjs` borrows Baileys via
`NODE_PATH="D:/Digital Fte/body/my-bot/node_modules"` (same pattern as
`generate-noise-fixtures.mjs`). Pairs via pairing code — mirrors the
five 405/515 bug fixes from `body/my-bot/src/whatsapp-auth.ts`:

| Bug | Fix |
|-----|-----|
| `requestPairingCode` called too early | Inside `qr` event (handshake complete) |
| Stale WA version | `fetchLatestBaileysVersion()` before `makeWASocket` |
| Custom browser string | `Browsers.ubuntu('Chrome')` |
| 405 treated as recoverable | `process.exit(1)` |
| 515 not handled | Specific 515 branch → reconnect |

Injects a wrapped `makeSignalRepository` that proxies every call on
`makeLibSignalRepository` and records `(input, output, authSnapshot)`
tuples as `*.local.json`. Auto-exits when quota is met (1 pkmsg + 1
senderkey + 5 msg + 1 reaction + 1 edit).

**Fixtures and auth state are gitignored.** Do not stage
`tests/fixtures/auth-capture/` or `tests/fixtures/signal/*.local.json`
— they embed live WhatsApp session bytes.

**Current fixtures (captured 2026-04-19 against `923394572313`,
traffic from `923315244441`):** 9 files on disk at
`tests/fixtures/signal/`:
- `pkmsg.local.json` — fresh-session PreKey Whisper Message
- `senderkey.local.json` — group sender-key distribution
- `msg-1.local.json` … `msg-5.local.json` — plain 1:1 whisper messages
- `reaction.local.json` — group reaction `❤️` (messages.upsert, not decrypt hook)
- `edit.local.json` — `protocolMessage.type === MESSAGE_EDIT` (messages.upsert)

---

## Verification Commands

```bash
cd D:/nexawhats

# Type-check only
npx tsc --noEmit

# Unit tests (all)
npx vitest run

# Unit tests (signal only)
npx vitest run tests/unit/signal/

# Lint + format check
npx biome check src/ tests/

# Auto-fix formatting
npx biome check --write src/ tests/
```

**Release gate for 0.2.0** (per Track B plan §"Cross-cutting"):
- All six deliverables green
- `tests/e2e/live-smoke.ts` runs clean for 1 hour against a real
  WhatsApp number
- `examples/basic-bot/index.ts` echoes messages successfully

---

## Git Conventions

- Commit style: `feat(track-b): <deliverable> — <summary>`
- Never commit `tests/fixtures/auth-capture/` or `*.local.json`
- Never force-push `main`
- Commit only when the user explicitly asks
