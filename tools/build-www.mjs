// Copies the web app into www/ for the native iPhone shell (Capacitor). The models stay out: the
// app analyses on the server. node tools/build-www.mjs [--token-for stanley|miska]
// --token-for puts that person's server access code into www/build-config.json, so the app on
// their own phone works without pasting it (Stanley, 2026-11-13: "daj tam ten kľúč, veď je to len
// pre nás"). Read from server/.app-tokens.txt and never printed; www/ and the copy Xcode bundles
// (ios/App/App/public) are both gitignored.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), out = join(root, 'www');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ['index.html', 'manifest.json', 'sw.js', 'css', 'js', 'vendor', 'icons']) cpSync(join(root, f), join(out, f), { recursive: true });
const who = process.argv[process.argv.indexOf('--token-for') + 1];
if (process.argv.includes('--token-for')) {
  const line = readFileSync(join(root, 'server/.app-tokens.txt'), 'utf8').split('\n').find(l => new RegExp(`^\\s*${who}:\\s*\\S+`).test(l));
  if (!line) { console.error(`No access code for "${who}" in server/.app-tokens.txt`); process.exit(1); }
  writeFileSync(join(out, 'build-config.json'), JSON.stringify({ token: line.split(':').slice(1).join(':').trim(), who }));
  console.log(`www/ ready, access code for ${who} built in`);
} else console.log('www/ ready');
