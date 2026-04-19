// Manual smoke check for the WAProto bridge.
// Not part of CI — run with:
//   NODE_PATH="D:/Digital Fte/body/my-bot/node_modules" npx tsx scripts/proto-smoke.mjs
import { isProtoAvailable, loadProto, proto } from '../src/proto/index.ts';

console.log('available:', isProtoAvailable());
if (isProtoAvailable()) {
  const ns = loadProto();
  console.log('keys sample:', Object.keys(ns).slice(0, 8));
  console.log('Message class:', typeof proto.Message);
  console.log('WebMessageInfo class:', typeof proto.WebMessageInfo);
}
