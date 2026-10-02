import { build } from 'esbuild';
import fs from 'fs';
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
await build({ entryPoints: ['src/content.js'], bundle: true, format: 'iife', target: 'firefox109', outfile: `${out}/content.js`, minify: true, legalComments: 'none' });
for (const f of ['page.js', 'background.js']) fs.copyFileSync(`src/${f}`, `${out}/${f}`);
for (const f of fs.readdirSync('static')) fs.copyFileSync(`static/${f}`, `${out}/${f}`);
console.log(fs.readdirSync(out).map(f => `${f} ${fs.statSync(`${out}/${f}`).size}`).join('\n'));
