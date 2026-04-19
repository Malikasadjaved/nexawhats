# NexaWhats Examples

Runnable examples for the public API. Each sub-directory is a standalone
`tsx` entry point — no build step required.

| Example | What it shows |
|---------|----------------|
| [`basic-bot/`](./basic-bot/index.ts) | Minimal client — FileAuthStore + middleware + echo handler + `/health` endpoint |
| [`multi-account/`](./multi-account/index.ts) | Run multiple WhatsApp numbers from one process using SQLiteAuthStore |
| [`media-download/`](./media-download/index.ts) | Detect media in incoming messages (download arrives in 0.2.0) |
| [`group-management/`](./group-management/index.ts) | Listen to group events and participant updates |

## Running

```bash
# from the repo root
npm install
npx tsx examples/basic-bot/index.ts
```

On first run you'll see a QR code in the terminal — scan it from
WhatsApp → **Linked Devices**. Auth is persisted under `./auth/` so
subsequent runs skip the QR step.

## v0.1.0 scope

These examples exercise everything that ships in 0.1.0:

- Pluggable auth stores (File, SQLite, Memory)
- Connection state machine + circuit breaker
- Middleware pipeline with built-in `lidResolver`, `antiBan`, `messageLogger`
- Token-bucket rate-limited send queue
- Prometheus metrics + `/health` endpoint

Message encrypt/decrypt, group operations, and media download land in
0.2.0. The calls to `client.send(...)` in the examples will throw
`NotImplementedError` against a live server until that release —
they're wired up now so your application code doesn't need to change
when 0.2.0 drops.

## Security

Never commit the `./auth/` directory. Each example's auth dir is
ignored in `.gitignore`.
