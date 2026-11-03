#!/usr/bin/env node
/**
 * Joins renders made in parts (render.mjs with `--shots`, each part to its own folder) into one
 * folder assemble.mjs can cut: the frames numbered on from one part to the next, the parts' sound
 * one after the other, and one manifest.
 *
 *   node client/tools/trailer/join.mjs --out /tmp/trailer --parts /tmp/trailer/a,/tmp/trailer/b,/tmp/trailer/c
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = opt('out', '/tmp/dead-hours-trailer');
const PARTS = opt('parts', '').split(',').filter(Boolean);
if (PARTS.length === 0) throw new Error('--parts a,b,c: the folders render.mjs wrote, in order');
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^frame_\d+\.jpg$/.test(f)) unlinkSync(join(OUT, f));

const manifest = { fps: 0, width: 0, height: 0, every: 1, shots: [], frames: 0 };
const wavs = [];
const log = [];
for (const dir of PARTS) {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (m.every !== 1) throw new Error(`${dir}: rendered with --every ${m.every}; only whole renders join`);
  if (!manifest.fps) Object.assign(manifest, { fps: m.fps, width: m.width, height: m.height });
  else if (m.fps !== manifest.fps || m.width !== manifest.width || m.height !== manifest.height) {
    throw new Error(`${dir}: ${m.width}x${m.height} at ${m.fps} fps, the first part is ${manifest.width}x${manifest.height} at ${manifest.fps}`);
  }
  const offset = manifest.frames;
  for (let i = 0; i < m.frames; i++) {
    const src = join(dir, `frame_${String(i).padStart(5, '0')}.jpg`);
    if (!existsSync(src)) throw new Error(`${src} is missing`);
    const dst = join(OUT, `frame_${String(offset + i).padStart(5, '0')}.jpg`);
    try {
      linkSync(src, dst);
    } catch {
      copyFileSync(src, dst);
    }
  }
  for (const s of m.shots) manifest.shots.push({ ...s, from: s.from + offset, to: s.to + offset });
  manifest.frames += m.frames;
  if (existsSync(join(dir, 'audio.wav'))) wavs.push(join(dir, 'audio.wav'));
  if (existsSync(join(dir, 'log.json'))) log.push(...JSON.parse(readFileSync(join(dir, 'log.json'), 'utf8')));
  console.log(`${dir}: ${m.frames} frames, ${m.shots.map((s) => s.name).join(', ')}`);
}
if (wavs.length && wavs.length !== PARTS.length) throw new Error('some parts have no audio.wav (rendered with --no-audio?)');
if (wavs.length) {
  const inputs = wavs.flatMap((w) => ['-i', w]);
  const chain = wavs.map((_, i) => `[${i}:a]`).join('');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${chain}concat=n=${wavs.length}:v=0:a=1[a]`, '-map', '[a]', join(OUT, 'audio.wav')], { stdio: 'inherit' });
}
if (log.length) writeFileSync(join(OUT, 'log.json'), JSON.stringify(log));
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${manifest.frames} frames in ${manifest.shots.length} shots (${(manifest.frames / manifest.fps).toFixed(1)} s) in ${OUT}`);
