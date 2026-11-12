/**
 * Everything that sits on the head: face, hair, beards, earrings, hats, face gear and the
 * cigarette or cigar a survivor can hold in their mouth.
 */
import * as THREE from 'three';
import { paletteColor, type Appearance } from '@dead-hours/shared';
import { BONE } from './rig';
import { PATTERN, type Surface, type PartSink, type V3, O, TAU, mat, mixHex, shade, luminance, Kit, crumple, headWarp, headSink, faceShade, neckShade, type Body, type Cover, COVERS_FACE, EYES, EYE_Y, EYE_X, EYE_Z, type EyePart, DOME_C, domeR, taperTube, type SmokeKind, type SmokeShape, SMOKES, COVERS_MOUTH, MASKS, EMBER_LEN, CHAR, type SmokeRig } from './OutfitKit';
import { EYEBALL_R, EYE_YAW, MOUTH_Y, browGeometry, earGeometry, faceLayer, faceZ, headGeometry, lidGeometry, lidUp, shutLidGeometry, teethGeometry, type FacePaint } from './HeadSculpt';

/** Lip, lid and cheek colors the makeup gives (undefined: bare). */
function makeupColors(a: Appearance, b: Body): { lips?: number; lids?: number; cheeks?: number } {
  if (b.zombie) return {};
  const mc = paletteColor('makeup', a.makeupColor);
  switch (a.makeup) {
    case 'lipstick': return { lips: mixHex(mc, b.skin, 0.12) };
    case 'shadow': return { lids: mixHex(mc, b.skin, 0.3) };
    case 'blush': return { cheeks: mixHex(b.skin, 0xd8505f, 0.3) };
    case 'glam': return { lips: mixHex(mc, b.skin, 0.12), lids: mixHex(mc, b.skin, 0.5), cheeks: mixHex(b.skin, 0xd8505f, 0.26) };
    case 'smoky': return { lips: mixHex(mc, b.skin, 0.3), lids: mixHex(0x2b2228, b.skin, 0.12) };
    default: return {};
  }
}

const gs = (dx: number, dy: number) => Math.exp(-(dx * dx + dy * dy));
const sstep = THREE.MathUtils.smoothstep;

/** How much of a point on the face (as built) is lip: all of it between the lips' edges, none past the corners. */
function lipK(x: number, y: number): number {
  const xf = 1 - sstep(Math.abs(x), 0.019, 0.0285);
  return xf * (y > MOUTH_Y ? 1 - sstep(y, 0.0665, 0.0705) : 1 - sstep(MOUTH_Y - y, 0.0075, 0.0125));
}

/** Where a full beard grows: below a line from under the nose round to the ears, not on the lips. */
function beardK(x: number, y: number, a: number): number {
  const ax = Math.abs(x), aa = Math.abs(a);
  if (ax < 0.0295 && y > 0.0465 && y < 0.0705) return 0;
  const line = ax < 0.034 && aa < 0.5 ? 0.081 : 0.066 + 0.05 * sstep(aa, 0.45, 1.35);
  return sstep(line - y, 0, 0.012) * (1 - sstep(aa, 1.5, 1.75));
}

/**
 * What is painted into the skin of the face: lips, the line of the mouth, stubble and makeup on
 * the living; on the dead, sockets gone black, lips rotted back to raw meat and a mouth that is
 * a dark hole.
 */
function facePaint(a: Appearance, b: Body, hairHex: number, covered: boolean): FacePaint {
  const f = b.face;
  const col = (hex: number) => new THREE.Color(hex);
  const layers: { c: THREE.Color; k: (x: number, y: number, a: number) => number }[] = [];
  const add = (hex: number, k: (x: number, y: number, a: number) => number) => layers.push({ c: col(hex), k });
  const mouthLine = (x: number, y: number) => (Math.abs(y - MOUTH_Y) < 0.0006 ? 1 - sstep(Math.abs(x), 0.024, 0.03) : 0);
  if (b.zombie) {
    // Sockets sunk into shadow, the skin round the mouth dark with old blood, lips raw.
    add(0x120809, (x, y) => 0.9 * gs((Math.abs(x) - EYE_X) / 0.021, (y - EYE_Y) / 0.0155));
    add(0x240a08, (x, y) => 0.55 * gs(x / 0.036, (y - 0.056) / 0.022));
    add(0x2c0b09, (x, y) => lipK(x, y) * (0.6 + 0.4 * f.lipless));
    add(0x0a0303, mouthLine);
    // A nose rotted down to the hole in the skull.
    if (f.nose < 0.6) add(0x150808, (x, y) => 0.95 * gs(x / 0.011, (y - 0.094) / 0.011));
    if (f.tear !== 0) add(0x3a0c0a, (x, y) => 0.9 * gs((x - f.tear * 0.052) / 0.014, (y - 0.068) / 0.012));
  } else if (!covered) {
    const mk = makeupColors(a, b);
    if (a.facialHair === 'stubble') add(mixHex(hairHex, b.skin, 0.55), (x, y, an) => 0.62 * beardK(x, y, an));
    if (mk.cheeks !== undefined) add(mk.cheeks, (x, y) => 0.7 * gs((Math.abs(x) - 0.07) / 0.02, (y - 0.096) / 0.015));
    if (mk.lids !== undefined) add(mk.lids, (x, y) => 0.85 * gs((Math.abs(x) - 0.044) / 0.021, (y - 0.1505) / 0.0055));
    if (a.makeup === 'eyeblack') add(0x141214, (x, y) => 0.95 * gs((Math.abs(x) - 0.048) / 0.02, (y - 0.124) / 0.008));
    // Lips: a little redder than the skin, or painted; the upper one darker, turned from the light.
    const lipHex = mk.lips ?? mixHex(b.skin, b.female ? 0xa04a58 : 0x8a4c48, b.female ? 0.34 : 0.24);
    add(lipHex, (x, y) => lipK(x, y) * (y > MOUTH_Y ? 0.92 : 1));
    add(mixHex(lipHex, 0x2a0c10, 0.7), (x, y) => 0.9 * mouthLine(x, y));
  }
  return (x, y, an, out) => {
    for (const l of layers) {
      const k = l.k(x, y, an);
      if (k <= 0.003) continue;
      const a0 = out[3], a1 = a0 + k * (1 - a0);
      out[0] = (out[0] * a0 * (1 - k) + l.c.r * k) / a1;
      out[1] = (out[1] * a0 * (1 - k) + l.c.g * k) / a1;
      out[2] = (out[2] * a0 * (1 - k) + l.c.b * k) / a1;
      out[3] = a1;
    }
  };
}

/**
 * The head: a neck narrowing up into the jaw, the sculpted skull and face (HeadSculpt), ears,
 * eyelids over the eyes and brows on the ridge above them; the dead get their teeth.
 */
export function face(h: Kit, neck: Kit, a: Appearance, b: Body, hairHex: number, covered: boolean): void {
  const skin = b.skin, f = b.face;
  const soft: Surface = { shade: faceShade };
  const nk = (b.female ? 0.82 : 1) * (b.zombie ? 0.9 : 1);
  neck.cyl(skin, 0.054 * nk, 0.065 * nk, 0.12, [0, -0.04, 0.004], O, [1, 1, 0.95], { seg: 8 }, { shade: neckShade });
  h.put(headGeometry(f, facePaint(a, b, hairHex, covered)), skin, O, O, 1, soft);
  if (!b.mask?.ears) for (const s of [1, -1]) h.put(earGeometry(s, b.zombie), shade(skin, 0.96), [s * 0.1125, 0.113, -0.012], [-0.18, -s * 0.3, 0], 1, soft);
  if (b.zombie) {
    // Teeth, behind lips drawn back off them.
    h.put(teethGeometry(f, true, b.rand), 0xb9ad86);
    h.put(teethGeometry(f, false, b.rand), 0xb9ad86);
    return;
  }
  const e = EYES[a.eyes] ?? EYES.almond;
  const mk = makeupColors(a, b);
  const liner = a.makeup === 'liner' || a.makeup === 'glam' || a.makeup === 'smoky';
  const lash = new THREE.Color(liner ? 0x0b0909 : b.female ? 0x1a1210 : mixHex(skin, 0x1a1210, 0.6));
  const rim = new THREE.Color(mixHex(skin, 0x8a4a48, 0.35));
  const lidHex = mk.lids !== undefined ? mixHex(mk.lids, skin, 0.2) : shade(skin, 0.97);
  for (const s of [1, -1]) {
    const eye = h.at([s * EYE_X, EYE_Y, EYE_Z], [0, s * EYE_YAW, 0]);
    eye.put(lidGeometry(e, s, true, 8, lash), lidHex, O, O, 1, mk.lids !== undefined ? undefined : soft);
    eye.put(lidGeometry(e, s, false, 8, rim), shade(skin, 0.97), O, O, 1, soft);
    if (covered || b.mask?.brows) continue;
    const brow = luminance(hairHex) > 0.7 ? shade(hairHex, 0.85) : hairHex;
    // Women's brows thinner and arched, men's heavier and flatter.
    h.put(browGeometry(f, s, e.browY + (b.female ? 0.002 : 0), e.brow * 0.55, b.female ? 0.0066 : 0.0105, b.female ? 0.0042 : 0.0016), brow);
  }
}

/**
 * A balaclava, a wrap or a gaiter (the mask slot): cloth lying on the head's own surface, so it
 * follows the nose, the jaw and the chin, open where the mask leaves the face bare. Hats and
 * eyewear go on over it.
 */
export function maskCloth(h: Kit, neck: Kit, a: Appearance, b: Body, hex: number): void {
  const m = b.mask;
  if (!m) return;
  const f = b.face;
  const skull = a.mask === 'skull';
  const wrap = a.mask === 'shemaghwrap';
  const color = skull ? 0x17181b : hex;
  const surf: Surface | undefined = wrap ? { pattern: PATTERN.plaid, accent: shade(hex, 0.5) } : undefined;
  const thick = wrap ? 0.008 : 0.005;
  const g = faceLayer(f, (x, y, an) => (m.bare(x, y, an) ? -1 : thick));
  if (skull) {
    // The print: bone over the brow, the cheekbones and the upper jaw, dark where the nose's
    // hole and the hollows under the cheekbones are.
    const P = g.getAttribute('position');
    const pnt = new Float32Array(P.count * 4);
    const bone = new THREE.Color(0xd9d5c8);
    for (let i = 0; i < P.count; i++) {
      const ax = Math.abs(P.getX(i)), y = P.getY(i);
      let k = P.getZ(i) > 0.03 && y > 0.044 && y < 0.205 && ax < 0.09 ? 1 : 0;
      if ((ax < 0.016 && y > 0.08 && y < 0.1) || (ax > 0.05 && y < 0.09)) k = 0;
      pnt.set([bone.r, bone.g, bone.b, k], i * 4);
    }
    g.setAttribute('paint', new THREE.BufferAttribute(pnt, 4));
  }
  h.put(g, color, O, O, 1, surf);
  if (skull) for (let k = -3; k <= 3; k++) h.box(0x17181b, [0.0028, 0.024, 0.004], [k * 0.0098, 0.058, faceZ(f, k * 0.0098, 0.058) + 0.0056]);
  // Down the neck into the collar.
  const nk = b.female ? 0.82 : 1;
  neck.cyl(color, 0.061 * nk, 0.073 * nk, 0.125, [0, -0.04, 0.004], O, [1, 1, 0.95], { seg: 8 }, surf);
  if (a.mask === 'gaiter') neck.cyl(shade(color, 0.86), 0.078 * nk, 0.082 * nk, 0.035, [0, -0.082, 0.004], O, [1, 1, 0.95], { seg: 8 });
  if (wrap) {
    // The roll of cloth across the forehead, the bunch at the neck and the loose end behind.
    h.torus(color, 0.129, 0.015, [0, 0.188, -0.006], [Math.PI / 2 + 0.12, 0, 0], [0.96, 1.1, 1], 4, 10, TAU, surf);
    neck.torus(color, 0.078, 0.03, [0, -0.07, 0.004], [Math.PI / 2, 0, 0], [1, 1.05, 1], 4, 10, TAU, surf);
    h.box(color, [0.075, 0.2, 0.014], [0.05, 0.0, -0.128], [0.14, 0, 0.1], surf);
  }
}

