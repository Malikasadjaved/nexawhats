/**
 * Group-management example — observe group events.
 *
 * Demonstrates hooking into the typed event map for groups. Actual
 * group operations (create, add/remove participant, promote) are part
 * of the Track B deliverable for 0.2.0; this example listens for events
 * that the live socket layer will emit once Phase 6 completes.
 *
 * Run:
 *   npx tsx examples/group-management/index.ts
 */

import {
  createClient,
  FileAuthStore,
  isGroupMessage,
  messageLogger,
} from 'nexawhats';

async function main(): Promise<void> {
  const store = new FileAuthStore('./auth');
  const state = await store.loadState();

  const client = createClient({
    auth: state ?? { creds: {}, keys: store },
  });

  client.use(messageLogger());

  client.use(async (ctx, next) => {
    if (isGroupMessage(ctx.message)) {
      console.log(`[group ${ctx.jid}] ${ctx.senderName}: ${ctx.text ?? ''}`);
    }
    await next();
  });

  client.on('groups.upsert', (groups) => {
    for (const g of groups) {
      console.log(`[groups.upsert] joined ${g.id} — ${g.subject}`);
    }
  });

  client.on('group-participants.update', ({ id, participants, action }) => {
    console.log(`[group-participants] ${id} ${action}: ${participants.join(', ')}`);
  });

  client.on('creds.update', async () => {
    await store.saveState({ creds: client.config.auth.creds, keys: store });
  });

  await client.connect();
  console.log('group listener up');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
