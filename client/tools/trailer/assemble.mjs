#!/usr/bin/env node
/**
 * Cuts the trailer from render.mjs's output: title cards over the shots (card.html, drawn with the
 * game's typefaces), the score (score.py) under the game's own sound, fades, and an H.264 MP4.
 *
 *   node client/tools/trailer/assemble.mjs --out /tmp/dead-hours-trailer [--url play.example.com] [--name dead-hours-trailer.mp4] [--crf 21]
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node-tools/node_modules/playwright'));
}
const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = opt('out', '/tmp/dead-hours-trailer');
const NAME = opt('name', 'dead-hours-trailer.mp4');
const PLAY_URL = opt('url', '');
/** The video's size; frames drawn smaller are scaled up (card.html is laid out for 1280x720). */
const [OUT_W, OUT_H] = opt('size', '1280x720').split('x').map(Number);
/** H.264 quality: 21 keeps the fog and grain (about 7 Mbit/s); 18 is visually lossless at twice the size. */
const CRF = opt('crf', '21');
const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
const fps = manifest.fps / manifest.every;
const total = manifest.frames / manifest.fps;
const shot = (name) => manifest.shots.find((s) => s.name === name);
const span = (name) => {
  const s = shot(name);
  return s ? [s.from / manifest.fps, (s.to + 1) / manifest.fps] : null;
};

/** What goes over which shot: the line, a sub line, and when (seconds into the shot). */
const CARDS = [
  { shot: 'street', kind: 'open', title: 'VESPER, OHIO. AFTER DARK', at: 1.6, dur: 3.6 },
  { shot: 'stand', kind: 'feature', title: 'CO-OP ZOMBIE SURVIVAL', sub: 'IN YOUR BROWSER', at: 0.8, dur: 4.4 },
  { shot: 'windows', kind: 'feature', title: 'BOARD UP THE HOUSES', at: 0.8, dur: 4.2 },
  { shot: 'fire', kind: 'feature', title: 'MOLOTOVS · GRENADES · MELEE', at: 1.4, dur: 3.8 },
  { shot: 'drive', kind: 'feature', title: 'DRIVE · RIDE · RUN', at: 1.0, dur: 4.0 },
  { shot: 'drop', kind: 'feature', title: 'CALL IN SUPPLY DROPS', at: 1.2, dur: 4.2 },
  { shot: 'raid', kind: 'feature', title: 'SURVIVE THE 7:00 RAID', at: 1.4, dur: 4.4 },
  { shot: 'horde', kind: 'feature', title: 'THE HORDES GROW ALL NIGHT', at: 0.9, dur: 4.2 },
  { shot: 'revive', kind: 'feature', title: 'PICK EACH OTHER UP', at: 0.7, dur: 3.6 },
  { shot: 'walk', kind: 'feature', title: 'UP TO FOUR SURVIVORS', sub: 'SOLO · OR ONLINE WITH FRIENDS', at: 0.8, dur: 4.4 },
  { shot: 'title', kind: 'title', title: 'DEAD HOURS', sub: "SURVIVE UNTIL YOU CAN'T.", at: 0.1, dur: 5.2 },
  { shot: 'title', kind: 'cta', title: 'PLAY FREE IN YOUR BROWSER', sub: 'NO DOWNLOAD · NO INSTALL', url: PLAY_URL, at: 5.4, dur: 3.6 },
];

// The cards, drawn.
const cards = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: OUT_W, height: OUT_H }, deviceScaleFactor: 1 });
for (const c of CARDS) {
  const sp = span(c.shot);
  if (!sp) continue;
  const q = new URLSearchParams({ kind: c.kind, title: c.title, sub: c.sub ?? '', url: c.url ?? '' });
  await page.goto(`file://${join(HERE, 'card.html')}?${q}`);
  await page.waitForFunction(() => window.__cardReady === true);
  const file = join(OUT, `card_${cards.length}.png`);
  await page.screenshot({ path: file, omitBackground: c.kind === 'feature' || c.kind === 'open', type: 'png' });
  const at = sp[0] + c.at;
  const end = Math.min(sp[1] - 0.2, at + c.dur);
  cards.push({ ...c, file, at, end, opaque: !(c.kind === 'feature' || c.kind === 'open') });
}
await browser.close();
writeFileSync(join(OUT, 'cards.json'), JSON.stringify(cards, null, 2));
console.log(`${cards.length} cards drawn`);

// The score, to the cut.
execFileSync('python3', ['-I', join(HERE, 'score.py'), OUT], { stdio: 'inherit' });

// The cut.
const inputs = ['-framerate', String(fps), '-i', join(OUT, 'frame_%05d.jpg')];
const filters = [];
let v = '[0:v]';
const scaled = manifest.width !== OUT_W || manifest.height !== OUT_H ? `scale=${OUT_W}:${OUT_H}:flags=lanczos,` : '';
filters.push(`${v}fps=${manifest.fps},${scaled}format=yuv420p,setsar=1[v0]`);
v = '[v0]';
cards.forEach((c, i) => {
  inputs.push('-loop', '1', '-framerate', String(manifest.fps), '-t', String(total), '-i', c.file);
  const k = i + 1;
  const fi = c.kind === 'title' ? 0.9 : 0.45, fo = c.kind === 'cta' ? 0.9 : 0.4;
  filters.push(`[${k}:v]format=rgba,fade=t=in:st=${c.at.toFixed(3)}:d=${fi}:alpha=1,fade=t=out:st=${(c.end - fo).toFixed(3)}:d=${fo}:alpha=1[c${k}]`);
  filters.push(`${v}[c${k}]overlay=eof_action=pass:enable='between(t,${c.at.toFixed(3)},${c.end.toFixed(3)})'[v${k}]`);
  v = `[v${k}]`;
});
filters.push(`${v}fade=t=in:st=0:d=1.4,fade=t=out:st=${(total - 0.8).toFixed(3)}:d=0.8[vout]`);
const audioIn = inputs.length / 2;
const hasGame = existsSync(join(OUT, 'audio.wav'));
const hasScore = existsSync(join(OUT, 'score.wav'));
const aInputs = [];
if (hasGame) aInputs.push(join(OUT, 'audio.wav'));
if (hasScore) aInputs.push(join(OUT, 'score.wav'));
const aIdx = cards.length + 1;
for (const a of aInputs) inputs.push('-i', a);
void audioIn;
let aout = null;
if (aInputs.length === 2) {
  filters.push(`[${aIdx}:a]volume=1.0[ga];[${aIdx + 1}:a]volume=1.0[sc];[ga][sc]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97:attack=3:release=60,loudnorm=I=-15:TP=-1.5:LRA=13,afade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[aout]`);
  aout = '[aout]';
} else if (aInputs.length === 1) {
  filters.push(`[${aIdx}:a]alimiter=limit=0.97,loudnorm=I=-15:TP=-1.5:LRA=13,afade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[aout]`);
  aout = '[aout]';
}
const file = join(OUT, NAME);
const cmd = [
  '-y', '-loglevel', 'error', '-stats', ...inputs,
  '-filter_complex', filters.join(';'),
  '-map', '[vout]', ...(aout ? ['-map', aout] : []),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-pix_fmt', 'yuv420p', '-r', String(manifest.fps),
  ...(aout ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),
  '-movflags', '+faststart', '-t', String(total), file,
];
console.log('ffmpeg', cmd.slice(0, 2).join(' '), '...');
execFileSync('ffmpeg', cmd, { stdio: 'inherit' });
console.log(`wrote ${file}`);