/** Earrings at the lobes (hidden under full helmets). */
export function earrings(h: Kit, a: Appearance, cover: Cover): void {
  if (cover === 'full' || a.ears === 'none') return;
  const gold = 0xd8b04a, silver = 0xc8ccd2;
  for (const s of [1, -1]) {
    const x = s * 0.1235, y = 0.086, z = -0.004;
    switch (a.ears) {
      case 'studs':
      case 'goldstuds':
        h.ico(a.ears === 'studs' ? silver : gold, 0.0048, [x, y, z], O, 1, 1);
        break;
      case 'hoops':
      case 'silverhoops':
      case 'bighoops': {
        const big = a.ears === 'bighoops';
        const R = big ? 0.025 : 0.0135;
        h.torus(a.ears === 'silverhoops' ? silver : gold, R, big ? 0.0024 : 0.0019, [x + s * 0.002, y - R + 0.003, z], [0, Math.PI / 2, 0], 1, 4, 18);
        break;
      }
      case 'pearls':
        h.ball(0xf1ebde, 0.0074, [x, y - 0.006, z], O, undefined, 8, 6);
        break;
      case 'drops':
        h.ico(gold, 0.0042, [x, y, z], O, 1, 0);
        h.box(gold, [0.0016, 0.016, 0.0016], [x, y - 0.01, z]);
        h.put(new THREE.OctahedronGeometry(0.008, 0), 0x7fc8dc, [x, y - 0.024, z], O, [0.75, 1.4, 0.75]);
        break;
    }
  }
}

/**
 * Eye geometry (head-bone space as built, relative to the eye line at EYE_Y): the eyeball, iris,
 * pupil and glint behind the lids, and the lashes and liner that stay on the lid's edge.
 */
export function eyeParts(a: Appearance): EyePart[] {
  const e = EYES[a.eyes] ?? EYES.almond;
  const iris = paletteColor('eye', a.eyeColor);
  const out: EyePart[] = [];
  const add = (g: THREE.BufferGeometry, hex: number, m: THREE.Matrix4, moves = false) => out.push({ g, hex, m, iris: moves });
  const R = EYEBALL_R;
  for (const s of [1, -1]) {
    const frame = mat([s * EYE_X, 0, EYE_Z], [0, s * EYE_YAW, 0]);
    const at = (p: V3, r: V3, sc: V3 | number) => frame.clone().multiply(mat(p, r, sc));
    add(new THREE.SphereGeometry(1, 12, 8), 0xdfd9cf, at(O, O, R));
    const ir = 0.0078;
    add(new THREE.SphereGeometry(1, 12, 6), iris, at([0, 0, R[2] - 0.0019], O, [ir, ir, 0.0026]), true);
    add(new THREE.SphereGeometry(1, 8, 5), 0x050505, at([0, 0, R[2] - 0.0004], O, [ir * 0.42, ir * 0.42, 0.0014]), true);
    add(new THREE.SphereGeometry(1, 5, 4), 0xffffff, at([-s * ir * 0.3 + s * 0.0006, ir * 0.36, R[2] + 0.0008], O, ir * 0.15), true);
    const female = a.body === 'female';
    const liner = a.makeup === 'liner' || a.makeup === 'glam' || a.makeup === 'smoky';
    // Lashes flicking up at the outer corner, off the upper lid's edge.
    if (female) {
      for (let i = 0; i < 3; i++) {
        const u = 0.35 + i * 0.25;
        add(new THREE.ConeGeometry(0.0011, 0.0052, 3), 0x120d0b,
          at([s * u * e.a, lidUp(e, u) + 0.0018, 0.0122 - u * 0.0035], [0.5, 0, -s * (0.25 + u * 0.7)], 1));
      }
    }
    // Winged liner sweeping up past the outer corner.
    if (liner) add(new THREE.BoxGeometry(0.0075, 0.0016, 0.002), 0x0b0909, at([s * (e.a + 0.0028), lidUp(e, 1) + 0.0014, 0.0052], [0, s * 0.5, s * 0.5], 1));
  }
  return out;
}

/** Both eyes' lids shut (relative to the eye line, like eyeParts): shown for a blink, and on the dead. */
export function shutLids(a: Appearance, skinHex: number): THREE.BufferGeometry[] {
  const e = EYES[a.eyes] ?? EYES.almond;
  const skin = new THREE.Color(shade(skinHex, 0.93)), lash = new THREE.Color(mixHex(skinHex, 0x1a1210, a.body === 'female' ? 0.9 : 0.6));
  return [1, -1].map((s) => shutLidGeometry(e, s, 8, skin, lash).applyMatrix4(mat([s * EYE_X, 0, EYE_Z], [0, s * EYE_YAW, 0])));
}

/** The dead's eyes (head space as built): clouded balls sunk in the sockets, each with a pinprick that still catches the light. */
export function deadEyes(glowHex: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const glow = new THREE.Color(glowHex);
  const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(col, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    return g;
  };
  // The ball: a dim film of the eye's color over grey. The pupil: all of it.
  const film = new THREE.Color(0x24231f).lerp(glow, 0.2);
  for (const s of [1, -1]) {
    const z = EYE_Z - 0.0075;
    out.push(paint(new THREE.SphereGeometry(0.0108, 8, 6).translate(s * EYE_X, EYE_Y, z), film));
    out.push(paint(new THREE.SphereGeometry(1, 6, 4).scale(0.0036, 0.0036, 0.0016).translate(s * (EYE_X - 0.0008), EYE_Y - 0.0006, z + 0.0102), glow));
  }
  return out;
}

// ── Hair ────────────────────────────────────────────────────────────────────────────────

