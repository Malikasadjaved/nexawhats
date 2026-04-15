# NexaWhats

[![CI](https://github.com/Malikasadjaved/nexawhats/actions/workflows/ci.yml/badge.svg)](https://github.com/Malikasadjaved/nexawhats/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/nexawhats)](https://www.npmjs.com/package/nexawhats)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

**Production-grade WhatsApp Web API for Node.js**

NexaWhats is a complete rewrite of the WhatsApp Web API layer, built on top of battle-tested protocol code. It fixes the critical production issues in existing libraries while providing a modern, type-safe, and extensible API.

## Why NexaWhats?

- **Rock-solid connections** — State machine + circuit breaker handles every WhatsApp disconnect (401/403/405/463/515) automatically
- **Production-ready auth** — Pluggable stores (SQLite, Memory, File) with atomic writes. No more JSON file corruption.
- **Built-in rate limiting** — Token bucket queue with human-like timing. Never get banned for sending too fast.
- **Middleware pipeline** — Koa-style `use()` for message processing, LID resolution, logging, and anti-ban
- **Full type safety** — Discriminated unions for message types, typed events, zero `any` in the public API

## Quick Start

```typescript
import { createClient, MemoryAuthStore } from 'nexawhats';

const store = new MemoryAuthStore();
const state = await store.loadState();

const client = createClient({
  auth: state ?? { creds: {}, keys: store },
  queue: { messagesPerMinute: 20, humanLikeTiming: true },
});

// Middleware
client.use(async (ctx, next) => {
  console.log(`Message from ${ctx.senderName}: ${ctx.text}`);
  await next();
});

// Event handling
client.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return;
  for (const msg of messages) {
    if (msg.key.fromMe) continue;
    await client.send(msg.key.remoteJid!, { text: 'Hello from NexaWhats!' });
  }
});

await client.connect();
```

## Installation

```bash
npm install nexawhats
# or
pnpm add nexawhats
# or
yarn add nexawhats
```

For SQLite auth store (recommended for production):
```bash
npm install better-sqlite3
```

## Features

### Connection Management
- Connection state machine (disconnected / connecting / connected / reconnecting)
- Circuit breaker with auto-recovery (trips on rate limits, resets on success)
- Exponential backoff with configurable delays
- Auto version negotiation (fetches latest WhatsApp Web version)

### Authentication
- **SQLiteAuthStore** — Production default. Atomic writes, WAL mode, crash-safe.
- **MemoryAuthStore** — For testing. No persistence.
- **FileAuthStore** — Baileys-compatible. Same file format for easy migration.
- Cacheable Signal key store with bounded LRU cache

### Message Queue
- Priority levels: urgent > high > normal > low
- Token bucket rate limiter (default: 20/min)
- Human-like timing with gaussian jitter
- Dead-letter queue for permanently failed messages

### Middleware
```typescript
// LID resolver — auto-translates @lid JIDs to phone numbers
import { lidResolver, antiBan, messageLogger } from 'nexawhats';

client.use(lidResolver());
client.use(antiBan({ minDelay: 1000, maxDelay: 3000 }));
client.use(messageLogger());
```

### Message Utilities
```typescript
import { extractText, isGroupMessage, hasMedia, getMediaType } from 'nexawhats';

const text = extractText(message);        // Handles all text types
const isGroup = isGroupMessage(message);  // true for @g.us
const media = hasMedia(message);          // image/video/audio/doc/sticker
```

### JID Utilities
```typescript
import { jidDecode, jidEncode, isLidUser, phoneFromJid } from 'nexawhats';

jidDecode('923124166950@s.whatsapp.net');
// { user: '923124166950', server: 's.whatsapp.net' }

isLidUser('197151900590225@lid');  // true
phoneFromJid('923124166950@s.whatsapp.net');  // '923124166950'
```

## Stores

### SQLite (Production)
```typescript
// Coming in v0.2.0
import { SQLiteAuthStore } from 'nexawhats/store';
const store = new SQLiteAuthStore('./nexawhats.db');
```

### Memory (Testing)
```typescript
import { MemoryAuthStore } from 'nexawhats';
const store = new MemoryAuthStore();
```

### Custom Store
```typescript
import type { AuthStore } from 'nexawhats';

class MyRedisStore implements AuthStore {
  async loadState() { /* ... */ }
  async saveState(state) { /* ... */ }
  async saveCreds(creds) { /* ... */ }
  async getKeys(type, ids) { /* ... */ }
  async setKeys(data) { /* ... */ }
  async clear() { /* ... */ }
}
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connection.update` | `Partial<ConnectionState>` | Connection state changed |
| `creds.update` | `Partial<AuthenticationCreds>` | Credentials updated (save them!) |
| `messages.upsert` | `{ messages, type }` | New messages received |
| `messages.update` | `WAMessageUpdate[]` | Messages edited/deleted |
| `messages.reaction` | `{ key, reaction }[]` | Reaction added/removed |
| `groups.upsert` | `GroupMetadata[]` | Joined a new group |
| `group-participants.update` | `{ id, participants, action }` | Member added/removed/promoted |
| `presence.update` | `{ id, presences }` | Typing/online status |
| `call` | `WACallEvent[]` | Incoming call |
| `queue.drained` | `void` | Message queue is empty |
| `queue.dead-letter` | `{ jid, content, error }` | Message permanently failed |
| `circuit-breaker.state-change` | `{ from, to }` | Circuit breaker state changed |

## Error Handling

NexaWhats uses typed errors with recovery hints:

```typescript
import { RateLimitError, BannedError, LoggedOutError } from 'nexawhats';

try {
  await client.connect();
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(`Rate limited — retry in ${error.retryAfterMs}ms`);
  } else if (error instanceof BannedError) {
    console.log('Number is banned by WhatsApp');
  } else if (error instanceof LoggedOutError) {
    console.log('Session expired — delete auth and re-scan QR');
  }
}
```

## Comparison with Baileys

| Feature | Baileys | NexaWhats |
|---------|---------|-----------|
| Connection handling | Basic reconnect, manual 405 handling | State machine + circuit breaker |
| Auth storage | JSON files (not production-ready) | Pluggable: SQLite / Memory / File |
| Message sending | Raw `sendMessage()` | Queue with rate limiting + priority |
| LID handling | Inconsistent | Auto-resolution middleware |
| Testing | No mock server | Mock transport + fixtures |
| Types | Deep optional nesting | Discriminated unions |
| Middleware | Flat EventEmitter | Koa-style pipeline |
| Anti-ban | Nothing built-in | Human-like timing + warm-up |
| Observability | Pino logger only | Prometheus metrics + health endpoint |
| Memory | Leaks ~0.1MB/message | Bounded caches + WeakRef |
| v7 stability | Stuck in broken RCs | Stable releases |

## Troubleshooting

**405 Rate Limited**
NexaWhats handles this automatically via the circuit breaker. If persistent, try a different IP or wait 24-72 hours.

**401 Logged Out**
Delete your auth store and re-authenticate. The `LoggedOutError` is emitted on `connection.update`.

**Messages not sending**
Check `client.queueDepth` — if high, the rate limiter is throttling. Increase `messagesPerMinute` in config.

**LID JID mismatch**
Use the `lidResolver()` middleware to automatically translate LID JIDs to phone-number format.

**Memory growing**
Ensure you're not storing all messages in memory. Use the event listeners to process and discard.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Disclaimer

This project is **not** affiliated with, authorized by, or endorsed by WhatsApp LLC or Meta Platforms Inc. Using this library may violate WhatsApp's Terms of Service. See [DISCLAIMER.md](DISCLAIMER.md) for full details.

**For business-critical applications**, use the official [WhatsApp Business API](https://business.whatsapp.com/).

## License

[Apache-2.0](LICENSE) — includes explicit patent grant for protocol implementations.
