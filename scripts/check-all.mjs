// Runs every `check:*` script in package.json one after another and lists what passed.
// Exits 1 if any failed. `npm run check` calls it; CI runs it too.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const scripts = Object.keys(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).scripts)
  .filter((k) => k.startsWith('check:'));
const failed = [];
for (const name of scripts) {
  const start = Date.now();
  const r = spawnSync('npm', ['run', '-s', name], { stdio: process.env.CI ? 'inherit' : ['ignore', 'ignore', 'inherit'] });
  const ok = r.status === 0;
  if (!ok) failed.push(name);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}  ${((Date.now() - start) / 1000).toFixed(0)} s`);
}
console.log(failed.length ? `${failed.length} of ${scripts.length} failed: ${failed.join(', ')}` : `all ${scripts.length} checks passed`);
process.exit(failed.length ? 1 : 0);
