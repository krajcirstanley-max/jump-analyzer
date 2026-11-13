// Copies the web app into www/ for the native iPhone shell (Capacitor). The models stay out: the
// app analyses on the server. node tools/build-www.mjs
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), out = join(root, 'www');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ['index.html', 'manifest.json', 'sw.js', 'css', 'js', 'vendor', 'icons']) cpSync(join(root, f), join(out, f), { recursive: true });
console.log('www/ ready');
