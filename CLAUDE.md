# CLAUDE.md — NexaWhats

Context for Claude Code when working in this repository.

---

## Project Overview

**NexaWhats** is a production-grade WhatsApp Web API for Node.js — a
drop-in replacement for Baileys with pluggable auth stores, middleware,
observability, and a cleaner TypeScript surface.

- **Current version:** `0.1.0` (Track A shipped — primitives + drop-in
  auth) + Track B in progress (Phase 1 protocol, Phase 6 live transport)
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
│   ├── client.ts                      # WaClient — connect() currently stubs live transport
│   ├── binary/
│   │   ├── index.ts                   # Barrel (codec + jid utils)
│   │   ├── codec.ts                   # decodeBinaryNode / encodeBinaryNode
│   │   └── jid.ts                     # Port of Baileys WABinary/jid-utils (D4.4b)
│   ├── signal/
│   │   ├── group/                     # Signal Group ciphers (D4.4d + D4.4e, committed 804a94c)
│   │   │   ├── index.ts               # Barrel
│   │   │   ├── buffer-json.ts         # Buffer↔JSON replacer/reviver
│   │   │   ├── sender-key-name.ts     # (group, sender) identifier
│   │   │   ├── sender-key-record.ts   # Versioned state container
│   │   │   ├── sender-key-state.ts    # Chain + signing key state
│   │   │   ├── sender-chain-key.ts    # HKDF ratchet
│   │   │   ├── sender-message-key.ts  # Per-message key derivation
│   │   │   ├── keyhelper.ts           # sender-key / signing-key generation
│   │   │   ├── ciphertext-message.ts  # v1/v2 framing base
│   │   │   ├── sender-key-message.ts  # HMAC-signed encrypted body
│   │   │   ├── sender-key-distribution-message.ts   # SKDM envelope
│   │   │   ├── group-cipher.ts        # Encrypt/decrypt with SenderKeyStore
│   │   │   ├── group-session-builder.ts
│   │   │   └── libsignal-crypto.d.ts  # Ambient types for libsignal/src/*.js
│   │   └── lid-mapping.ts             # LIDMappingStore (D4.4f, committed 804a94c)
│   ├── socket/
│   │   ├── noise.ts                   # Noise XX handshake (D2)
│   │   └── transport.ts               # WsTransport (D3)
│   ├── proto/index.ts                 # Dynamic require('baileys/WAProto') bridge (D1)
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
│   │   ├── events.ts
│   │   ├── jid.ts
│   │   ├── message.ts
│   │   ├── socket.ts                  # ClientOptions incl. Logger
│   │   ├── errors.ts
│   │   └── index.ts
│   ├── queue/                         # Connection state machine + circuit breaker + message queue
│   ├── middleware/                    # Pluggable pipeline — builtin/logger.ts
│   ├── observability/                 # prom-client metrics + /health endpoint
│   ├── errors/
│   ├── utils/
│   │   ├── crypto.ts                  # hkdf, aesGcm, sha256, Curve.sharedKey, generateSignalPubKey,
│   │   │                              #   KEY_BUNDLE_TYPE (added D4 prep)
│   │   └── logger.ts                  # pino wrapper
│   ├── groups/                        # (empty — D6 target)
│   └── messages/                      # (empty — D6 target)
│
├── scripts/
│   ├── generate-noise-fixtures.mjs    # D2 fixture regenerator (needs NODE_PATH to Baileys)
│   └── capture-signal-fixtures.mjs    # D4 live capture harness (D4 prep, committed 588f304)
│
├── tests/
│   ├── unit/
│   │   ├── binary/jid.test.ts         # 26 tests (D4.4b)
│   │   ├── signal/
│   │   │   ├── lid-mapping.test.ts    # 19 tests (D4.4f)
│   │   │   └── group/
│   │   │       ├── data-classes.test.ts    # 31 tests (D4.4d)
│   │   │       ├── message-types.test.ts   # 9 tests (D4.4e) — guarded by haveFixture && haveProto
│   │   │       └── group-cipher.test.ts    # 5 tests (D4.4e) — guarded
│   │   ├── socket/ noise.test.ts, transport.test.ts
│   │   ├── store/     sqlite.test.ts, migrate.test.ts (11 pre-existing failures — unrelated to Track B)
│   │   └── …
│   ├── fixtures/
│   │   ├── noise/basic.json                       # D2 (committed)
│   │   ├── signal/*.local.json                    # D4 — 9 live captures (GITIGNORED)
│   │   └── auth-capture/                          # D4 — live auth state (GITIGNORED)
│   └── e2e/                           # Live smoke — NOT in CI (ban risk)
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
| **D4.4g — `libsignal.ts` orchestrator (~341 LoC)** | ⏭️ Next | — |
| D4.5 — fixture replay tests | ⏭️ After D4.4g | — |
| D5 — wire `client.connect()` end-to-end | ⏸️ After D4 | — |
| D6 — messages + groups (~2,200 LoC) | ⏸️ After D5 | — |

**Current gate state (after D4.4f):**
- `npx tsc --noEmit` → 0 errors
- `npx vitest run tests/unit/signal/` → 64/64 passing
- `npx biome check src/signal/ tests/unit/signal/` → clean
- Full suite: 352 passing, 4 skipped, **11 pre-existing store failures** in
  `tests/unit/store/sqlite.test.ts` + `migrate.test.ts` — not caused by
  Track B, verified via `git stash` baseline.

---

## Critical Gotchas

### `SignalKeyStore` has no `transaction()`
Baileys wraps writes in `keys.transaction(work, key)` for batching +
retry. Our `SignalKeyStore` interface doesn't. Workaround: issue a
single atomic `setKeys({ 'type': { ... } })` call with every mutation
batched in — SQLite WAL gives the same atomicity. `lid-mapping.ts` is
the first port applying this adapter; `libsignal.ts` (D4.4g) will need
the same treatment for `decryptGroupMessage` /
`processSenderKeyDistributionMessage` / `decryptMessage`.

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

### Pre-existing store test failures
11 failures in `tests/unit/store/sqlite.test.ts` +
`tests/unit/store/migrate.test.ts` predate Track B. `git stash`
baseline confirms. Do NOT fix them as part of Track B work — track as
separate tech debt.

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

## Next Session Checkpoint — D4.4g

**Source of truth:**
`D:/Digital Fte/body/my-bot/node_modules/@whiskeysockets/baileys/lib/Signal/libsignal.js`
(341 LoC)

**Port target:** `src/signal/libsignal.ts`

**Exports:**
- `makeLibSignalRepository(auth, logger, pnToLIDFunc?)` returning
  `SignalRepository` with:
  - `decryptGroupMessage({ group, authorJid, msg })`
  - `processSenderKeyDistributionMessage({ item, authorJid })`
  - `decryptMessage({ jid, type, ciphertext })`
  - `encryptMessage({ jid, data })`
  - `encryptGroupMessage({ group, meId, data })`
  - `injectE2ESession({ jid, session })`
  - `jidToSignalProtocolAddress(jid)`

**Key adapters needed:**
- Drop `parsedKeys.transaction(work, key)` wrapping — call `work()`
  directly (SQLite WAL handles atomicity). Same approach as
  `lid-mapping.ts`.
- `signalStorage(auth, lidMapping)` — wraps our `SignalKeyStore` into
  the shape libsignal-node expects (`loadSession`, `storeSession`,
  `loadPreKey`, `storePreKey`, `removePreKey`, `loadSignedPreKey`,
  `loadIdentityKey`, `storeSenderKey`, `loadSenderKey`, etc.)
- `migratedSessionCache` — LRU, 3-day TTL, same config as `LIDMappingStore`
- `jidToSignalProtocolAddress(jid)` — uses `jidDecode` + handles LID
  device transfer via `LIDMappingStore.getPNForLID()`

**Gates:** tsc 0 + biome clean + `npx vitest run tests/unit/signal/`
all green. Unit tests at this stage can be minimal (structural +
exported surface) — the real verification comes in D4.5 fixture
replay.

**D4.5 after D4.4g:** `tests/unit/signal/repository.test.ts` — 4 test
groups: pkmsg, msg (×5), senderkey, group decrypt. Hydrate
`AuthStore` from each fixture's `authSnapshot`, call the matching
method, assert `output.plaintext` matches byte-for-byte. If any
fixture fails to round-trip, STOP — that's silent-decrypt bug
territory.

---

## Verification Commands

```bash
cd D:/nexawhats

# Type-check only
npx tsc --noEmit

# Unit tests (all)
npx vitest run

# Unit tests (signal only — D4.4d-f scope)
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
