// Compresses the PBR source sets in client/tools/textures/src into KTX2 (Basis ETC1S) tiers the
// game streams by texture quality, and writes client/public/textures/world/manifest.json.
//   node client/tools/textures/encode.mjs            (uses `npx basisu@1.16.3`, or $BASISU)
// Tiers: high = color/normal 1024 + orm 512, medium (and the Phone preset) = 512 + 256, low = color 256 only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, 'src');
const OUT = path.resolve(HERE, '../../public/textures/world');
const BASISU = process.env.BASISU || null;

/** What each tier file is made from: [map, size, args]. */
const FILES = [
  ['color', 1024], ['color', 512], ['color', 256],
  ['normal', 1024], ['normal', 512],
  ['orm', 512], ['orm', 256],
];
const ARGS = {
  color: ['-q', '160'],
  normal: ['-normal_map', '-q', '255'],
  orm: ['-linear', '-q', '200'],
};

function basisu(args) {
  if (BASISU) execFileSync(BASISU, args, { stdio: 'pipe' });
  else execFileSync('npx', ['--yes', 'basisu@1.16.3', ...args], { stdio: 'pipe' });
}

const sourcesFile = path.join(SRC, 'sources.json');
const sources = fs.existsSync(sourcesFile) ? JSON.parse(fs.readFileSync(sourcesFile, 'utf8')) : {};
const keys = fs.readdirSync(SRC).filter((k) => fs.statSync(path.join(SRC, k)).isDirectory()).sort();
fs.mkdirSync(OUT, { recursive: true });
const manifest = { version: Date.now(), tiers: { high: { color: 1024, normal: 1024, orm: 512 }, medium: { color: 512, normal: 512, orm: 256 }, low: { color: 256 } }, sets: {} };
for (const key of keys) {
  const dir = path.join(SRC, key);
  const pick = (map) => ['png', 'jpg'].map((e) => path.join(dir, `${map}.${e}`)).find((f) => fs.existsSync(f));
  const outDir = path.join(OUT, key);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [map, size] of FILES) {
    const input = pick(map);
    if (!input) throw new Error(`${key}: missing ${map}.png/.jpg`);
    const output = path.join(outDir, `${map}_${size}.ktx2`);
    basisu(['-ktx2', '-mipmap', '-comp_level', '2', ...ARGS[map], '-resample', String(size), String(size), '-file', input, '-output_file', output]);
  }
  const src = sources[key] ?? { from: 'generated' };
  manifest.sets[key] = { from: src.from, colored: !!src.colored };
  console.log(key, src.from);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
let bytes = 0;
for (const k of keys) for (const f of fs.readdirSync(path.join(OUT, k))) bytes += fs.statSync(path.join(OUT, k, f)).size;
console.log(`wrote ${keys.length} sets, ${(bytes / 1048576).toFixed(1)} MB`);
