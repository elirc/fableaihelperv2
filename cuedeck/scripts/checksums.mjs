// Writes SHA-256 checksums for every release artifact under out/make.
// Run after `npm run make`: node scripts/checksums.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('out', 'make');
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (!entry.endsWith('SHASUMS256.txt')) files.push(full);
  }
})(root);

const lines = files.map((file) => {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `${hash}  ${path.relative(root, file).replaceAll('\\', '/')}`;
});
writeFileSync(path.join(root, 'SHASUMS256.txt'), lines.join('\n') + '\n');
console.warn(`SHASUMS256.txt written with ${lines.length} artifact(s)`);
