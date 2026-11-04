import * as THREE from 'three';
import { rng } from '@dead-hours/shared';

/**
 * Small procedural textures generated on a canvas at startup. They add surface breakup
 * (grime, seams, cracks) so flat low-poly faces read as real materials under grazing light.
 */

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function speckle(ctx: CanvasRenderingContext2D, size: number, count: number, alpha: number, r: () => number, light = false) {
  for (let i = 0; i < count; i++) {
    const v = light ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * r()})`;
    const s = 1 + r() * 3;
    ctx.fillRect(r() * size, r() * size, s, s);
  }
}

function blotches(ctx: CanvasRenderingContext2D, size: number, count: number, alpha: number, r: () => number) {
  for (let i = 0; i < count; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = size * (0.05 + r() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const dark = r() > 0.4;
    g.addColorStop(0, dark ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha * 0.5})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

function finish(c: HTMLCanvasElement, anisotropy: number, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export type TextureKey =
  | 'asphalt' | 'sidewalk' | 'concrete' | 'grass' | 'siding' | 'brick' | 'plaster' | 'wood' | 'roof' | 'fence'
  | 'gravel' | 'dirt' | 'tile' | 'carpet' | 'metal';

/** Grayscale detail maps: multiplied with the material color so one texture serves many tints. */
export function createTextures(size: number, anisotropy: number): Record<TextureKey, THREE.Texture> {
  const r = rng(1337);

  const asphalt = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#b4b4b4';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 26, 0.16, r);
    speckle(x, size, size * 30, 0.35, r);
    speckle(x, size, size * 8, 0.25, r, true);
    // Hairline cracks.
    x.strokeStyle = 'rgba(0,0,0,0.45)';
    x.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) {
      x.beginPath();
      let px = r() * size;
      let py = r() * size;
      x.moveTo(px, py);
      for (let k = 0; k < 12; k++) {
        px += (r() - 0.5) * 28;
        py += (r() - 0.5) * 28;
        x.lineTo(px, py);
      }
      x.stroke();
    }
    return finish(c, anisotropy);
  })();

  const sidewalk = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#c9c9c9';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 18, 0.12, r);
    speckle(x, size, size * 12, 0.18, r);
    // Slab seams every 1.5m (texture covers 3m).
    x.fillStyle = 'rgba(0,0,0,0.5)';
    x.fillRect(0, 0, size, 2);
    x.fillRect(0, size / 2, size, 2);
    x.fillRect(0, 0, 2, size);
    x.fillRect(size / 2, 0, 2, size);
    return finish(c, anisotropy);
  })();

  const concrete = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#c0c0c0';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 30, 0.14, r);
    speckle(x, size, size * 16, 0.2, r);
    x.fillStyle = 'rgba(0,0,0,0.35)';
    x.fillRect(0, 0, size, 2);
    return finish(c, anisotropy);
  })();

  const grass = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#a8a8a8';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 40, 0.25, r);
    for (let i = 0; i < size * 40; i++) {
      const v = 120 + r() * 135;
      x.strokeStyle = `rgba(${v},${v},${v},0.5)`;
      const px = r() * size;
      const py = r() * size;
      x.beginPath();
      x.moveTo(px, py);
      x.lineTo(px + (r() - 0.5) * 3, py - 2 - r() * 5);
      x.stroke();
    }
    return finish(c, anisotropy);
  })();

  const siding = (() => {
    // Horizontal lap siding, 8 boards per texture (texture spans 2m).
    const [c, x] = canvas(size);
    x.fillStyle = '#d8d8d8';
    x.fillRect(0, 0, size, size);
    const boards = 8;
    const bh = size / boards;
    for (let i = 0; i < boards; i++) {
      const g = x.createLinearGradient(0, i * bh, 0, (i + 1) * bh);
      g.addColorStop(0, 'rgba(255,255,255,0.10)');
      g.addColorStop(0.85, 'rgba(0,0,0,0.05)');
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      x.fillStyle = g;
      x.fillRect(0, i * bh, size, bh);
    }
    blotches(x, size, 16, 0.12, r);
    speckle(x, size, size * 6, 0.12, r);
    // Grime streaks.
    for (let i = 0; i < 20; i++) {
      x.fillStyle = `rgba(0,0,0,${0.04 + r() * 0.06})`;
      x.fillRect(r() * size, 0, 2 + r() * 6, size);
    }
    return finish(c, anisotropy);
  })();

  const brick = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#5a5a5a';
    x.fillRect(0, 0, size, size);
    const rows = 16;
    const bh = size / rows;
    const bw = bh * 2.6;
    for (let row = 0; row < rows; row++) {
      const off = (row % 2) * bw * 0.5;
      for (let col = -1; col < size / bw + 1; col++) {
        const v = 170 + r() * 70;
        x.fillStyle = `rgb(${v},${v},${v})`;
        x.fillRect(col * bw + off + 1.5, row * bh + 1.5, bw - 3, bh - 3);
      }
    }
    blotches(x, size, 14, 0.18, r);
    return finish(c, anisotropy);
  })();

  const plaster = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#d0d0d0';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 24, 0.08, r);
    speckle(x, size, size * 4, 0.06, r);
    return finish(c, anisotropy);
  })();

  const wood = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#b0b0b0';
    x.fillRect(0, 0, size, size);
    const planks = 10;
    const pw = size / planks;
    for (let i = 0; i < planks; i++) {
      const v = 150 + r() * 80;
      x.fillStyle = `rgb(${v},${v},${v})`;
      x.fillRect(i * pw + 1, 0, pw - 2, size);
      for (let k = 0; k < 14; k++) {
        x.strokeStyle = `rgba(0,0,0,${0.05 + r() * 0.1})`;
        x.beginPath();
        const gx = i * pw + r() * pw;
        x.moveTo(gx, 0);
        x.bezierCurveTo(gx + 3, size / 3, gx - 3, (2 * size) / 3, gx, size);
        x.stroke();
      }
      x.fillStyle = 'rgba(0,0,0,0.5)';
      x.fillRect(i * pw, (r() * size) | 0, pw, 2);
    }
    return finish(c, anisotropy);
  })();

  const roof = (() => {
    // Asphalt shingles.
    const [c, x] = canvas(size);
    x.fillStyle = '#909090';
    x.fillRect(0, 0, size, size);
    const rows = 12;
    const rh = size / rows;
    for (let row = 0; row < rows; row++) {
      const tw = rh * 1.6;
      const off = (row % 2) * tw * 0.5;
      for (let col = -1; col < size / tw + 1; col++) {
        const v = 110 + r() * 90;
        x.fillStyle = `rgb(${v},${v},${v})`;
        x.fillRect(col * tw + off + 1, row * rh, tw - 2, rh - 2);
      }
      x.fillStyle = 'rgba(0,0,0,0.45)';
      x.fillRect(0, row * rh + rh - 3, size, 3);
    }
    speckle(x, size, size * 10, 0.2, r);
    return finish(c, anisotropy);
  })();

  const fence = (() => {
    const [c, x] = canvas(size / 2);
    const s = size / 2;
    x.fillStyle = '#a0a0a0';
    x.fillRect(0, 0, s, s);
    const n = 8;
    for (let i = 0; i < n; i++) {
      const v = 140 + r() * 90;
      x.fillStyle = `rgb(${v},${v},${v})`;
      x.fillRect((i * s) / n + 1, 0, s / n - 2, s);
    }
    speckle(x, s, s * 10, 0.2, r);
    return finish(c, anisotropy);
  })();

  const gravel = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#8c8c8c';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 20, 0.2, r);
    for (let i = 0; i < size * 5; i++) {
      const v = 90 + r() * 165;
      x.fillStyle = `rgba(${v},${v},${v},0.85)`;
      const s = 1.5 + r() * 3.5;
      x.beginPath();
      x.ellipse(r() * size, r() * size, s, s * (0.6 + r() * 0.4), r() * 3, 0, Math.PI * 2);
      x.fill();
    }
    return finish(c, anisotropy);
  })();

  const dirt = (() => {
    const [c, x] = canvas(size);
    x.fillStyle = '#a0a0a0';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 50, 0.22, r);
    speckle(x, size, size * 20, 0.3, r);
    speckle(x, size, size * 4, 0.2, r, true);
    return finish(c, anisotropy);
  })();

  const tile = (() => {
    // 30 cm vinyl tiles, alternating tone (texture covers 1.2 m).
    const [c, x] = canvas(size);
    const n = 4;
    const t = size / n;
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
      const v = (i + k) % 2 ? 205 : 170 + r() * 10;
      x.fillStyle = `rgb(${v},${v},${v})`;
      x.fillRect(i * t, k * t, t, t);
    }
    blotches(x, size, 16, 0.1, r);
    speckle(x, size, size * 6, 0.12, r);
    x.fillStyle = 'rgba(0,0,0,0.3)';
    for (let i = 0; i < n; i++) {
      x.fillRect(i * t, 0, 1, size);
      x.fillRect(0, i * t, size, 1);
    }
    return finish(c, anisotropy);
  })();

  const carpet = (() => {
    const [c, x] = canvas(size / 2);
    const s = size / 2;
    x.fillStyle = '#b8b8b8';
    x.fillRect(0, 0, s, s);
    speckle(x, s, s * 60, 0.25, r);
    speckle(x, s, s * 20, 0.2, r, true);
    blotches(x, s, 10, 0.12, r);
    return finish(c, anisotropy);
  })();

  const metal = (() => {
    const [c, x] = canvas(size / 2);
    const s = size / 2;
    x.fillStyle = '#bdbdbd';
    x.fillRect(0, 0, s, s);
    for (let i = 0; i < s; i++) {
      x.fillStyle = `rgba(0,0,0,${r() * 0.06})`;
      x.fillRect(0, i, s, 1);
    }
    blotches(x, s, 18, 0.25, r);
    speckle(x, s, s * 4, 0.3, r);
    return finish(c, anisotropy);
  })();

  return { asphalt, sidewalk, concrete, grass, siding, brick, plaster, wood, roof, fence, gravel, dirt, tile, carpet, metal };
}

/** Soft radial sprite used by fog wisps, light halos and smoke. */
export function createSoftSprite(size = 128): THREE.CanvasTexture {
  const [c, x] = canvas(size);
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