export function hair(h: Kit, a: Appearance, b: Body, hx: number, cover: Cover): void {
  const crown = cover === 'none';
  const scalpOk = cover !== 'full';
  const shaved = mixHex(hx, b.skin, 0.38);
  const scalp = (inf: number, theta: number, tilt: number, hex = hx) => {
    if (scalpOk) h.cap(hex, [0.117 + inf, 0.14 + inf, 0.13 + inf], 0, theta, [0, 0.12, 0], [-tilt, 0, 0], { w: 12, h: 5 });
  };
  // A clump of hair: a few flat facets, not a ball.
  const fringe = (p: V3, s: V3, r: V3 = O) => { if (crown) h.ico(hx, 1, p, r, s, 1); };
  const onScalp = (theta: number, phi: number, inf: number) => {
    const d = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    const p: V3 = [d.x * (0.117 + inf), 0.12 + d.y * (0.14 + inf), -0.004 + d.z * (0.13 + inf)];
    return { d, p };
  };
  switch (a.hair) {
    case 'bald':
      break;
    case 'buzz':
      scalp(0.009, 1.5, 0.5, shaved);
      break;
    case 'short':
      scalp(0.012, 1.55, 0.5);
      fringe([0, 0.21, 0.075], [0.075, 0.022, 0.04], [0.55, 0, 0]);
      break;
    case 'sidepart':
      scalp(0.012, 1.55, 0.5);
      fringe([0.03, 0.232, 0.05], [0.085, 0.03, 0.07], [0.35, 0, -0.25]);
      fringe([-0.065, 0.212, 0.06], [0.045, 0.022, 0.045], [0.45, 0, 0.3]);
      break;
    case 'messy':
      scalp(0.016, 1.55, 0.5);
      for (let i = 0; i < 9; i++) {
        const { d, p } = onScalp(0.2 + b.rand() * 0.85, b.rand() * TAU, 0.012);
        const tilt = new THREE.Vector3(b.rand() - 0.5, 0, b.rand() - 0.5).multiplyScalar(0.8);
        if (crown && d.z < 0.75) h.putAlong(new THREE.ConeGeometry(0.03, 0.075, 4), hx, p, d.add(tilt));
      }
      fringe([0.01, 0.21, 0.077], [0.07, 0.024, 0.04], [0.55, 0, -0.1]);
      break;
    case 'spiky':
      scalp(0.01, 1.5, 0.5);
      if (crown) {
        for (let i = 0; i < 11; i++) {
          const theta = i === 0 ? 0 : 0.55 + (i % 2) * 0.35;
          const { d, p } = onScalp(theta, (i / 10) * TAU + 0.3, 0.008);
          h.putAlong(new THREE.ConeGeometry(0.026, 0.1, 4), hx, p, d);
        }
      }
      break;
    case 'curly':
      scalp(0.018, 1.6, 0.45);
      if (crown) {
        for (let i = 0; i < 34; i++) {
          const theta = Math.acos(1 - (i / 34) * 1.25);
          const { p } = onScalp(theta, i * 2.4, 0.016);
          if (p[2] > 0.08 && p[1] < 0.215) continue;
          h.ico(hx, 0.034, p, [i, i * 2, 0], 1, 1);
        }
      }
      break;
    case 'afro':
      scalp(0.02, 1.62, 0.45);
      if (crown) h.ico(hx, 0.178, [0, 0.235, -0.058], [0.3, 0.2, 0], [1.05, 0.9, 0.92], 2);
      break;
    case 'long':
      scalp(0.014, 1.6, 0.5);
      h.ball(hx, [0.116, 0.2, 0.06], [0, 0.03, -0.088], [0.12, 0, 0], undefined, 12, 7);
      for (const s of [1, -1]) h.ball(hx, [0.028, 0.13, 0.055], [s * 0.104, 0.065, -0.01], [0.05, 0, s * 0.06], undefined, 8, 6);
      fringe([0, 0.212, 0.072], [0.08, 0.024, 0.04], [0.55, 0, 0]);
      break;
    case 'ponytail':
      scalp(0.012, 1.55, 0.55);
      h.torus(shade(hx, 0.6), 0.02, 0.008, [0, 0.165, -0.13], [1.0, 0, 0], 1, 4, 10);
      h.ball(hx, [0.035, 0.12, 0.035], [0, 0.07, -0.165], [-0.3, 0, 0], undefined, 8, 6);
      break;
    case 'bun':
      scalp(0.012, 1.55, 0.5);
      if (crown) {
        h.ico(hx, 0.055, [0, 0.282, -0.035], O, 1, 1);
        h.torus(shade(hx, 0.6), 0.03, 0.008, [0, 0.24, -0.02], [Math.PI / 2 - 0.3, 0, 0], 1, 4, 10);
      }
      break;
    case 'mohawk':
      scalp(0.009, 1.5, 0.5, shaved);
      if (crown) {
        for (let i = 0; i < 7; i++) {
          const theta = -0.85 + i * 0.36;
          const { d, p } = onScalp(Math.abs(theta), theta < 0 ? Math.PI / 2 : -Math.PI / 2, 0.004);
          h.putAlong(new THREE.ConeGeometry(0.04, 0.12 - Math.abs(i - 2.5) * 0.012, 4), hx, p, d, [0.35, 1, 1]);
        }
      }
      break;
    case 'mullet':
      scalp(0.012, 1.5, 0.5);
      h.ball(hx, [0.1, 0.13, 0.05], [0, 0.0, -0.1], [0.2, 0, 0], undefined, 10, 6);
      fringe([0, 0.21, 0.075], [0.075, 0.022, 0.04], [0.55, 0, 0]);
      break;
    case 'bob':
      scalp(0.018, 1.7, 0.3);
      h.cyl(hx, 0.13, 0.145, 0.14, [0, 0.07, -0.006], O, [1, 1, 1.06], { seg: 14, open: false, t0: 0.62, tl: TAU - 1.24 });
      fringe([0, 0.214, 0.07], [0.095, 0.026, 0.045], [0.6, 0, 0]);
      break;
    case 'pixie':
      scalp(0.013, 1.55, 0.5);
      // Swept to one side over the forehead, wisps in front of the ears, short at the nape.
      fringe([0.025, 0.218, 0.074], [0.095, 0.028, 0.048], [0.5, 0, -0.32]);
      fringe([-0.06, 0.226, 0.055], [0.05, 0.024, 0.05], [0.4, 0, 0.35]);
      for (const s of [1, -1]) h.ball(hx, [0.011, 0.03, 0.016], [s * 0.111, 0.132, 0.042], [0.1, 0, s * 0.08], undefined, 6, 5);
      break;
    case 'bangs':
      scalp(0.015, 1.6, 0.5);
      longBack(h, hx, 0.2);
      for (const s of [1, -1]) h.ball(hx, [0.03, 0.15, 0.055], [s * 0.106, 0.05, -0.01], [0.04, 0, s * 0.05], undefined, 8, 6);
      // Blunt bangs straight across the forehead, down to the brows.
      if (crown) h.front(hx, [0.128, 0.152, 0.142], 0.5, 0.66, 2.1, [0, 0.12, -0.002], [-0.06, 0, 0], undefined, 14, 4);
      break;
    case 'wavy': {
      scalp(0.016, 1.62, 0.5);
      // Loose waves down the back: one fall of hair with waves breaking its edges and ends.
      longBack(h, hx, 0.21);
      for (let i = 0; i < 4; i++) {
        for (const s of [1, -1]) h.ball(hx, [0.036, 0.052, 0.05], [s * (0.1 + ((i + (s > 0 ? 0 : 1)) % 2) * 0.016), 0.12 - i * 0.085, -0.075], [0.1, 0, s * 0.3], undefined, 8, 6);
      }
      for (const k of [-1, 0, 1]) h.ball(hx, [0.048, 0.036, 0.042], [k * 0.06, -0.17 + Math.abs(k) * 0.025, -0.088], [0.2, 0, k * 0.4], undefined, 8, 6);
      for (const s of [1, -1]) {
        h.ball(hx, [0.032, 0.09, 0.055], [s * 0.107, 0.085, -0.008], [0.05, 0, s * 0.1], undefined, 8, 6);
        h.ball(hx, [0.036, 0.06, 0.055], [s * 0.117, -0.015, -0.025], [0.05, 0, -s * 0.18], undefined, 8, 6);
      }
      fringe([0.03, 0.222, 0.068], [0.1, 0.03, 0.05], [0.45, 0, -0.35]);
      fringe([-0.075, 0.2, 0.06], [0.04, 0.05, 0.045], [0.25, 0, 0.5]);
      break;
    }
    case 'shoulder':
      scalp(0.017, 1.7, 0.35);
      h.cyl(hx, 0.132, 0.158, 0.22, [0, 0.04, -0.008], O, [1, 1, 1.05], { seg: 16, open: false, t0: 0.72, tl: TAU - 1.44 });
      fringe([0.035, 0.222, 0.065], [0.1, 0.03, 0.05], [0.45, 0, -0.38]);
      break;
    case 'highpony':
      scalp(0.012, 1.55, 0.55);
      // Pulled up tight to a tie high on the crown, then a long tail arcing down the back.
      h.torus(shade(hx, 0.55), 0.022, 0.009, [0, 0.262, -0.085], [0.4, 0, 0], 1, 4, 10);
      for (const [y, z, r, rx] of [[0.27, -0.12, 0.04, 0.6], [0.2, -0.165, 0.042, 0.25], [0.09, -0.18, 0.038, -0.05], [-0.03, -0.165, 0.03, -0.2], [-0.12, -0.15, 0.02, -0.3]] as const) {
        h.ball(hx, [r, 0.075, r * 0.9], [0, y, z], [rx, 0, 0], undefined, 8, 6);
      }
      break;
    case 'braid': {
      scalp(0.012, 1.55, 0.55);
      h.torus(shade(hx, 0.6), 0.02, 0.008, [0, 0.16, -0.13], [1.0, 0, 0], 1, 4, 10);
      // Plaited segments down the back, narrowing, tied off with a tuft.
      for (let i = 0; i < 8; i++) {
        const y = 0.13 - i * 0.042;
        h.ico(hx, 0.027 - i * 0.0012, [(i % 2 ? 1 : -1) * 0.007, y, -0.152 + i * 0.004], [i * 0.7, 0, (i % 2 ? 1 : -1) * 0.5], [1, 1.25, 0.85], 1);
      }
      h.torus(shade(hx, 0.6), 0.012, 0.006, [0, -0.215, -0.122], [Math.PI / 2, 0, 0], 1, 4, 8);
      h.cone(hx, 0.02, 0.05, [0, -0.25, -0.12], [Math.PI, 0, 0], 1, 6);
      break;
    }
    case 'pigtails':
      scalp(0.013, 1.6, 0.45);
      fringe([0, 0.214, 0.072], [0.09, 0.026, 0.045], [0.55, 0, 0]);
      for (const s of [1, -1]) {
        h.torus(shade(hx, 0.55), 0.018, 0.008, [s * 0.112, 0.14, -0.075], [0, s * 0.9, 0], 1, 4, 10);
        h.ball(hx, [0.036, 0.11, 0.038], [s * 0.14, 0.05, -0.09], [0.15, 0, s * 0.28], undefined, 8, 6);
      }
      break;
    case 'spacebuns':
      scalp(0.013, 1.6, 0.45);
      fringe([0, 0.214, 0.072], [0.09, 0.026, 0.045], [0.55, 0, 0]);
      if (crown) {
        for (const s of [1, -1]) {
          h.ico(hx, 0.052, [s * 0.078, 0.25, -0.03], [s, 0.5, 0], 1, 1);
          h.torus(shade(hx, 0.6), 0.03, 0.008, [s * 0.07, 0.218, -0.025], [Math.PI / 2 - 0.2, 0, -s * 0.5], 1, 4, 10);
        }
      }
      break;
    case 'messybun':
      scalp(0.015, 1.58, 0.5);
      // A loose bun at the back of the head, strands escaping it and framing the face.
      h.put(crumple(new THREE.IcosahedronGeometry(0.058, 1), 0.01), hx, [0, 0.2, -0.15], [0.4, 0.3, 0], [1, 0.85, 0.95]);
      for (let i = 0; i < 4; i++) {
        const t = i * 1.6;
        h.putAlong(new THREE.ConeGeometry(0.012, 0.05, 4), hx, [Math.sin(t) * 0.04, 0.215 + Math.cos(t) * 0.03, -0.17], new THREE.Vector3(Math.sin(t), Math.cos(t) + 0.3, -0.6));
      }
      for (const s of [1, -1]) h.ball(hx, [0.007, 0.05, 0.01], [s * 0.106, 0.115, 0.06], [0.1, 0, s * 0.1], undefined, 6, 5);
      fringe([0.02, 0.222, 0.066], [0.085, 0.026, 0.045], [0.5, 0, -0.2]);
      break;
    case 'swept':
      // Short at the sides, the top grown out and pushed back off the forehead in a few thick locks.
      scalp(0.012, 1.55, 0.5);
      fringe([0.014, 0.246, 0.05], [0.09, 0.034, 0.07], [0.32, 0, -0.16]);
      fringe([-0.012, 0.256, -0.02], [0.1, 0.036, 0.085], [0.02, 0.2, 0.08]);
      fringe([-0.07, 0.222, 0.052], [0.042, 0.03, 0.06], [0.4, 0, 0.42]);
      fringe([0.07, 0.226, 0.03], [0.04, 0.03, 0.075], [0.25, 0, -0.5]);
      fringe([0, 0.215, -0.085], [0.095, 0.06, 0.055], [-0.35, 0, 0]);
      break;
    case 'crew':
      // Clipped close all over, a little longer on top. The top stands well clear of the
      // clipped layer: two caps of different facets a few millimetres apart cut through each other.
      scalp(0.006, 1.48, 0.5, shaved);
      if (scalpOk) h.cap(hx, [0.117 + 0.017, 0.14 + 0.017, 0.13 + 0.017], 0, 0.98, [0, 0.12, 0], O, { w: 12, h: 3 });
      break;
    case 'hightight':
      // Shaved to a shadow at the sides and back, a short flat patch left on top.
      scalp(0.005, 1.45, 0.5, mixHex(hx, b.skin, 0.66));
      if (scalpOk) h.cap(hx, [0.117 + 0.016, 0.14 + 0.016, 0.13 + 0.016], 0, 0.8, [0, 0.12, 0], [0.18, 0, 0], { w: 12, h: 3 });
      break;
    case 'afropuffs':
      scalp(0.018, 1.6, 0.45);
      if (crown) {
        for (const s of [1, -1]) {
          h.ico(hx, 0.088, [s * 0.112, 0.245, -0.035], [s, 0.4, 0.2], [1, 0.95, 0.95], 2);
          h.torus(shade(hx, 0.55), 0.045, 0.009, [s * 0.085, 0.2, -0.03], [Math.PI / 2 - 0.2, 0, -s * 0.75], 1, 4, 12);
        }
      }
      break;
    case 'boxbraids': {
      scalp(0.014, 1.6, 0.5);
      // Thin braids falling from the hairline round the back and sides, longest at the back.
      for (let i = 0; i < 17; i++) {
        const phi = 1.4 + (i / 16) * (TAU - 2.8);
        const sx = Math.sin(phi), cz = Math.cos(phi);
        const back = Math.max(0, -cz);
        const len = 0.2 + back * 0.17;
        const x = sx * 0.128, z = cz * 0.142 - 0.006;
        h.cyl(hx, 0.009, 0.007, len, [x, 0.13 - len / 2, z], [cz * 0.05, 0, -sx * 0.05], 1, { seg: 5 });
        h.ball(shade(hx, 0.7), 0.009, [x, 0.13 - len, z], O, undefined, 5, 4);
      }
      fringe([0, 0.216, 0.07], [0.085, 0.024, 0.042], [0.55, 0, 0]);
      break;
    }
  }
}

