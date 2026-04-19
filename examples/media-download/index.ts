/**
 * Media-download example — detect media in incoming messages.
 *
 * v0.1.0 status: the middleware pipeline delivers decoded messages, and
 * helper functions let you detect which media type is attached. Actual
 * binary download (resolving the media key and fetching from WhatsApp's
 * CDN) is part of 0.2.0. Until then this example demonstrates the
 * detection path so your pipeline is ready the moment the download API
 * lands.
 *
 * Run:
 *   npx tsx examples/media-download/index.ts
 */

import {
  createClient,
  FileAuthStore,
  getMediaType,
  hasMedia,
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
    if (hasMedia(ctx.message)) {
      const type = getMediaType(ctx.message);
      console.log(`[media] ${ctx.jid} sent ${type}`);
      // When 0.2.0 lands:
      //   const buffer = await client.downloadMedia(ctx.message);
      //   await writeFile(`./downloads/${ctx.message.key.id}.${type}`, buffer);
    }
    await next();
  });

  client.on('creds.update', async () => {
    await store.saveState({ creds: client.config.auth.creds, keys: store });
  });

  await client.connect();
  console.log('media listener up');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
