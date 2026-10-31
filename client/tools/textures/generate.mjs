// Authors tileable PBR source sets (color, normal, orm) for Dead Hours' world materials.
// node client/tools/textures/generate.mjs [OUT_DIR] [size] [only,keys]   (default OUT_DIR: client/tools/textures/src)
// Every map tiles seamlessly: all noise is periodic over the tile. Color maps are detail maps
// (multiplied by the material's tint in the game), so their mean brightness is normalized per material.
// Image rows run bottom to top in UV space (KTX2 textures are not flipped), so row+1 is +v.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), "src");
const N = Number(process.argv[3] ?? 1024);
const ONLY = process.argv[4] ? new Set(process.argv[4].split(',')) : null;

// ---------- PNG writer ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(file, w, h, rgb) {
  // Row 0 of `rgb` is v = 0 (bottom); PNG row 0 is the top of the image file. basisu keeps file
  // order, and three's KTX2 textures are not flipped, so file row 0 lands at v = 0: write as-is.
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rgb[y * w * 3 + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---------- periodic noise ----------
function hash2(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** Value noise with period p cells over the unit tile, at (u, v) in [0,1). */
function vnoise(u, v, p, s) {
  const x = u * p, y = v * p;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = fade(x - xi), fy = fade(y - yi);
  const m = (a) => ((a % p) + p) % p;
  const a = hash2(m(xi), m(yi), s), b = hash2(m(xi + 1), m(yi), s);
  const c = hash2(m(xi), m(yi + 1), s), d = hash2(m(xi + 1), m(yi + 1), s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** Anisotropic periodic value noise: px cells across u, py along v. */
function vnoise2(u, v, px, py, s) {
  const x = u * px, y = v * py;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = fade(x - xi), fy = fade(y - yi);
  const mx = (a) => ((a % px) + px) % px, my = (a) => ((a % py) + py) % py;
  const a = hash2(mx(xi), my(yi), s), b = hash2(mx(xi + 1), my(yi), s);
  const c = hash2(mx(xi), my(yi + 1), s), d = hash2(mx(xi + 1), my(yi + 1), s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(u, v, p, oct, s, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < oct; o++) { sum += vnoise(u, v, p << o, s + o * 17) * amp; norm += amp; amp *= gain; }
  return sum / norm;
}
function fbm2(u, v, px, py, oct, s, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < oct; o++) { sum += vnoise2(u, v, px << o, py << o, s + o * 17) * amp; norm += amp; amp *= gain; }
  return sum / norm;
}
/** Ridged fbm: thin bright lines where noise crosses 0.5 (cracks, veins). */
function ridge(u, v, p, oct, s) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < oct; o++) { sum += (1 - Math.abs(vnoise(u, v, p << o, s + o * 31) * 2 - 1)) * amp; norm += amp; amp *= 0.5; }
  return sum / norm;
}
/** Periodic Worley noise over k x k cells: nearest and second distances (in cell units) and the cell id. */
function worley(u, v, k, s, jitter = 1) {
  const x = u * k, y = v * k;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j;
    const mx = ((cx % k) + k) % k, my = ((cy % k) + k) % k;
    const px = cx + 0.5 + (hash2(mx, my, s) - 0.5) * jitter, py = cy + 0.5 + (hash2(mx, my, s + 1) - 0.5) * jitter;
    const d = Math.hypot(px - x, py - y);
    if (d < f1) { f2 = f1; f1 = d; id = mx * 7919 + my; } else if (d < f2) f2 = d;
  }
  return { f1, f2, id };
}
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const rnd = (id, s) => hash2(id, s, 99);

// ---------- map assembly ----------
/** Runs `fn(u, v, x, y)` per pixel; it returns [r, g, b, height, rough, metal, ao]. */
function render(fn) {
  const col = new Float32Array(N * N * 3), hgt = new Float32Array(N * N), rough = new Float32Array(N * N);
  const metal = new Float32Array(N * N), ao = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const o = fn((x + 0.5) / N, (y + 0.5) / N, x, y);
    col[i * 3] = o[0]; col[i * 3 + 1] = o[1]; col[i * 3 + 2] = o[2];
    hgt[i] = o[3]; rough[i] = o[4]; metal[i] = o[5] ?? 0; ao[i] = o[6] ?? 1;
  }
  return { col, hgt, rough, metal, ao };
}