/** The long fall of hair down the back (long styles), `len` down from the crown. */
function longBack(h: Kit, hx: number, len: number): void {
  h.ball(hx, [0.118, len, 0.062], [0, 0.23 - len, -0.09], [0.12, 0, 0], undefined, 12, 7);
}

/**
 * Facial hair grown off the face's own surface (HeadSculpt.faceLayer), so it follows the jaw and
 * chin whatever their shape and leaves the lips showing. Stubble is painted into the skin (facePaint).
 */
export function beard(h: Kit, a: Appearance, b: Body, hx: number): void {
  if (b.zombie && a.facialHair !== 'beard') return;
  const f = b.face;
  // Above the upper lip, out to just past the corners of the mouth, parted under the nose.
  const stache = (x: number, y: number, thick: number) =>
    thick * (1 - sstep(Math.abs(x), 0.027, 0.037)) * sstep(y, 0.066, 0.0695) * (1 - sstep(y, 0.0775, 0.083)) * (0.72 + 0.28 * sstep(Math.abs(x), 0.002, 0.009)) || -1;
  const grow = (lift: (x: number, y: number, a: number) => number) => h.put(faceLayer(f, lift), hx);
  switch (a.facialHair) {
    case 'mustache':
      grow((x, y) => stache(x, y, 0.0062));
      break;
    case 'handlebar':
      grow((x, y) => stache(x, y, 0.0055));
      for (const s of [1, -1]) h.cone(hx, 0.0055, 0.03, [s * 0.041, 0.079, faceZ(f, 0.041, 0.076) + 0.003], [0, 0, -s * 0.9]);
      break;
    case 'goatee':
      grow((x, y) => Math.max(stache(x, y, 0.0045), 0.0075 * (1 - sstep(Math.abs(x), 0.019, 0.029)) * (1 - sstep(y, 0.036, 0.0465)) || -1));
      break;
    case 'beard':
      grow((x, y, an) => {
        const k = beardK(x, y, an);
        return k > 0.02 ? k * (0.0045 + 0.0105 * sstep(0.075 - y, 0, 0.07)) : -1;
      });
      break;
    case 'chops':
      grow((x, y, an) => {
        const aa = Math.abs(an);
        const k = sstep(aa, 0.62, 0.8) * (1 - sstep(aa, 1.45, 1.62)) * sstep(y, 0.012, 0.03) * (1 - sstep(y, 0.118, 0.132));
        return Math.max(stache(x, y, 0.0045), k > 0.02 ? k * 0.0085 : -1);
      });
      break;
  }
}

// ── Headwear ────────────────────────────────────────────────────────────────────────────

