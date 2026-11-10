// Prints the `modal secret create` commands for the access tokens and the push keys.
// Usage: node server/mint.mjs mailto:you@example.com stanley miska
import { randomBytes, createECDH } from 'node:crypto';

const [sub, ...users] = process.argv.slice(2);
if (!/^(mailto:|https:\/\/)/.test(sub ?? '') || !users.length) {
  console.error('usage: node server/mint.mjs mailto:you@example.com stanley miska');
  process.exit(1);
}
const tokens = Object.fromEntries(users.map(u => [u, randomBytes(32).toString('base64url')]));
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const pub = ecdh.getPublicKey().toString('base64url');
const priv = ecdh.getPrivateKey().toString('base64url');
console.log(`modal secret create jump-tokens JUMP_TOKENS='${JSON.stringify(tokens)}'`);
console.log(`modal secret create jump-vapid VAPID_PUBLIC='${pub}' VAPID_PRIVATE='${priv}' VAPID_SUB='${sub}'`);
console.log('\nPer person, paste into the app (stays in that phone only):');
for (const [u, t] of Object.entries(tokens)) console.log(`  ${u}: ${t}`);
