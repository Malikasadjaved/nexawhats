// Generate Noise handler fixtures from Baileys so nexawhats' port can
// replay them byte-identically.
//
// Run from `D:/nexawhats`:
//   NODE_PATH="D:/Digital Fte/body/my-bot/node_modules" \
//     npx tsx scripts/generate-noise-fixtures.mjs
//
// Output: tests/fixtures/noise/basic.json
//
// Not shipped in the npm package — just a maintainer tool.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

// Load Baileys via NODE_PATH.
const baileys = req('@whiskeysockets/baileys');

const { makeNoiseHandler } = baileys;
const { Curve } = req('@whiskeysockets/baileys/lib/Utils/crypto.js');
const { NOISE_WA_HEADER } = req('@whiskeysockets/baileys/lib/Defaults/index.js');

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

// Deterministic "random" keypair — inject bytes derived from a fixed seed.
// We use `Curve.generateKeyPair()` since its inner libsignal call pulls
// from Node's PRNG; there's no seeded variant. To keep the fixture
// deterministic, generate ONCE and bake the bytes into the fixture.
const keyPair = Curve.generateKeyPair();

const handler = makeNoiseHandler({
  keyPair,
  NOISE_HEADER: NOISE_WA_HEADER,
  logger: silentLogger,
});

// Drive a handshake-like sequence WITHOUT real server bytes:
// 1. authenticate some fixed bytes
// 2. mixIntoKey with a fixed 32-byte secret
// 3. encode a frame before handshake-finish (plaintext framing)
// 4. finishInit
// 5. encrypt + encode a frame after handshake-finish
//
// For each step we record inputs and outputs; the test feeds the same
// inputs into our port and asserts byte-identical outputs.
const fixture = {
  keyPair: {
    private: keyPair.private.toString('hex'),
    public: keyPair.public.toString('hex'),
  },
  steps: [],
};

// Step A: authenticate a constant blob (hash-chain update).
const blob1 = Buffer.from('nexawhats-fixture-blob-1');
handler.authenticate(blob1);
fixture.steps.push({ op: 'authenticate', data: blob1.toString('hex') });

// Step B: mixIntoKey.
const dh1 = Buffer.alloc(32, 0x11);
await handler.mixIntoKey(dh1);
fixture.steps.push({ op: 'mixIntoKey', data: dh1.toString('hex') });

// Step C: encrypt a known plaintext (pre-finishInit AES-GCM).
const plain1 = Buffer.from('hello from nexawhats');
const ct1 = handler.encrypt(plain1);
fixture.steps.push({
  op: 'encrypt',
  plaintext: plain1.toString('hex'),
  ciphertext: ct1.toString('hex'),
});

// Step D: encode a pre-handshake frame (includes NOISE_HEADER on first call).
const framed1 = handler.encodeFrame(Buffer.from('preframe'));
fixture.steps.push({
  op: 'encodeFrame',
  data: Buffer.from('preframe').toString('hex'),
  frame: framed1.toString('hex'),
});

// Step E: encode a second pre-handshake frame (sentIntro flag suppresses header).
const framed2 = handler.encodeFrame(Buffer.from('preframe2'));
fixture.steps.push({
  op: 'encodeFrame',
  data: Buffer.from('preframe2').toString('hex'),
  frame: framed2.toString('hex'),
});

// Step F: finishInit.
await handler.finishInit();
fixture.steps.push({ op: 'finishInit' });

// Step G: encode a post-handshake frame (payload is encrypted first).
const framed3 = handler.encodeFrame(Buffer.from('postframe'));
fixture.steps.push({
  op: 'encodeFrame',
  data: Buffer.from('postframe').toString('hex'),
  frame: framed3.toString('hex'),
});

// Step H: encode another post-handshake frame.
const framed4 = handler.encodeFrame(Buffer.from('postframe2'));
fixture.steps.push({
  op: 'encodeFrame',
  data: Buffer.from('postframe2').toString('hex'),
  frame: framed4.toString('hex'),
});

const outDir = resolve(__dirname, '../tests/fixtures/noise');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'basic.json');
writeFileSync(outFile, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${fixture.steps.length} steps -> ${outFile}`);