export function headwear(h: Kit, a: Appearance, hex: number): void {
  const dome = (k: Kit, color: number, inf: number, theta: number, surf?: Surface) => k.cap(color, domeR(inf), 0, theta, O, O, { w: 12, h: 5 }, surf);
  /** Frame at the dome center tilted so the front rim rides higher than the back. */
  const frame = (tilt: number) => h.at(DOME_C, [-tilt, 0, 0]);
  const rim = (inf: number, theta: number): { y: number; rx: number; rz: number } => {
    const R = domeR(inf);
    return { y: Math.cos(theta) * R[1], rx: Math.sin(theta) * R[0], rz: Math.sin(theta) * R[2] };
  };
  const dark = shade(hex, 0.55);
  switch (a.headwear) {
    case 'none':
      break;
    case 'cap':
    case 'capback': {
      const f = h.at([0, 0, 0], [0, a.headwear === 'capback' ? Math.PI : 0, 0]).at(DOME_C, [-0.3, 0, 0]);
      dome(f, hex, 0.02, 1.38);
      const rr = rim(0.02, 1.38);
      f.cyl(hex, 0.105, 0.105, 0.012, [0, rr.y + 0.004, rr.rz - 0.012], [0.32, 0, 0], [1, 1, 0.85], { seg: 12, t0: -Math.PI / 2, tl: Math.PI });
      f.ball(dark, 0.012, [0, domeR(0.02)[1], 0], O, undefined, 6, 4);
      break;
    }
    case 'beanie':
    case 'pombeanie': {
      // Pulled down to just over the brows in front, to the nape behind.
      const f = frame(0.32);
      dome(f, hex, 0.019, 1.62, { pattern: PATTERN.knit });
      const rr = rim(0.019, 1.62);
      f.cyl(hex, rr.rx + 0.008, rr.rx + 0.01, 0.045, [0, rr.y + 0.02, 0], O, [1, 1, rr.rz / rr.rx], { seg: 18 }, { pattern: PATTERN.knit });
      if (a.headwear === 'pombeanie') f.ico(mixHex(hex, 0xf2efe8, 0.6), 0.042, [0, domeR(0.019)[1] + 0.02, 0], O, 1, 1);
      break;
    }
    case 'bucket':
      h.cyl(hex, 0.112, 0.13, 0.1, [0, 0.235, -0.005], O, [1, 1, 1.08], { seg: 16 });
      h.cyl(hex, 0.135, 0.205, 0.035, [0, 0.175, -0.005], O, [1, 1, 1.05], { seg: 18 });
      h.cyl(dark, 0.131, 0.131, 0.018, [0, 0.198, -0.005], O, [1, 1, 1.08], { seg: 16 });
      break;
    case 'cowboy':
      h.cyl(hex, 0.1, 0.122, 0.13, [0, 0.26, -0.005], O, [1, 1, 1.18], { seg: 16 });
      h.box(shade(hex, 0.8), [0.03, 0.02, 0.2], [0, 0.325, -0.005]);
      h.cyl(0x2a1d14, 0.123, 0.123, 0.024, [0, 0.21, -0.005], O, [1, 1, 1.18], { seg: 16 });
      // Brim halves tilted up at the sides: the curl of a cowboy brim.
      for (const s of [1, -1]) h.cyl(hex, 0.27, 0.27, 0.014, [0, 0.2, -0.01], [0, 0, s * 0.2], [1, 1, 0.86], { seg: 12, t0: s > 0 ? 0 : Math.PI, tl: Math.PI });
      break;
    case 'fedora':
      h.cyl(hex, 0.102, 0.122, 0.12, [0, 0.255, -0.005], O, [1, 1, 1.12], { seg: 16 });
      h.box(shade(hex, 0.8), [0.025, 0.018, 0.17], [0, 0.315, 0]);
      h.cyl(0x1b1b1d, 0.123, 0.123, 0.026, [0, 0.21, -0.005], O, [1, 1, 1.12], { seg: 16 });
      h.cyl(hex, 0.19, 0.19, 0.012, [0, 0.198, 0.0], [0.12, 0, 0], [1, 1, 0.92], { seg: 20 });
      break;
    case 'flatcap': {
      const f = frame(0.3);
      f.cap(hex, [0.14, 0.11, 0.165], 0, 1.4, [0, 0.02, 0.012], O, { w: 18, h: 7 });
      f.cyl(dark, 0.09, 0.09, 0.01, [0, 0.03, 0.15], [0.22, 0, 0], [1, 1, 0.55], { seg: 12, t0: -Math.PI / 2, tl: Math.PI });
      break;
    }
    case 'bandana': {
      const f = frame(0.4);
      dome(f, hex, 0.01, 1.45, { pattern: PATTERN.floral, accent: 0xe8e2d6 });
      h.ico(hex, 0.022, [0, 0.12, -0.15], O, 1, 1, { pattern: PATTERN.floral, accent: 0xe8e2d6 });
      for (const s of [1, -1]) h.box(hex, [0.03, 0.08, 0.008], [s * 0.02, 0.07, -0.152], [-0.2, 0, s * 0.25], { pattern: PATTERN.floral, accent: 0xe8e2d6 });
      break;
    }
    case 'sweatband':
      h.cyl(hex, 0.127, 0.129, 0.034, [0, 0.19, -0.004], O, [0.97, 1, 1.06], { seg: 18 }, { pattern: PATTERN.knit });
      break;
    case 'hardhat': {
      const f = frame(0.12);
      dome(f, hex, 0.032, Math.PI / 2);
      const R = domeR(0.032);
      f.cyl(hex, R[0] + 0.02, R[0] + 0.035, 0.014, [0, 0.0, 0.015], O, [1, 1, 1.18], { seg: 20 });
      f.box(shade(hex, 0.9), [0.03, 0.02, 0.24], [0, R[1] - 0.004, 0]);
      break;
    }
    case 'army': {
      const f = frame(0.3);
      dome(f, hex, 0.035, 1.6, { pattern: PATTERN.camo, accent: shade(hex, 0.7) });
      const rr = rim(0.035, 1.6);
      f.cyl(shade(hex, 0.85), rr.rx + 0.02, rr.rx + 0.028, 0.016, [0, rr.y, 0], O, [1, 1, rr.rz / rr.rx], { seg: 20 });
      h.torus(0x3a3226, 0.1, 0.004, [0, 0.06, 0.0], [0, Math.PI / 2, 0], [1, 1.1, 1], 3, 12, Math.PI);
      break;
    }
    case 'moto':
      h.ball(hex, [0.16, 0.172, 0.172], [0, 0.12, -0.008], O, undefined, 18, 12);
      h.front(0x0e1116, [0.166, 0.178, 0.178], 1.15, 0.75, 2.1, [0, 0.12, -0.008], O, undefined, 14, 4);
      h.box(dark, [0.2, 0.012, 0.03], [0, 0.04, 0.15], [0.2, 0, 0]);
      break;
    case 'football': {
      // The shell's edge is at the brow in front and down over the ears and the nape.
      const f = frame(0.47);
      dome(f, hex, 0.04, 1.8);
      const R = domeR(0.04);
      f.box(0xe8e6e0, [0.03, 0.01, 0.3], [0, R[1], 0], [0, 0, 0]);
      for (const y of [0.04, 0.085]) h.torus(0x9a9ca0, 0.115, 0.0055, [0, y, 0.035], [Math.PI / 2, 0, 0], [1.05, 1, 1.15], 4, 12, Math.PI);
      h.cyl(0x9a9ca0, 0.006, 0.006, 0.07, [0, 0.07, 0.165]);
      for (const s of [1, -1]) h.cyl(shade(hex, 0.8), 0.04, 0.04, 0.02, [s * 0.15, 0.1, 0.0], [0, 0, Math.PI / 2], 1, { seg: 10 });
      break;
    }
    case 'bike': {
      const f = frame(0.25);
      f.cap(hex, [0.15, 0.17, 0.19], 0, 1.35, [0, 0, -0.02], O, { w: 18, h: 7 });
      for (const x of [-0.05, 0, 0.05]) f.box(shade(hex, 0.55), [0.018, 0.008, 0.16], [x, 0.165, -0.02]);
      f.box(0x16181b, [0.16, 0.01, 0.04], [0, 0.05, 0.17], [0.4, 0, 0]);
      h.torus(0x1b1d20, 0.1, 0.003, [0, 0.06, 0], [0, Math.PI / 2, 0], [1, 1.1, 1], 3, 12, Math.PI);
      break;
    }
    case 'fire': {
      const f = frame(0.1);
      dome(f, hex, 0.035, 1.5);
      f.cyl(hex, 0.2, 0.21, 0.014, [0, 0.01, -0.06], [-0.08, 0, 0], [1, 1, 1.25], { seg: 22 });
      f.box(shade(hex, 0.85), [0.035, 0.03, 0.3], [0, domeR(0.035)[1] - 0.005, -0.02]);
      f.box(0xc9a233, [0.07, 0.085, 0.012], [0, 0.11, 0.155], [-0.35, 0, 0]);
      break;
    }
    case 'knight':
      h.cyl(0x8c9096, 0.148, 0.152, 0.27, [0, 0.12, -0.005], O, [1, 1, 1.02], { seg: 16 });
      h.cap(0x8c9096, [0.148, 0.05, 0.151], 0, Math.PI / 2, [0, 0.255, -0.005], O, { w: 16, h: 4 });
      h.box(0x0a0a0b, [0.2, 0.016, 0.02], [0, 0.145, 0.146]);
      h.box(0x6d7177, [0.014, 0.17, 0.012], [0, 0.07, 0.152]);
      for (let i = 0; i < 6; i++) h.cyl(0x0a0a0b, 0.0045, 0.0045, 0.01, [(i % 3 - 1) * 0.03 + 0.06, 0.07 - Math.floor(i / 3) * 0.025, 0.148], [Math.PI / 2, 0, 0], 1, { seg: 5 });
      break;
    case 'cone':
      h.at([0.01, 0, 0], [0, 0, -0.12]).cyl(0xe2561c, 0.018, 0.13, 0.38, [0, 0.44, 0], O, 1, { seg: 14 });
      h.at([0.01, 0, 0], [0, 0, -0.12]).cyl(0xf2f0ea, 0.064, 0.082, 0.05, [0, 0.48, 0], O, 1.02, { seg: 14, open: true });
      h.at([0.01, 0, 0], [0, 0, -0.12]).cyl(0xf2f0ea, 0.035, 0.05, 0.04, [0, 0.57, 0], O, 1.02, { seg: 14, open: true });
      h.at([0.01, 0, 0], [0, 0, -0.12]).box(0x1d1d1f, [0.27, 0.025, 0.27], [0, 0.255, 0]);
      break;
    case 'party':
      h.at([0.03, 0, 0], [0.05, 0, -0.22]).cone(hex, 0.075, 0.21, [0, 0.36, 0], O, 1, 12, { pattern: PATTERN.stripes, accent: 0xf2efe6 });
      h.at([0.03, 0, 0], [0.05, 0, -0.22]).ico(0xf2c81c, 0.022, [0, 0.47, 0], O, 1, 1);
      h.torus(0xd8d6d0, 0.1, 0.002, [0, 0.07, 0.0], [0, Math.PI / 2, 0], [1, 1.25, 1], 3, 12, Math.PI);
      break;
    case 'propeller': {
      const f = frame(0.25);
      const colors = [hex, 0xf2c81c, hex, 0x2b4f9e];
      for (let i = 0; i < 4; i++) f.cap(colors[i], domeR(0.018), 0, 1.4, O, O, { p0: i * Math.PI / 2, pl: Math.PI / 2, w: 5, h: 7 });
      const top = domeR(0.018)[1];
      f.cyl(0x9a9ca0, 0.006, 0.006, 0.05, [0, top + 0.02, 0]);
      f.box(0xd21f1f, [0.24, 0.006, 0.035], [0, top + 0.046, 0], [0.12, 0.5, 0]);
      f.box(0x2b4f9e, [0.24, 0.006, 0.035], [0, top + 0.046, 0], [-0.12, 0.5 + Math.PI / 2, 0]);
      f.cyl(0x1d1d1f, 0.09, 0.09, 0.01, [0, 0.03, 0.12], [0.22, 0, 0], [1, 1, 0.5], { seg: 12, t0: -Math.PI / 2, tl: Math.PI });
      break;
    }
    case 'chef':
      h.cyl(0xf3f1ec, 0.123, 0.12, 0.16, [0, 0.27, -0.005], O, [1, 1, 1.08], { seg: 16 });
      for (let i = 0; i < 6; i++) {
        const t = (i / 6) * TAU;
        h.ico(0xf3f1ec, 0.07, [Math.sin(t) * 0.07, 0.37, Math.cos(t) * 0.07 - 0.005], [i, 0, 0], 1, 1);
      }
      h.ico(0xf3f1ec, 0.08, [0, 0.39, -0.005], O, 1, 1);
      h.cyl(0xe2ded5, 0.127, 0.127, 0.035, [0, 0.205, -0.005], O, [1, 1, 1.08], { seg: 16 });
      break;
    case 'tophat':
      h.cyl(hex, 0.1, 0.098, 0.22, [0, 0.355, -0.005], O, [1, 1, 1.12], { seg: 16 });
      h.cyl(0x8e1f22, 0.102, 0.102, 0.034, [0, 0.265, -0.005], O, [1, 1, 1.12], { seg: 16 });
      h.cyl(hex, 0.17, 0.17, 0.012, [0, 0.245, -0.005], O, [1, 1, 1.0], { seg: 20 });
      break;
    case 'viking': {
      const f = frame(0.1);
      dome(f, 0x8d9197, 0.03, 1.6);
      const rr = rim(0.03, 1.6);
      f.cyl(0x5a3e2a, rr.rx + 0.012, rr.rx + 0.012, 0.03, [0, rr.y + 0.012, 0], O, [1, 1, rr.rz / rr.rx], { seg: 20 });
      f.box(0x6d7177, [0.03, 0.18, 0.012], [0, 0.11, 0.12], [-0.6, 0, 0]);
      for (const s of [1, -1]) {
        f.put(new THREE.ConeGeometry(0.028, 0.1, 8), 0xe8dcc0, [s * 0.16, 0.06, 0], [0, 0, -s * 1.1]);
        f.put(new THREE.ConeGeometry(0.018, 0.08, 8), 0xe8dcc0, [s * 0.215, 0.13, 0], [0, 0, -s * 0.3]);
      }
      break;
    }
    case 'pot':
      h.cyl(0xa7abb0, 0.15, 0.138, 0.14, [0, 0.245, -0.005], O, [1, 1, 1.04], { seg: 18 });
      h.cyl(0xb8bcc2, 0.158, 0.158, 0.014, [0, 0.18, -0.005], O, [1, 1, 1.04], { seg: 18 });
      h.box(0x18191b, [0.2, 0.022, 0.04], [0.24, 0.2, -0.005], [0, 0, 0.1]);
      h.cyl(0x18191b, 0.02, 0.02, 0.03, [0, 0.325, -0.005]);
      break;
    case 'foil':
      h.put(crumple(new THREE.ConeGeometry(0.14, 0.24, 7, 3), 0.012), 0xc8cdd2, [0, 0.31, -0.005], [0.06, 0, 0.04], [1, 1, 1.05]);
      break;
    case 'crown':
      h.tube(0xd3a628, 0.11, 0.115, 0.06, [0, 0.245, -0.005], O, [1, 1, 1.08], 12);
      for (let i = 0; i < 8; i++) {
        const t = (i / 8) * TAU;
        h.cone(0xd3a628, 0.02, 0.055, [Math.sin(t) * 0.108, 0.3, Math.cos(t) * 0.116 - 0.005], [Math.cos(t) * -0.15, 0, Math.sin(t) * 0.15], 1, 4);
        h.ball(i % 2 ? 0x2b4f9e : 0xb01e2a, 0.011, [Math.sin(t) * 0.118, 0.245, Math.cos(t) * 0.126 - 0.005], O, undefined, 6, 4);
      }
      break;
    case 'bunny':
      h.torus(hex, 0.13, 0.008, [0, 0.12, 0.02], O, [1, 1.12, 1], 4, 16, Math.PI);
      for (const s of [1, -1]) {
        h.ball(hex, [0.032, 0.12, 0.014], [s * 0.05, 0.39, 0.02], [0, 0, -s * 0.18], undefined, 10, 7);
        h.ball(0xe9a3b6, [0.018, 0.09, 0.006], [s * 0.05, 0.385, 0.031], [0, 0, -s * 0.18], undefined, 8, 6);
      }
      break;
    case 'pirate':
      h.cap(0x141416, domeR(0.02), 0, 1.4, DOME_C, [-0.15, 0, 0], { w: 16, h: 7 });
      h.cyl(0x141416, 0.25, 0.14, 0.075, [0, 0.245, 0], [0, 0, 0], [1, 1, 0.95], { seg: 3 });
      h.cyl(0xc9a233, 0.253, 0.253, 0.006, [0, 0.283, 0], O, [1, 1, 0.95], { seg: 3, open: true });
      h.ball(0xeeeae0, [0.022, 0.02, 0.008], [0, 0.24, 0.2], [0, 0, 0], undefined, 8, 5);
      for (const s of [1, -1]) h.box(0xeeeae0, [0.05, 0.007, 0.006], [0, 0.215, 0.205], [0, 0, s * 0.6]);
      break;
    case 'sombrero':
      h.cyl(hex, 0.4, 0.4, 0.016, [0, 0.205, -0.005], O, 1, { seg: 28 });
      h.tube(hex, 0.44, 0.4, 0.06, [0, 0.235, -0.005], O, [1, 1, 1], 28);
      h.cyl(hex, 0.06, 0.13, 0.2, [0, 0.31, -0.005], O, 1, { seg: 16 });
      h.cyl(0x8e1f22, 0.112, 0.126, 0.04, [0, 0.235, -0.005], O, 1.02, { seg: 16, open: true }, { pattern: PATTERN.stripes, accent: 0x2f8a4a });
      break;
    case 'duck':
      h.ico(0xf2c81c, 0.09, [0, 0.31, -0.02], O, [1, 0.72, 1.25], 1);
      h.ico(0xf2c81c, 0.056, [0, 0.4, 0.06], O, 1, 1);
      h.box(0xe0701c, [0.05, 0.014, 0.05], [0, 0.395, 0.12], [0.1, 0, 0]);
      for (const s of [1, -1]) h.ball(0x0a0a0a, 0.008, [s * 0.03, 0.415, 0.103], O, undefined, 5, 4);
      h.cone(0xf2c81c, 0.03, 0.06, [0, 0.35, -0.13], [-1.0, 0, 0], 1, 6);
      break;
    case 'lampshade':
      h.at([0.02, 0, 0], [0.08, 0, -0.16]).tube(hex, 0.095, 0.17, 0.19, [0, 0.33, 0], O, [1, 1, 1], 14);
      h.at([0.02, 0, 0], [0.08, 0, -0.16]).cyl(0xc9a233, 0.098, 0.098, 0.012, [0, 0.42, 0], O, 1, { seg: 14, open: true });
      break;
    case 'beret': {
      // A soft disc slouched over to one side, with the little stalk on top.
      const f = h.at([0.022, 0.228, -0.012], [-0.12, 0, -0.26]);
      f.ball(hex, [0.158, 0.052, 0.152], [0, 0.012, 0], O, undefined, 18, 8);
      f.cyl(shade(hex, 0.8), 0.118, 0.122, 0.022, [0, -0.025, 0], O, [1, 1, 1.05], { seg: 16 });
      f.cyl(shade(hex, 0.7), 0.006, 0.008, 0.024, [0, 0.07, 0]);
      break;
    }
    case 'sunhat': {
      const f = frame(0.12);
      dome(f, hex, 0.026, 1.45, { pattern: PATTERN.knit });
      // A wide, soft brim drooping at the edge, and a ribbon round the crown.
      h.cyl(hex, 0.25, 0.3, 0.016, [0, 0.188, -0.005], [0.06, 0, 0], [1, 1, 0.96], { seg: 24 }, { pattern: PATTERN.knit });
      h.cyl(0x1b1b1d, 0.141, 0.143, 0.026, [0, 0.21, -0.005], [0.06, 0, 0], [1, 1, 1.05], { seg: 18 });
      h.ico(0x1b1b1d, 0.016, [0.13, 0.205, -0.07], O, [0.6, 1, 1.4], 0);
      break;
    }
    case 'headband':
      h.torus(hex, 0.139, 0.0125, [0, 0.12, 0.035], [-0.28, 0, 0], [1, 1.12, 1.25], 4, 18, Math.PI);
      break;
    case 'hairbow': {
      // A big bow on the top of the head, off to one side.
      const f = h.at([0.07, 0.262, -0.035], [0.25, 0.35, -0.42]);
      for (const s of [1, -1]) f.cone(hex, 0.045, 0.07, [s * 0.038, 0, 0], [0, 0, s * Math.PI / 2], [1, 1, 0.5], 6);
      f.ico(shade(hex, 0.8), 0.019, O, O, [1, 1, 0.75], 1);
      for (const s of [1, -1]) f.box(hex, [0.02, 0.055, 0.006], [s * 0.014, -0.034, -0.006], [0, 0, s * 0.35]);
      break;
    }
    case 'clips':
      // Three snap clips in a row above the temple, holding the hair back.
      for (let i = 0; i < 3; i++) {
        const t = 0.62 + i * 0.2;
        h.box(i === 1 ? shade(hex, 0.8) : hex, [0.01, 0.014, 0.05], [Math.sin(t) * 0.148, 0.125 + Math.cos(t) * 0.16, 0.05 - i * 0.004], [0.25, 0, -t]);
      }
      break;
    case 'flowercrown': {
      // A green vine round the head with flowers and leaves woven in.
      h.torus(0x3d6a34, 0.135, 0.007, [0, 0.215, -0.012], [Math.PI / 2 - 0.25, 0, 0], [1, 1.07, 1], 4, 22);
      const petals = [0xf2efe8, 0xe9a3c0, 0xf2c81c, 0xb59ad8, 0xe9a3c0, 0xf2efe8, 0xd8669c, 0xf2c81c];
      for (let i = 0; i < 10; i++) {
        const t = (i / 10) * TAU + 0.3;
        const x = Math.sin(t) * 0.137, z = Math.cos(t) * 0.147 - 0.012;
        const y = 0.215 + Math.cos(t) * 0.035;
        h.ico(petals[i % petals.length], 0.019, [x, y, z], [i, i * 2, 0], [1, 0.7, 1], 0);
        h.ball(0xe0b030, 0.007, [x * 1.08, y + 0.004, z * 1.08], O, undefined, 5, 4);
        h.ball(0x4f7d3c, [0.016, 0.004, 0.008], [Math.sin(t + 0.3) * 0.14, y - 0.008, Math.cos(t + 0.3) * 0.15 - 0.012], [0, t, 0.4], undefined, 6, 3);
      }
      break;
    }
    case 'tiara': {
      // A gold band across the front of the crown, peaks rising to a jewel in the middle.
      const f = h.at([0, 0.245, -0.01], [0.25, 0, 0]);
      const arc = 2.1;
      f.torus(0xd3a628, 1, 0.006, O, [-Math.PI / 2, 0, -Math.PI / 2 - arc / 2], [0.142, 0.155, 1], 3, 18, arc);
      for (let i = -3; i <= 3; i++) {
        const phi = i * 0.27;
        const x = Math.sin(phi) * 0.142, z = Math.cos(phi) * 0.155;
        const hgt = i === 0 ? 0.055 : Math.abs(i) === 2 ? 0.038 : 0.026;
        f.put(new THREE.ConeGeometry(0.013, hgt, 3), 0xd3a628, [x, hgt / 2, z], [0, phi, 0], [1, 1, 0.35]);
        f.ico(i === 0 ? 0xb01e2a : 0xe8f2ff, i === 0 ? 0.01 : 0.0055, [x * 1.04, 0.012, z * 1.04], O, 1, 0);
      }
      break;
    }
    case 'catears':
      h.torus(hex, 0.134, 0.007, [0, 0.12, 0.015], [-0.12, 0, 0], [1, 1.13, 1], 4, 16, Math.PI);
      for (const s of [1, -1]) {
        h.cone(hex, 0.04, 0.07, [s * 0.075, 0.278, 0.0], [0, 0, -s * 0.38], [1, 1, 0.4], 3);
        h.cone(0xe9a3b6, 0.024, 0.042, [s * 0.075, 0.272, 0.009], [0, 0, -s * 0.38], [1, 1, 0.25], 3);
      }
      break;
    case 'witch': {
      // Wide brim, a tall cone that bends over near the tip, and an orange band.
      h.cyl(hex, 0.3, 0.3, 0.012, [0, 0.2, -0.005], [0.05, 0, 0], 1, { seg: 26 });
      h.cyl(hex, 0.085, 0.135, 0.17, [0, 0.29, -0.01], [0.05, 0, 0], [1, 1, 1.05], { seg: 16 });
      h.at([0, 0.37, -0.02], [-0.25, 0, 0.12]).cone(hex, 0.088, 0.2, [0, 0.09, 0], O, 1, 14);
      h.at([0, 0.37, -0.02], [-0.25, 0, 0.12]).at([0, 0.17, 0], [-0.5, 0, 0.3]).cone(hex, 0.035, 0.1, [0, 0.045, 0], O, 1, 10);
      h.cyl(0xe2701c, 0.138, 0.138, 0.032, [0, 0.225, -0.005], [0.05, 0, 0], [1, 1, 1.05], { seg: 16 });
      h.box(0xd3a628, [0.034, 0.03, 0.008], [0, 0.225, 0.14], [0.05, 0, 0]);
      break;
    }
    case 'combat':
    case 'gogglehelmet': {
      // The issue helmet in its cloth cover: down over the ears, a bracket for night vision on
      // the brow, the band round it; one wears goggles pushed up on the shell.
      const f = frame(0.3);
      const cam: Surface = { pattern: PATTERN.camo, accent: camoOf(hex) };
      dome(f, hex, 0.036, 1.62, cam);
      const R = domeR(0.036), rr = rim(0.036, 1.62);
      f.cyl(shade(hex, 0.78), rr.rx + 0.004, rr.rx + 0.004, 0.016, [0, rr.y + 0.004, 0], O, [1, 1, rr.rz / rr.rx], { seg: 12 });
      onDome(f, R, 1.3, 0x2b2d31, [0.042, 0.036, 0.012], 0.004);
      const by = Math.cos(1.46) * R[1], bs = Math.sin(1.46);
      f.cyl(shade(hex, 0.62), R[0] * bs + 0.003, R[0] * bs + 0.003, 0.02, [0, by, 0], O, [1, 1, R[2] / R[0]], { seg: 12, open: true });
      for (const s of [1, -1]) f.box(0xc8d0a8, [0.012, 0.012, 0.004], [s * 0.022, by, -R[2] * bs - 0.004]);
      h.torus(0x3a3226, 0.1, 0.004, [0, 0.06, 0.0], [0, Math.PI / 2, 0], [1, 1.1, 1], 3, 12, Math.PI);
      if (a.headwear === 'gogglehelmet') {
        const gy = Math.cos(1.16) * R[1], gs = Math.sin(1.16);
        f.cyl(0x18191b, R[0] * gs + 0.004, R[0] * gs + 0.004, 0.026, [0, gy, 0], O, [1, 1, R[2] / R[0]], { seg: 12, open: true });
        onDome(f, R, 1.16, 0x1d1e20, [0.15, 0.056, 0.03], 0.008);
        onDome(f, R, 1.16, 0x8a6a2a, [0.13, 0.04, 0.006], 0.026);
      }
      break;
    }
    case 'opshelmet':
    case 'nvghelmet': {
      // A high-cut helmet: bare shell cut away over the ears for a headset, rails down the
      // sides, loop panels on top, a shroud on the brow; one carries night vision tipped up.
      const f = frame(0.08);
      dome(f, hex, 0.034, 1.4);
      const R = domeR(0.034);
      f.cap(hex, R, 1.4, 0.36, O, O, { p0: Math.PI * 1.5 - 0.95, pl: 1.9, w: 5, h: 1 });
      for (const s of [1, -1]) {
        f.box(0x1d1e20, [0.012, 0.024, 0.12], [s * (R[0] * Math.sin(1.28) + 0.002), R[1] * Math.cos(1.28), -0.004], [0, 0, 0]);
        f.box(shade(hex, 0.72), [0.008, 0.05, 0.07], [s * (R[0] * Math.sin(0.85) + 0.001), R[1] * Math.cos(0.85), -0.01], [0, 0, -s * 0.62]);
      }
      f.box(shade(hex, 0.72), [0.07, 0.008, 0.1], [0, R[1] + 0.001, -0.012]);
      onDome(f, R, 1.1, 0x1d1e20, [0.046, 0.042, 0.014], 0.004);
      headset(h, 0x2b2d31);
      h.torus(0x1d1e20, 0.1, 0.004, [0, 0.06, 0.0], [0, Math.PI / 2, 0], [1, 1.1, 1], 3, 12, Math.PI);
      if (a.headwear === 'nvghelmet') {
        // The arm up from the shroud, and the two tubes resting above the brow.
        onDome(f, R, 0.9, 0x1d1e20, [0.022, 0.07, 0.03], 0.016);
        for (const s of [1, -1]) {
          const t = f.at([s * 0.03, R[1] * Math.cos(0.8) + 0.03, R[2] * Math.sin(0.8) + 0.045], [-0.38, 0, 0]);
          t.cyl(0x23262a, 0.019, 0.022, 0.085, O, [Math.PI / 2, 0, 0], 1, { seg: 8 });
          t.cyl(0x3f6a52, 0.015, 0.015, 0.004, [0, 0, 0.044], [Math.PI / 2, 0, 0], 1, { seg: 8 });
        }
        f.box(0x1d1e20, [0.085, 0.024, 0.03], [0, R[1] * Math.cos(0.8) + 0.03, R[2] * Math.sin(0.8) + 0.02], [-0.38, 0, 0]);
      }
      break;
    }
    case 'boonie': {
      // A soft, flat-topped crown, a wide stitched brim that droops, loops round the band.
      const cam: Surface = { pattern: PATTERN.camo, accent: camoOf(hex) };
      h.cyl(hex, 0.116, 0.128, 0.075, [0, 0.234, -0.005], O, [1, 1, 1.08], { seg: 10 }, cam);
      h.cyl(hex, 0.15, 0.225, 0.03, [0, 0.186, -0.005], [0.05, 0, 0], [1, 1, 1.04], { seg: 12 }, cam);
      h.cyl(shade(hex, 0.7), 0.131, 0.131, 0.018, [0, 0.208, -0.005], O, [1, 1, 1.08], { seg: 10 });
      break;
    }
    case 'patrolcap': {
      // A flat-topped field cap, stiff at the front, a short bill, rank in the middle.
      const cam: Surface = { pattern: PATTERN.camo, accent: camoOf(hex) };
      h.cyl(hex, 0.12, 0.126, 0.08, [0, 0.232, -0.006], [-0.07, 0, 0], [1, 1, 1.1], { seg: 10 }, cam);
      h.cyl(hex, 0.105, 0.105, 0.012, [0, 0.196, 0.118], [0.3, 0, 0], [1, 1, 0.82], { seg: 8, t0: -Math.PI / 2, tl: Math.PI }, cam);
      h.box(0x23251f, [0.02, 0.022, 0.004], [0, 0.238, 0.137], [-0.07, 0, 0]);
      break;
    }
    case 'marinecover': {
      // The eight-pointed utility cover: an octagon crown wider at the top, the emblem in front.
      const dig: Surface = { pattern: PATTERN.digital, accent: camoOf(hex) };
      h.cyl(hex, 0.134, 0.122, 0.078, [0, 0.232, -0.006], [-0.07, Math.PI / 8, 0], [1, 1, 1.08], { seg: 8 }, dig);
      h.cyl(hex, 0.105, 0.105, 0.012, [0, 0.196, 0.118], [0.3, 0, 0], [1, 1, 0.82], { seg: 8, t0: -Math.PI / 2, tl: Math.PI }, dig);
      h.box(0x1c1d18, [0.024, 0.024, 0.004], [0, 0.238, 0.14], [-0.1, 0, 0]);
      break;
    }
    case 'opscap': {
      // A ball cap with a loop patch on the front, worn under a headset.
      const f = h.at(DOME_C, [-0.3, 0, 0]);
      dome(f, hex, 0.02, 1.38);
      const rr = rim(0.02, 1.38);
      f.cyl(hex, 0.105, 0.105, 0.012, [0, rr.y + 0.004, rr.rz - 0.012], [0.32, 0, 0], [1, 1, 0.85], { seg: 8, t0: -Math.PI / 2, tl: Math.PI });
      onDome(f, domeR(0.02), 0.95, shade(hex, 0.66), [0.06, 0.036, 0.006], 0.001);
      h.torus(0x2b2d31, 0.129, 0.007, [0, 0.118, -0.008], [0, 0, 0], [1, 1.25, 1], 3, 8, Math.PI);
      headset(h, 0x2b2d31);
      break;
    }
    case 'santa': {
      // A soft cone that rises off the fur brim and flops over behind one ear, a white pom-pom on the tip.
      const fur = 0xefebe3;
      const f = frame(0.16);
      dome(f, hex, 0.02, 1.5);
      const rr = rim(0.02, 1.5);
      const path = [[0, rr.y + 0.01, 0], [0, 0.12, -0.012], [-0.012, 0.215, -0.045], [-0.035, 0.265, -0.1], [-0.065, 0.255, -0.16], [-0.088, 0.2, -0.188]] as const;
      f.put(taperTube(path, rr.rx + 0.002, 0.016), hex, O, O, [1, 1, rr.rz / rr.rx]);
      f.put(crumple(new THREE.TorusGeometry(rr.rx + 0.006, 0.022, 8, 24), 0.004), fur, [0, rr.y + 0.012, 0], [Math.PI / 2, 0, 0], [1, rr.rz / rr.rx, 0.95]);
      const tip = path[path.length - 1];
      f.put(crumple(new THREE.IcosahedronGeometry(0.038, 2), 0.005), fur, [tip[0], tip[1] - 0.012, tip[2] * rr.rz / rr.rx]);
      break;
    }
  }
}

