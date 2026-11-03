#!/usr/bin/env node
/**
 * Renders the trailer's frames and sound from the game itself, headless (SwiftShader draws every
 * frame; nothing is played in real time). Needs the Vite dev server (`npm run dev`) on 5173.
 *
 *   node client/tools/trailer/render.mjs --out /tmp/trailer [--shots street,stand] [--every 1] [--no-audio] [--seed 7]
 *
 * Writes frame_00000.jpg... (black frames for the title cards), manifest.json (fps, every shot's
 * frame range), audio.wav (every sound the frames made, replayed offline through the game's own
 * audio engine, in sync) and log.json (the sound log, for a look). `--every N` keeps one frame in
 * N (a quick look at the shots; the others are simulated, not drawn). Then assemble.mjs cuts the MP4.
 * A long render goes in parts (`--shots` a few at a time, each to its own folder) that join.mjs
 * puts together, so a crash costs one part.
 *
 * Frames come out of the page as raw pixels (the canvas's own JPEG encoder takes minutes a frame on
 * a software GL) and go through one ffmpeg process that writes the JPEGs.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node-tools/node_modules/playwright'));
}

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = opt('out', '/tmp/dead-hours-trailer');
const SHOTS = opt('shots', '');
const EVERY = +opt('every', '1');
const AUDIO = !args.includes('--no-audio');
const URL = opt('url', 'http://127.0.0.1:5173/');
// Drawn at 960x540 by default (a software GL is pixel-bound: 720p costs twice as long); assemble.mjs scales the cut up.
const W = +opt('width', '960'), H = +opt('height', '540');
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const ctx = await chromium.launchPersistentContext(opt('profile', join(OUT, 'profile')), {
  headless: true,
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' && !t.includes('ERR_CONNECTION_REFUSED')) || t.includes('NaN ray')) console.log('[page]', t.slice(0, 1200));
});
// Whole stacks from the page (a physics abort reports where it came from).
await page.addInitScript(() => { Error.stackTraceLimit = 100; });
const query = new URLSearchParams({ trailer: '1', holiday: opt('holiday', 'off'), seed: opt('seed', '7') });
if (SHOTS) query.set('shots', SHOTS);
await page.goto(`${URL}?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__trailer, null, { timeout: 900_000 });
console.log(`trailer ready in ${since()}`);
const plan = await page.evaluate(() => window.__trailer.begin());
console.log(`shots: ${plan.shots.join(', ')} (${plan.frames} frames)`);

/** One ffmpeg for the whole run: raw frames in, numbered JPEGs out. */
let enc = null;
let encSize = null;
const black = Buffer.alloc(W * H * 4);
const encoder = (w, h) => {
  if (enc && encSize[0] === w && encSize[1] === h) return enc;
  if (enc) throw new Error(`frame size changed from ${encSize} to ${w}x${h}`);
  encSize = [w, h];
  enc = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(plan.fps), '-i', 'pipe:0',
    '-vf', 'vflip', '-q:v', '2', '-start_number', '0', join(OUT, 'frame_%05d.jpg'),
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  return enc;
};
const feed = (buf) => new Promise((resolve, reject) => {
  const ok = enc.stdin.write(buf, (err) => (err ? reject(err) : undefined));
  if (ok) resolve();
  else enc.stdin.once('drain', resolve);
});

const manifest = { fps: plan.fps, width: W, height: H, every: EVERY, shots: [] };
let current = null;
let n = 0;
let next = 0;
for (;;) {
  const r = await page.evaluate((draw) => window.__trailer.step(draw), next % EVERY === 0);
  if (r.done) break;
  next = r.frame + 1;
  if (!current || current.name !== r.shot) {
    current = { name: r.shot, from: r.frame, to: r.frame, black: r.black };
    manifest.shots.push(current);
    console.log(`${since()} shot ${r.shot} from frame ${r.frame}`);
  }
  current.to = r.frame;
  if (r.frame % EVERY !== 0) continue;
  if (args.includes('--cast')) console.log(`  f${r.frame} ${r.cast.join(' | ')}`);
  if (r.rgba) {
    encoder(r.width, r.height);
    manifest.width = r.width;
    manifest.height = r.height;
    await feed(Buffer.from(r.rgba, 'base64'));
  } else {
    encoder(manifest.width, manifest.height);
    await feed(black.subarray(0, manifest.width * manifest.height * 4));
  }
  if (++n % 100 === 0) console.log(`${since()} ${n} frames written`);
}
manifest.frames = current ? current.to + 1 : 0;
if (enc) {
  enc.stdin.end();
  await new Promise((resolve) => enc.on('close', resolve));
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${since()} ${manifest.frames} frames in ${manifest.shots.length} shots (${n} drawn)`);

if (AUDIO) {
  const log = await page.evaluate(() => window.__trailer.log);
  writeFileSync(join(OUT, 'log.json'), JSON.stringify(log));
  console.log(`${since()} rendering sound (${log.length} frames, ${log.reduce((s, f) => s + f.calls.length, 0)} sounds)`);
  const wav = await page.evaluate(() => window.__trailer.renderAudio());
  writeFileSync(join(OUT, 'audio.wav'), Buffer.from(wav, 'base64'));
  console.log(`${since()} audio.wav written`);
}
await ctx.close();