/** Normal (OpenGL, +Y = +v) from height in meters over a tile `tileM` meters wide; plus cavity AO. */
function finish(key, m, opts) {
  const { tileM, depth, mean, aoK = 1 } = opts;
  const px = tileM / N;
  const H = (x, y) => m.hgt[((y + N) % N) * N + ((x + N) % N)] * depth;
  const nrm = Buffer.alloc(N * N * 3), orm = Buffer.alloc(N * N * 3), rgb = Buffer.alloc(N * N * 3);
  // Cavity: height below a 9 px box blur darkens (wrap-around).
  const blur = new Float32Array(N * N);
  const R = Math.max(2, Math.round(N / 110));
  const tmp = new Float32Array(N * N);
  for (let y = 0; y < N; y++) { let s = 0; for (let k = -R; k <= R; k++) s += m.hgt[y * N + ((k + N) % N)]; for (let x = 0; x < N; x++) { tmp[y * N + x] = s / (2 * R + 1); s += m.hgt[y * N + ((x + R + 1) % N)] - m.hgt[y * N + ((x - R + N) % N)]; } }
  for (let x = 0; x < N; x++) { let s = 0; for (let k = -R; k <= R; k++) s += tmp[((k + N) % N) * N + x]; for (let y = 0; y < N; y++) { blur[y * N + x] = s / (2 * R + 1); s += tmp[((y + R + 1) % N) * N + x] - tmp[((y - R + N) % N) * N + x]; } }
  // Normalize color mean (sRGB luminance) to the old canvas texture's level.
  let lum = 0;
  for (let i = 0; i < N * N; i++) lum += 0.2126 * m.col[i * 3] + 0.7152 * m.col[i * 3 + 1] + 0.0722 * m.col[i * 3 + 2];
  const k = mean / (lum / (N * N));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const dx = (H(x + 1, y) - H(x - 1, y)) / (2 * px);
    const dy = (H(x, y + 1) - H(x, y - 1)) / (2 * px);
    const l = Math.hypot(dx, dy, 1);
    nrm[i * 3] = Math.round((-dx / l * 0.5 + 0.5) * 255);
    nrm[i * 3 + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
    nrm[i * 3 + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
    const cav = clamp(1 - Math.max(0, blur[i] - m.hgt[i]) * 2.2 * aoK);
    const a = clamp(m.ao[i] * cav);
    orm[i * 3] = Math.round(a * 255);
    orm[i * 3 + 1] = Math.round(clamp(m.rough[i], 0.04, 1) * 255);
    orm[i * 3 + 2] = Math.round(clamp(m.metal[i]) * 255);
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(clamp(m.col[i * 3 + c] * k * mix(1, a, 0.35)) * 255);
  }
  const dir = path.join(OUT, key);
  fs.mkdirSync(dir, { recursive: true });
  writePng(path.join(dir, 'color.png'), N, N, rgb);
  writePng(path.join(dir, 'normal.png'), N, N, nrm);
  writePng(path.join(dir, 'orm.png'), N, N, orm);
  console.log(key, 'done');
}

/** Gray with a hue nudge: h in [-1, 1] warms (+) or cools (-). */
const tone = (g, warm = 0, green = 0) => [g * (1 + warm * 0.08 - green * 0.03), g * (1 + green * 0.08), g * (1 - warm * 0.08 - green * 0.04)];

const RECIPES = {
  brick: () => {
    const rows = 32, perRow = 11, mortar = 0.12;
    return finish('brick', render((u, v) => {
      const ry = v * rows, row = Math.floor(ry), fy = ry - row;
      const off = (row % 2) * 0.5;
      const rx = (u * perRow + off) % perRow, col = Math.floor(rx), fx = rx - col;
      const id = row * 131 + col;
      // Mortar joints (in brick-relative units), slightly irregular.
      const jx = Math.min(fx, 1 - fx) * (1 / perRow) * rows, jy = Math.min(fy, 1 - fy);
      const wob = (vnoise(u, v, 64, 5) - 0.5) * 0.05;
      const edge = Math.min(jx * 0.36, jy) + wob;
      const isBrick = smooth(mortar * 0.5, mortar * 0.5 + 0.06, edge);
      const chip = smooth(0.62, 0.72, fbm(u, v, 48, 3, 9)) * (1 - smooth(0.05, 0.2, edge));
      const t = 0.72 + (rnd(id, 1) - 0.5) * 0.35, warm = 0.4 + rnd(id, 2) * 1.2;
      const burnt = rnd(id, 3) > 0.9 ? 0.6 : 1;
      const grain = fbm(u, v, 96, 4, 11);
      const pits = smooth(0.8, 0.9, 1 - worley(u, v, 180, 13).f1) * 0.5;
      const b = tone(t * burnt * (0.85 + grain * 0.3) * (1 - pits * 0.3), warm);
      const mg = 0.95 + fbm(u, v, 128, 3, 21) * 0.15;
      const mo = [mg * 1.0, mg * 0.98, mg * 0.93];
      const s = isBrick * (1 - chip * 0.8);
      const soot = 0.85 + fbm(u, v, 4, 4, 33) * 0.3;
      const hgt = s * (0.75 + grain * 0.25 - pits * 0.3) + (1 - s) * (0.1 + fbm(u, v, 128, 2, 21) * 0.1);
      return [mix(mo[0], b[0], s) * soot, mix(mo[1], b[1], s) * soot, mix(mo[2], b[2], s) * soot, hgt,
        mix(0.95, 0.8 + grain * 0.12, s), 0, mix(0.7, 1, s)];
    }), { tileM: 2.4, depth: 0.012, mean: 0.72 });
  },
  siding: () => {
    const boards = 10;
    return finish('siding', render((u, v) => {
      const by = v * boards, bi = Math.floor(by), f = by - bi; // f = 0 at the board's bottom lip
      const grain = fbm2(u, v, 4, 160, 4, 41);
      const lap = 1 - f * 0.75;
      const lip = smooth(0, 0.04, f);
      const peel = smooth(0.66, 0.7, fbm(u, v, 12, 5, 43)) * smooth(0.55, 0.7, fbm(u, v, 40, 3, 44));
      const dirt = fbm(u, v, 6, 4, 45);
      const drip = smooth(0.7, 1, vnoise2(u, v, 60, 2, 46)) * 0.06;
      const g = (0.86 + grain * 0.08 + (dirt - 0.5) * 0.14 - drip) * mix(1, 0.62, peel);
      // Shadow under the lip of the board above (top of this board).
      const shade = 1 - smooth(0.82, 1, f) * 0.45;
      const hgt = lap * lip - peel * 0.08 + grain * 0.02;
      const c = tone(g, peel * 1.5);
      return [c[0], c[1], c[2], hgt, mix(0.62 + dirt * 0.12, 0.9, peel), 0, shade];
    }), { tileM: 2, depth: 0.018, mean: 0.82 });
  },
  plaster: () => finish('plaster', render((u, v) => {
    const big = fbm(u, v, 3, 5, 51), fine = fbm(u, v, 160, 3, 52);
    const trowel = fbm2(u, v, 18, 6, 3, 53);
    const crack = smooth(0.965, 0.99, ridge(u, v, 3, 5, 54)) * smooth(0.6, 0.7, fbm(u, v, 4, 3, 55));
    const scuff = smooth(0.74, 0.86, fbm(u, v, 6, 5, 56)) * 0.05;
    const g = 0.9 + (big - 0.5) * 0.1 + (fine - 0.5) * 0.03 - crack * 0.25 - scuff;
    return [g, g * 0.995, g * 0.975, fine * 0.4 + trowel * 0.6 - crack, 0.86 + fine * 0.08, 0];
  }), { tileM: 3, depth: 0.004, mean: 0.81 }),
  wood: () => {
    const planks = 18;
    return finish('wood', render((u, v) => {
      const px = u * planks, pi = Math.floor(px), fx = px - pi;
      // Board ends: each plank has two joints at random heights.
      const j0 = rnd(pi, 4), j1 = (j0 + 0.35 + rnd(pi, 5) * 0.3) % 1;
      const seg = (v - j0 + 1) % 1 < (j1 - j0 + 1) % 1 ? 0 : 1;
      const id = pi * 13 + seg;
      const dj = Math.min(Math.abs(v - j0), Math.abs(v - j0 - 1), Math.abs(v - j0 + 1), Math.abs(v - j1), Math.abs(v - j1 - 1), Math.abs(v - j1 + 1)) * planks * 4;
      const gap = Math.min(smooth(0, 0.035, Math.min(fx, 1 - fx)), smooth(0, 0.03, dj));
      const ring = Math.sin((fbm2(u + rnd(id, 6), v, 6, 2, 3, 61 + seg) * 18 + fx * 3) * Math.PI * 2) * 0.5 + 0.5;
      const streak = fbm2(u, v, planks * 8, 6, 4, 62);
      const t = 0.66 + (rnd(id, 7) - 0.5) * 0.18;
      const g = t * (0.86 + ring * 0.1 + streak * 0.12);
      const scratch = smooth(0.985, 1, ridge(u * 3, v * 0.7, 9, 2, 63)) * 0.25;
      const wear = fbm(u, v, 8, 4, 64);
      const c = tone(g * (1 - scratch * 0.3), 0.6 + (rnd(id, 8) - 0.5));
      return [c[0], c[1], c[2], gap * (0.9 + ring * 0.05) - scratch * 0.05, mix(0.92, 0.42 + wear * 0.2 + scratch, gap), 0, mix(0.55, 1, gap)];
    }), { tileM: 2.5, depth: 0.004, mean: 0.7 });
  },
  tile: () => finish('tile', render((u, v) => {
    const n = 4, tx = u * n, ty = v * n, ix = Math.floor(tx), iy = Math.floor(ty);
    const fx = tx - ix, fy = ty - iy, e = Math.min(fx, 1 - fx, fy, 1 - fy);
    const id = ix * 7 + iy * 3;
    const t = ((ix + iy) % 2 ? 0.92 : 0.8) + (rnd(id, 1) - 0.5) * 0.04;
    const tileMask = smooth(0.01, 0.03, e);
    const speck = smooth(0.82, 0.9, vnoise(u, v, 300, 71)) * 0.1;
    const grime = fbm(u, v, 6, 4, 72);
    const crack = smooth(0.975, 0.995, ridge(u, v, 4, 4, 73)) * (rnd(id, 2) > 0.75 ? 1 : 0);
    const g = mix(0.5 + grime * 0.12, t * (0.95 + grime * 0.08) - speck - crack * 0.3, tileMask);
    return [g, g * 0.99, g * 0.96, tileMask * (1 - smooth(0.03, 0.06, e) * 0) * 0.9 + smooth(0.03, 0.08, e) * 0.1 - crack * 0.2,
      mix(0.9, 0.22 + grime * 0.25 + crack * 0.5, tileMask), 0, mix(0.6, 1, tileMask)];
  }), { tileM: 1.2, depth: 0.004, mean: 0.74 }),
  carpet: () => finish('carpet', render((u, v) => {
    const fib = vnoise(u, v, 512, 81), fib2 = vnoise(u, v, 256, 82);
    const tuft = worley(u, v, 140, 83).f1;
    const wear = fbm(u, v, 5, 4, 84), stain = smooth(0.68, 0.74, fbm(u, v, 7, 4, 85));
    const g = 0.75 + (fib - 0.5) * 0.25 + (fib2 - 0.5) * 0.12 - tuft * 0.1 + (wear - 0.5) * 0.15 - stain * 0.15;
    return [g * (1 + stain * 0.05), g, g * (1 - stain * 0.08), fib * 0.5 + (1 - tuft) * 0.5, 0.97, 0];
  }), { tileM: 1.5, depth: 0.004, mean: 0.7 }),
  asphalt: () => finish('asphalt', render((u, v) => {
    const w = worley(u, v, 220, 91, 0.9);
    const stone = smooth(0.42, 0.3, w.f1);
    const st = 0.7 + rnd(w.id, 2) * 0.6;
    const fine = vnoise(u, v, 512, 92);
    const patches = fbm(u, v, 3, 5, 93);
    const oil = smooth(0.68, 0.75, fbm(u, v, 5, 4, 94)) * 0.35;
    const cr = ridge(u, v, 4, 5, 95);
    const crack = smooth(0.955, 0.985, cr) * smooth(0.45, 0.6, fbm(u, v, 3, 3, 96));
    const g = (0.62 + (patches - 0.5) * 0.35 + stone * (st - 0.7) * 0.5 + (fine - 0.5) * 0.12) * (1 - oil) * (1 - crack * 0.7);
    return [g, g, g * 1.02, 0.5 + stone * 0.4 * st - crack * 0.8 + fine * 0.1, mix(0.93, 0.72, stone) - oil * 0.4, 0, 1 - crack * 0.5];
  }), { tileM: 6, depth: 0.016, mean: 0.7 }),
  sidewalk: () => finish('sidewalk', render((u, v) => {
    const e = Math.min(u % 0.5, 0.5 - (u % 0.5), v % 0.5, 0.5 - (v % 0.5)) * 3; // meters to the nearest seam
    const seam = smooth(0.004, 0.018, e);
    const fine = vnoise(u, v, 400, 101), mid = fbm(u, v, 24, 3, 102), big = fbm(u, v, 3, 5, 103);
    const pit = smooth(0.12, 0.06, worley(u, v, 90, 104).f1) * 0.6;
    const crack = smooth(0.965, 0.99, ridge(u, v, 3, 5, 105)) * smooth(0.55, 0.65, fbm(u, v, 3, 3, 106));
    const stain = smooth(0.7, 0.78, fbm(u, v, 6, 4, 107)) * 0.2;
    const g = (0.82 + (big - 0.5) * 0.18 + (mid - 0.5) * 0.08 + (fine - 0.5) * 0.06 - pit * 0.1 - stain) * mix(0.55, 1, seam) * (1 - crack * 0.5);
    return [g, g * 0.995, g * 0.98, seam * (0.8 + fine * 0.05 + mid * 0.1) - pit * 0.1 - crack * 0.4, 0.84 + fine * 0.08, 0];
  }), { tileM: 3, depth: 0.012, mean: 0.78 }),
  concrete: () => finish('concrete', render((u, v) => {
    const fine = vnoise(u, v, 512, 111), mid = fbm(u, v, 32, 3, 112), big = fbm(u, v, 4, 5, 113);
    const pit = smooth(0.1, 0.04, worley(u, v, 120, 114).f1);
    const form = smooth(0.94, 1, vnoise2(u, v, 1, 64, 115)) * 0.05;
    const stain = smooth(0.65, 0.8, fbm(u, v, 5, 4, 116)) * 0.18;
    const g = 0.8 + (big - 0.5) * 0.22 + (mid - 0.5) * 0.08 + (fine - 0.5) * 0.06 - pit * 0.15 - stain - form;
    return [g, g * 0.995, g * 0.985, mid * 0.5 + fine * 0.2 - pit * 0.5, 0.82 + fine * 0.1 + stain * 0.2, 0];
  }), { tileM: 4, depth: 0.008, mean: 0.75 }),
  grass: () => {
    // Blades: many short strokes over a dirt base, drawn into a height/color buffer (wrapping).
    const col = new Float32Array(N * N * 3), hgt = new Float32Array(N * N), rough = new Float32Array(N * N).fill(0.95);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, i = y * N + x;
      const d = 0.42 + fbm(u, v, 16, 4, 121) * 0.2;
      col[i * 3] = d * 1.2; col[i * 3 + 1] = d * 1.0; col[i * 3 + 2] = d * 0.75;
      hgt[i] = 0;
    }
    let seed = 1;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const blades = N * N * 0.09;
    for (let b = 0; b < blades; b++) {
      const x0 = r() * N, y0 = r() * N;
      const u = x0 / N, v = y0 / N;
      const dry = smooth(0.5, 0.75, fbm(u, v, 5, 4, 122));
      const len = (4 + r() * 9) * (N / 1024) * (1 - dry * 0.3);
      const ang = r() * Math.PI * 2;
      const lum = 0.55 + r() * 0.5;
      const cg = [lum * mix(0.85, 1.25, dry), lum * mix(1.15, 1.05, dry), lum * mix(0.55, 0.6, dry)];
      for (let s = 0; s <= len; s++) {
        const t = s / len;
        const xx = Math.round(x0 + Math.cos(ang) * s), yy = Math.round(y0 + Math.sin(ang) * s);
        const i = (((yy % N) + N) % N) * N + (((xx % N) + N) % N);
        const h = (1 - t * 0.6) * (0.6 + lum * 0.4);
        if (h < hgt[i]) continue;
        hgt[i] = h;
        const k = 0.75 + t * 0.35;
        col[i * 3] = cg[0] * k; col[i * 3 + 1] = cg[1] * k; col[i * 3 + 2] = cg[2] * k;
        rough[i] = 0.85;
      }
    }
    finish('grass', { col, hgt, rough, metal: new Float32Array(N * N), ao: new Float32Array(N * N).fill(1) }, { tileM: 5, depth: 0.006, mean: 0.66, aoK: 2.5 });
  },
  dirt: () => finish('dirt', render((u, v) => {
    const big = fbm(u, v, 4, 6, 131), mid = fbm(u, v, 40, 3, 132);
    const w = worley(u, v, 70, 133);
    const pebble = smooth(0.32, 0.2, w.f1) * (rnd(w.id, 1) > 0.6 ? 1 : 0);
    const wet = smooth(0.6, 0.72, fbm(u, v, 5, 4, 134));
    const g = (0.62 + (big - 0.5) * 0.3 + (mid - 0.5) * 0.12 + pebble * (rnd(w.id, 2) - 0.3) * 0.4) * (1 - wet * 0.25);
    const c = tone(g, 1);
    return [c[0], c[1], c[2], big * 0.5 + mid * 0.3 + pebble * 0.6, 0.96 - wet * 0.3 - pebble * 0.1, 0];
  }), { tileM: 4, depth: 0.02, mean: 0.62 }),
  gravel: () => finish('gravel', render((u, v) => {
    const w = worley(u, v, 90, 141, 0.95);
    const w2 = worley(u, v, 170, 142, 0.95);
    const dome = clamp(1 - w.f1 / Math.max(0.2, w.f2 * 0.9));
    const dome2 = clamp(1 - w2.f1 / Math.max(0.2, w2.f2 * 0.9));
    const h = Math.max(Math.sqrt(dome) * (0.7 + rnd(w.id, 1) * 0.3), Math.sqrt(dome2) * 0.6);
    const t = h === Math.sqrt(dome2) * 0.6 ? rnd(w2.id, 3) : rnd(w.id, 3);
    const g = (0.45 + t * 0.55) * (0.6 + h * 0.4) * (0.9 + vnoise(u, v, 400, 143) * 0.2);
    const c = tone(g, (t - 0.5) * 1.5);
    return [c[0], c[1], c[2], h, 0.78 + (1 - h) * 0.15, 0];
  }), { tileM: 2.5, depth: 0.03, mean: 0.6, aoK: 1.5 }),
  fence: () => {
    const n = 8;
    return finish('fence', render((u, v) => {
      const bx = u * n, bi = Math.floor(bx), fx = bx - bi;
      const gap = smooth(0, 0.05, Math.min(fx, 1 - fx));
      const grain = fbm2(u + rnd(bi, 1), v, 6, 1, 4, 151);
      const ring = Math.sin((fbm2(u + rnd(bi, 2), v, 3, 1, 3, 152) * 10 + fx * 2) * Math.PI * 2) * 0.5 + 0.5;
      const weather = fbm(u, v, 8, 5, 153);
      const knot = smooth(0.12, 0.04, worley(u, v * 0.5, 10, 154 + bi).f1) * (rnd(bi, 3) > 0.85 ? 0.5 : 0);
      const g = (0.62 + (rnd(bi, 4) - 0.5) * 0.25 + grain * 0.18 + ring * 0.1 - knot * 0.3) * (0.85 + weather * 0.3);
      const c = tone(g * mix(0.45, 1, gap), 0.4 - weather);
      return [c[0], c[1], c[2], gap * (0.85 + grain * 0.1 + ring * 0.05) - knot * 0.05, 0.92, 0, mix(0.5, 1, gap)];
    }), { tileM: 2, depth: 0.006, mean: 0.7 });
  },
  roof: () => {
    const rows = 12;
    return finish('roof', render((u, v) => {
      const ry = v * rows, row = Math.floor(ry), fy = ry - row;
      const tabs = 6, off = (row % 2) * 0.5;
      const rx = (u * tabs + off) % tabs, ti = Math.floor(rx), fx = rx - ti;
      const id = row * 31 + ti;
      const slot = smooth(0, 0.02, Math.min(fx, 1 - fx)) || 0;
      const grit = vnoise(u, v, 512, 161);
      const t = 0.6 + (rnd(id, 1) - 0.5) * 0.35;
      const moss = smooth(0.66, 0.74, fbm(u, v, 6, 4, 162));
      const g = t * (0.85 + grit * 0.3) * mix(0.5, 1, slot) * (1 - smooth(0.85, 1, 1 - fy) * 0);
      const c = tone(g, 0, moss * 0.8);
      // Tabs overlap: thicker toward the bottom edge (f = 0) of each course.
      const hgt = (1 - fy * 0.6) * slot + grit * 0.08;
      return [c[0], c[1], c[2], hgt, 0.9 - grit * 0.05, 0, 1 - smooth(0.85, 1, fy) * 0.4];
    }), { tileM: 3, depth: 0.012, mean: 0.58 });
  },
  metal: () => finish('metal', render((u, v) => {
    const brush = vnoise2(u, v, 2, 600, 171);
    const rust = smooth(0.58, 0.72, fbm(u, v, 5, 6, 172));
    const pit = smooth(0.15, 0.05, worley(u, v, 80, 173).f1) * rust;
    const g = mix(0.8 + brush * 0.12, 0.55 + fbm(u, v, 60, 3, 174) * 0.25, rust);
    const c = [g * mix(1, 1.3, rust), g * mix(1, 0.92, rust), g * mix(1, 0.68, rust)];
    return [c[0], c[1], c[2], brush * 0.05 + rust * 0.4 - pit * 0.4, mix(0.32 + brush * 0.1, 0.85, rust), mix(1, 0.1, rust)];
  }), { tileM: 2, depth: 0.003, mean: 0.73 }),
};

for (const [key, fn] of Object.entries(RECIPES)) if (!ONLY || ONLY.has(key)) fn();