/** The second color of issue camouflage (as on the uniforms). */
const camoOf = (hex: number) => {
  const l = luminance(hex);
  // Black kit keeps its shapes quiet; a dark green ground gets coyote, a light one brown-green.
  return l > 0.42 ? mixHex(hex, 0x4a5232, 0.62) : l < 0.2 ? mixHex(hex, 0x5a5d60, 0.38) : mixHex(hex, 0x94845c, 0.55);
};

/** A box lying on the front of a dome of radii R, `theta` down from its top, `out` off it. */
function onDome(f: Kit, R: V3, theta: number, hex: number, size: V3, out: number): void {
  f.box(hex, size, [0, Math.cos(theta) * (R[1] + out), Math.sin(theta) * (R[2] + out)], [theta - Math.PI / 2, 0, 0]);
}

/** Ear cups with a boom microphone round to the mouth. */
function headset(h: Kit, hex: number): void {
  for (const s of [1, -1]) {
    h.cyl(hex, 0.036, 0.036, 0.032, [s * 0.124, 0.113, -0.008], [0, 0, Math.PI / 2], [1, 1, 1.25], { seg: 8 });
    h.cyl(shade(hex, 0.6), 0.03, 0.03, 0.012, [s * 0.106, 0.113, -0.008], [0, 0, Math.PI / 2], [1, 1, 1.25], { seg: 8 });
  }
  h.box(0x18191b, [0.005, 0.005, 0.1], [0.108, 0.078, 0.055], [0.3, -0.42, 0]);
  h.box(0x18191b, [0.016, 0.012, 0.012], [0.082, 0.062, 0.105], [0.3, -0.42, 0]);
}

