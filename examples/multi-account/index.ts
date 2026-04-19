/**
 * Multi-account example — run several WhatsApp numbers from one process.
 *
 * Each account gets its own SQLiteAuthStore (single-file per account is
 * fine; WAL keeps writes safe even under load). The clients share
 * nothing — each has its own queue, circuit breaker, and metrics.
 *
 * Run:
 *   npx tsx examples/multi-account/index.ts
 */

import { createClient, type NexaWhatsClient, SQLiteAuthStore } from 'nexawhats';

interface AccountConfig {
  label: string;
  dbPath: string;
  metricsPort: number;
}

const accounts: AccountConfig[] = [
  { label: 'support', dbPath: './auth/support.db', metricsPort: 9101 },
  { label: 'sales', dbPath: './auth/sales.db', metricsPort: 9102 },
];

async function spawnAccount(cfg: AccountConfig): Promise<NexaWhatsClient> {
  const store = new SQLiteAuthStore(cfg.dbPath);
  const state = await store.loadState();

  const client = createClient({
    auth: state ?? { creds: {}, keys: store },
    queue: { messagesPerMinute: 15, humanLikeTiming: true },
    metrics: { prometheus: true, port: cfg.metricsPort },
  });

  client.use(async (ctx, next) => {
    console.log(`[${cfg.label}] ${ctx.jid}: ${ctx.text ?? '(non-text)'}`);
    await next();
  });

  client.on('connection.update', ({ connection }) => {
    console.log(`[${cfg.label}] connection → ${connection}`);
  });

  client.on('creds.update', async () => {
    await store.saveState({ creds: client.config.auth.creds, keys: store });
  });

  await client.connect();
  return client;
}

async function main(): Promise<void> {
  const clients = await Promise.all(accounts.map(spawnAccount));
  console.log(`${clients.length} accounts online`);

  process.on('SIGINT', async () => {
    console.log('\nshutting down all accounts...');
    await Promise.all(clients.map((c) => c.disconnect()));
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