/** The arms of a pair of glasses: from the hinge at the lens's outer edge back over the ear. */
function temples(h: Kit, hex: number, y = 0.14): void {
  for (const s of [1, -1]) {
    // An end piece out past the lens to the hinge, so the arm clears the side of the head.
    h.box(hex, [0.024, 0.004, 0.004], [s * 0.08, y, 0.128]);
    h.box(hex, [0.004, 0.005, 0.135], [s * 0.105, y, 0.0615], [0, s * -0.196, 0]);
  }
}

/** Spectacles are built for eyes 84 mm apart on a flat face: this sets them over the eyes as sculpted, in front of the brow. */
const SPECS: [V3, V3, V3] = [[0, 0, -0.004], O, [EYE_X / 0.042, 1, 1]];

export function faceGear(head: Kit, a: Appearance, b: Body, hex: number): void {
  if (b.zombie && a.face !== 'surgical') return;
  const specs = a.face === 'glasses' || a.face === 'round' || a.face === 'sunglasses' || a.face === 'aviators' || a.face === 'cateye' || a.face === 'oversized' || a.face === 'heartglasses';
  const h = specs ? head.at(...SPECS) : head;
  switch (a.face) {
    case 'glasses':
      for (const s of [1, -1]) h.torus(hex, 0.0215, 0.0028, [s * 0.042, EYE_Y + 0.001, 0.134], [0, 0, Math.PI / 4], [1.2, 0.82, 1], 4, 4);
      h.box(hex, [0.022, 0.004, 0.004], [0, EYE_Y + 0.008, 0.136]);
      temples(h, hex);
      break;
    case 'round':
      for (const s of [1, -1]) h.torus(hex, 0.019, 0.0025, [s * 0.041, EYE_Y, 0.134], O, 1, 4, 14);
      h.torus(hex, 0.012, 0.0022, [0, EYE_Y + 0.004, 0.136], O, 1, 3, 8, Math.PI);
      temples(h, hex);
      break;
    case 'sunglasses':
      for (const s of [1, -1]) h.box(0x0c0e11, [0.044, 0.026, 0.006], [s * 0.042, EYE_Y - 0.002, 0.133], [0, s * 0.12, 0]);
      h.box(hex, [0.13, 0.008, 0.009], [0, EYE_Y + 0.013, 0.134]);
      temples(h, hex, EYE_Y + 0.01);
      break;
    case 'aviators':
      for (const s of [1, -1]) {
        h.ball(0x2c2418, [0.023, 0.02, 0.004], [s * 0.041, EYE_Y - 0.004, 0.133], [0, s * 0.12, s * -0.2], undefined, 12, 6);
        h.torus(0xc9a233, 0.022, 0.0018, [s * 0.041, EYE_Y - 0.004, 0.134], [0, s * 0.12, s * -0.2], [1.05, 0.95, 1], 3, 14);
      }
      h.box(0xc9a233, [0.03, 0.003, 0.003], [0, EYE_Y + 0.011, 0.136]);
      temples(h, 0xc9a233, EYE_Y + 0.008);
      break;
    case 'goggles':
      h.cyl(0x18191b, 0.14, 0.14, 0.03, [0, EYE_Y + 0.004, -0.004], O, [0.9, 1, 1.0], { seg: 20, open: true });
      // A tall, nearly flat band: a rounder one tucks its top and bottom edges back into the brow and cheeks.
      h.front(hex, [0.126, 0.09, 0.146], Math.PI / 2 - 0.3, 0.6, 1.9, [0, EYE_Y + 0.002, 0], O, undefined, 14, 2);
      h.front(0xd07a2a, [0.129, 0.075, 0.15], Math.PI / 2 - 0.3, 0.6, 1.6, [0, EYE_Y + 0.002, 0], O, undefined, 12, 2);
      break;
    case 'ballistic':
      // Low goggles on a wide strap: a dark frame hugging the eyes, a smoked lens.
      h.cyl(shade(hex, 0.9), 0.14, 0.14, 0.026, [0, EYE_Y + 0.004, -0.004], O, [0.9, 1, 1.0], { seg: 12, open: true });
      h.front(0x1d1e20, [0.126, 0.085, 0.146], Math.PI / 2 - 0.3, 0.6, 1.75, [0, EYE_Y + 0.001, 0], O, undefined, 8, 2);
      h.front(0x2c343c, [0.129, 0.07, 0.1495], Math.PI / 2 - 0.3, 0.6, 1.5, [0, EYE_Y + 0.001, 0], O, undefined, 8, 2);
      break;
    case 'shooting':
      // One wrapped lens, amber, on thin arms.
      h.front(0x7a5a1c, [0.124, 0.07, 0.141], Math.PI / 2 - 0.3, 0.6, 1.7, [0, EYE_Y - 0.002, 0], O, undefined, 8, 2);
      h.box(0x1d1e20, [0.118, 0.005, 0.006], [0, EYE_Y + 0.02, 0.137]);
      temples(h, 0x1d1e20, EYE_Y + 0.019);
      break;
    case 'eyepatch':
      h.ball(0x0d0d0e, [0.026, 0.022, 0.007], [-EYE_X, EYE_Y, 0.118], [0, -0.2, 0], undefined, 10, 6);
      h.torus(0x0d0d0e, 0.133, 0.0028, [0, 0.16, -0.004], [Math.PI / 2 - 0.05, 0.0, 0.5], [0.92, 1, 1.02], 3, 22);
      break;
    case 'bandanamask': {
      // Tied over the nose: cloth lying on the face from the bridge of the nose down, a point
      // hanging off the chin, the band round to a knot at the back.
      const fl: Surface = { pattern: PATTERN.floral, accent: 0xe8e2d6 };
      h.put(faceLayer(b.face, (_x, y, an) => (y < 0.121 && Math.abs(an) < 2.2 ? 0.007 : -1)), hex, O, O, 1, fl);
      h.cone(hex, 0.07, 0.085, [0, -0.02, 0.118], [Math.PI + 0.3, 0, 0], [1, 1, 0.3], 4, fl);
      h.ico(hex, 0.02, [0, 0.105, -0.148], O, 1, 1, fl);
      break;
    }
    case 'surgical':
      // Pleated paper over the nose, mouth and chin, loops to the ears.
      h.put(faceLayer(b.face, (_x, y, an) => (y < 0.118 && y > 0.012 && Math.abs(an) < 1.05 ? 0.007 : -1)), 0xa9cfe0, O, O, 1, { pattern: PATTERN.stripes, accent: 0x9bc2d4 });
      for (const s of [1, -1]) h.torus(0xe8ecee, 0.028, 0.0018, [s * 0.112, 0.1, 0.0], [0, Math.PI / 2, 0], 1, 3, 10);
      break;
    case 'gasmask':
      h.front(0x23262a, [0.128, 0.152, 0.162], 1.2, 1.38, 2.6, [0, 0.12, 0]);
      for (const s of [1, -1]) {
        h.cyl(0x2c3a40, 0.022, 0.022, 0.012, [s * 0.045, EYE_Y, 0.15], [Math.PI / 2, 0, 0], 1, { seg: 12 });
        h.torus(0x15171a, 0.023, 0.004, [s * 0.045, EYE_Y, 0.156], O, 1, 4, 12);
      }
      h.cyl(0x55603a, 0.034, 0.03, 0.055, [0, 0.048, 0.18], [Math.PI / 2 + 0.35, 0, 0], 1, { seg: 12 });
      h.cyl(0x15171a, 0.024, 0.024, 0.02, [0, 0.055, 0.155], [Math.PI / 2 + 0.35, 0, 0], 1, { seg: 10 });
      h.torus(0x15171a, 0.135, 0.006, [0, 0.15, -0.01], [Math.PI / 2, 0, 0], [0.92, 1, 1], 3, 20);
      break;
    case 'hockey':
      h.front(0xe8e4da, [0.129, 0.152, 0.162], 0.8, 1.85, 2.3, [0, 0.12, 0]);
      for (const s of [1, -1]) {
        h.ball(0x0d0d0e, [0.019, 0.014, 0.004], [s * 0.045, EYE_Y, 0.151], [0, s * 0.3, 0], undefined, 8, 4);
        for (const [dy, dz] of [[0.035, 0.139], [0.06, 0.126]] as const) h.box(0xb01e2a, [0.018, 0.005, 0.004], [s * 0.05, EYE_Y + dy, dz], [0.35, s * 0.3, s * 0.6]);
      }
      for (let i = 0; i < 6; i++) h.ball(0x0d0d0e, 0.0035, [(i % 3 - 1) * 0.018, 0.06 - Math.floor(i / 3) * 0.018, 0.151 - Math.floor(i / 3) * 0.004], O, undefined, 5, 3);
      break;
    case 'clown':
      h.ico(0xd21f1f, 0.024, [0, 0.099, 0.152], O, 1, 1);
      break;
    case 'cateye':
      // Frames sweeping up into points at the outer corners.
      for (const s of [1, -1]) {
        h.torus(hex, 0.021, 0.0034, [s * 0.042, EYE_Y + 0.001, 0.134], [0, 0, s * 0.12], [1.15, 0.8, 1], 4, 14);
        h.cone(hex, 0.007, 0.022, [s * 0.066, EYE_Y + 0.016, 0.131], [0, s * 0.3, -s * 1.0], [1, 1, 0.5], 3);
      }
      h.box(hex, [0.022, 0.004, 0.004], [0, EYE_Y + 0.008, 0.136]);
      temples(h, hex, EYE_Y + 0.01);
      break;
    case 'oversized':
      for (const s of [1, -1]) {
        h.ball(0x0c0e11, [0.03, 0.027, 0.005], [s * 0.044, EYE_Y - 0.004, 0.135], [0, s * 0.14, 0], undefined, 14, 6);
        h.torus(hex, 0.029, 0.003, [s * 0.044, EYE_Y - 0.004, 0.136], [0, s * 0.14, 0], [1.03, 0.93, 1], 4, 16);
      }
      h.box(hex, [0.02, 0.004, 0.004], [0, EYE_Y + 0.012, 0.138]);
      temples(h, hex, EYE_Y + 0.012);
      break;
    case 'heartglasses':
      // Heart-shaped lenses: two lobes over a point.
      for (const s of [1, -1]) {
        const lens = mixHex(hex, 0x000000, 0.35);
        for (const k of [1, -1]) h.ball(lens, [0.0125, 0.0125, 0.004], [s * 0.042 + k * 0.01, EYE_Y + 0.005, 0.134], O, undefined, 10, 6);
        h.put(new THREE.ConeGeometry(0.021, 0.028, 4), lens, [s * 0.042, EYE_Y - 0.012, 0.133], [Math.PI, Math.PI / 4, 0], [1, 1, 0.2]);
      }
      h.box(hex, [0.022, 0.004, 0.004], [0, EYE_Y + 0.009, 0.137]);
      temples(h, hex, EYE_Y + 0.01);
      break;
  }
}

// ── Smokes ──────────────────────────────────────────────────────────────────────────────

/** Who holds a lit smoke in the mouth (living survivors whose mouth isn't covered), and which one. */
function smokeKind(a: Appearance, zombie: boolean): SmokeKind | null {
  if (zombie || a.smoke === 'none' || !(a.smoke in SMOKES)) return null;
  if (COVERS_MOUTH.has(a.face) || COVERS_FACE.has(a.headwear) || MASKS[a.mask]?.mouth) return null;
  return a.smoke as SmokeKind;
}

/** Head-space frame of the smoke: origin in the lips at the right corner of the mouth, +Z out along it. */
function smokeFrame(h: Kit, a: Appearance, s: SmokeShape): Kit {
  const lip = a.facialHair === 'beard' ? 0.013 : a.facialHair === 'goatee' || a.facialHair === 'stubble' ? 0.004 : 0;
  return h.at([-0.0135, 0.0615, 0.112 + lip], [s.droop, -s.yaw, 0]);
}

/** A section of the smoke from z0 to z1 out of the lips, radius ra to rb. */
function smokeSeg(f: Kit, hex: number, z0: number, z1: number, ra: number, rb: number, seg = 8): void {
  f.cyl(hex, rb, ra, z1 - z0, [0, 0, (z0 + z1) / 2], [Math.PI / 2, 0, 0], 1, { seg });
}

/** A cigarette, joint or blunt hanging from the corner of the mouth, up to its charred, lit end. */
export function smokable(h: Kit, a: Appearance, b: Body): void {
  const kind = smokeKind(a, b.zombie);
  if (!kind) return;
  const s = SMOKES[kind];
  const f = smokeFrame(h, a, s);
  const r = (z: number) => s.r0 + (s.r1 - s.r0) * (z / s.len);
  const end = s.len - 0.003;
  switch (kind) {
    case 'cigarette':
      // Cork filter, a thin gold band, white paper.
      smokeSeg(f, 0xc4874c, 0, 0.026, s.r0, s.r0);
      smokeSeg(f, 0xd6bf72, 0.026, 0.0275, s.r0 * 1.02, s.r0 * 1.02);
      smokeSeg(f, 0xeeeae2, 0.0275, end, s.r0, s.r0);
      break;
    case 'joint':
      // A rolled card crutch, then papers twisting wider toward the lit end.
      smokeSeg(f, 0xd8c79f, 0, 0.011, s.r0 * 1.06, s.r0 * 1.06);
      smokeSeg(f, 0xf1ede0, 0.011, end, r(0.011), r(end));
      break;
    case 'blunt':
      // Wet, darker end at the lips; a tobacco-leaf wrap with its seam spiralling round.
      smokeSeg(f, 0x48301c, 0, 0.008, s.r0, r(0.008), 10);
      smokeSeg(f, 0x6a4527, 0.008, end, r(0.008), r(end), 10);
      for (const z of [0.024, 0.042, 0.06, 0.076]) f.torus(0x50331d, r(z) + 0.0002, 0.0008, [0, 0, z], [0.5, 0, 0], 1, 3, 12);
      break;
  }
  smokeSeg(f, CHAR, end, s.len, r(end) * 1.02, r(s.len) * 1.02);
}

/** The lit end of the smoke an appearance holds (null: none, or a mask over the mouth). */
export function smokeRig(a: Appearance): SmokeRig | null {
  const kind = smokeKind(a, false);
  if (!kind) return null;
  const s = SMOKES[kind];
  const parts: THREE.BufferGeometry[] = [];
  const capture: PartSink = (g) => { parts.push(g); };
  const f = smokeFrame(new Kit(headSink(capture), BONE.head), a, s);
  const r = s.r1 * 0.98;
  smokeSeg(f, 0, s.len, s.len + EMBER_LEN, r, r * 0.8);
  const tip = headWarp(new THREE.Vector3(0, 0, s.len + EMBER_LEN).applyMatrix4(f.frame));
  const dir = new THREE.Vector3(0, 0, 1).transformDirection(f.frame);
  const lip = a.facialHair === 'beard' ? 0.013 : 0;
  const mouth = headWarp(new THREE.Vector3(0.004, 0.062, 0.122 + lip));
  return { kind, ember: parts[0], tip, dir, mouth };
}

