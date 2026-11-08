/**
 * Render budget checks (no GPU needed): the FPS limiter's frame rates on common displays, and the
 * shader patch that keeps lights from shading pixels they don't reach still applying to the three
 * in node_modules. Run with `npm run check:render`.
 */
import * as THREE from 'three';
import { FrameGate } from '../src/core/FrameGate';
import { LIGHT_LOOP_PATCHED } from '../src/rendering/LightLoop';
import { keepShaderSources } from '../src/core/Preload';
import { ParticleBatch } from '../src/effects/Particles';
import { VolumeBatch } from '../src/effects/Volume';
import { Flames } from '../src/effects/Flames';
import { Casings } from '../src/effects/Casings';
import { WoodDebris } from '../src/effects/WoodDebris';
import { DecalBatch } from '../src/effects/Decals';
import { patchWire, WIRE_MIN_PX, WIRE_RADIUS } from '../src/environment/Wires';
import { Humanoid, zombieLookOf } from '../src/characters/Humanoid';
import { BONE_COUNT } from '../src/characters/rig';
import { navLight } from '../src/gameplay/SupplyDrops';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

let failures = 0;
const fail = (msg: string) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg: string) => console.log('  ok   ' + msg);

/** Frames a second drawn over 20 s of a display at `hz` (with a little timestamp jitter) under `limit`. */
function rate(hz: number, limit: number, jitter = 0.15): { fps: number; maxGap: number } {
  const gate = new FrameGate();
  const period = 1000 / hz;
  let drawn = 0, last = 0, maxGap = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const frames = Math.round(20 * hz);
  for (let i = 1; i <= frames; i++) {
    const now = i * period + rnd() * jitter;
    if (gate.tick(now, limit)) {
      // Skip the first second while the refresh estimate settles.
      if (now > 1000) {
        drawn++;
        if (last) maxGap = Math.max(maxGap, now - last);
      }
      last = now;
    }
  }
  return { fps: drawn / 19, maxGap };
}

console.log('FPS limit');
const cases: [number, number, number][] = [
  // display Hz, limit, expected fps
  [60, 0, 60], [144, 0, 144], [60, 60, 60], [59.94, 60, 59.94], [60.5, 60, 60.5], [75, 60, 60],
  [120, 60, 60], [144, 60, 60], [165, 60, 60], [240, 60, 60], [144, 120, 120], [144, 144, 144],
  [165, 144, 144], [60, 30, 30], [144, 30, 30], [240, 144, 144],
];
for (const [hz, limit, want] of cases) {
  const r = rate(hz, limit);
  const msg = `${hz} Hz display, limit ${limit || 'off'}: ${r.fps.toFixed(1)} fps (want ${want}), longest gap ${r.maxGap.toFixed(1)} ms`;
  if (Math.abs(r.fps - want) > want * 0.02) fail(msg);
  else ok(msg);
}
// At about the limit, every refresh draws (no dropped frame every few seconds from clock drift).
for (const hz of [59.94, 60, 60.2, 60.5]) {
  const r = rate(hz, 60);
  if (r.maxGap > 1000 / hz * 1.5) fail(`${hz} Hz at limit 60 skipped a refresh (gap ${r.maxGap.toFixed(1)} ms)`);
}

console.log('Lights reach only the pixels they light');
if (!LIGHT_LOOP_PATCHED) fail('lights_fragment_begin was not patched (three changed the chunk?)');
else {
  const c = THREE.ShaderChunk.lights_fragment_begin;
  const guarded = c.split('if ( directLight.visible ) RE_Direct(').length - 1;
  if (guarded !== 2) fail(`expected the point and spot loops guarded, found ${guarded}`);
  else ok('point and spot light loops skip lights that add nothing');
  const dir = c.slice(c.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'));
  if (dir.includes('if ( directLight.visible )')) fail('the moon (directional) loop must stay unguarded');
}

console.log('Custom shaders keep their programs from night to night');
{
  // three forgets a ShaderMaterial's source, and its id, once the last material using it is disposed, and the id
  // names the program: every night's decals, particles, smoke, fire and rings compiled 8 programs again and left the
  // old ones pinned (143, 151, 159 programs after three nights). keepShaderSources holds a copy of each.
  const three = readFileSync(createRequire(import.meta.url).resolve('three').replace(/three\.cjs$/, 'three.module.js'), 'utf8');
  if (!three.includes('if ( shaderStage.usedTimes === 0 ) this.shaderCache.delete( shaderStage.code );') || !three.includes('array.push( parameters.customVertexShaderID );')) {
    fail("three's shader cache changed: check whether keepShaderSources is still needed (core/Preload.ts)");
  } else ok("three still drops a disposed shader's id and names programs by it");
  const compiled: [THREE.Object3D, THREE.Material][] = [];
  const renderer = {
    getRenderTarget: () => null, setRenderTarget: () => {},
    compile: (o: THREE.Object3D) => { compiled.push([o, (o as THREE.Mesh).material as THREE.Material]); return new Set(); },
  } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
  const tex = new THREE.Texture();
  const shader = (frag: string) => new THREE.ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(0.0); }', fragmentShader: frag, uniforms: { tMap: { value: tex } }, transparent: true, defines: { N: 3 } });
  const a = shader('void main() { gl_FragColor = vec4(1.0); }');
  a.userData.owner = { self: null as unknown }; (a.userData.owner as { self: unknown }).self = a.userData.owner;
  const meshA = new THREE.Mesh(new THREE.PlaneGeometry(), a);
  const meshB = new THREE.Mesh(new THREE.PlaneGeometry(), shader('void main() { gl_FragColor = vec4(1.0); }'));
  const meshC = new THREE.InstancedMesh(new THREE.PlaneGeometry(), shader('void main() { gl_FragColor = vec4(0.5); }'), 4);
  scene.add(meshA, meshB, meshC, new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const first = keepShaderSources(renderer, scene, cam);
  const keptOn = compiled.map(([o]) => o);
  const copies = compiled.map(([, m]) => m as THREE.ShaderMaterial);
  const sameKind = copies.every((k, i) => {
    const orig = (keptOn[i] as THREE.Mesh).material as THREE.ShaderMaterial;
    return k !== orig && k.vertexShader === orig.vertexShader && k.fragmentShader === orig.fragmentShader && k.transparent && k.defines.N === 3 && !('tMap' in k.uniforms);
  });
  const restored = meshA.material === a && a.uniforms.tMap.value === tex && (a.userData.owner as { self: unknown }).self === a.userData.owner;
  // The next night: the same shaders on new materials, so nothing new to keep.
  scene.remove(meshA, meshB, meshC);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), shader('void main() { gl_FragColor = vec4(1.0); }')));
  compiled.length = 0;
  const again = keepShaderSources(renderer, scene, cam);
  if (first !== 2 || keptOn[0] !== meshA || keptOn[1] !== meshC) fail(`kept ${first} shaders on ${keptOn.length} objects (expected the two sources, each on its first object)`);
  else if (!sameKind) fail('each copy should have the same sources, flags and defines, and none of the uniforms');
  else if (!restored) fail("the night's own material, uniforms and userData should be back on the object");
  else if (again !== 0 || compiled.length) fail(`a later night kept ${again} more and compiled ${compiled.length}`);
  else ok('one copy per shader, compiled on an object that uses it; the night keeps its own material; later nights add none');
}

console.log('Empty effect pools send nothing to the GPU and are not drawn');
{
  // three reads an update range of length 0 as "to the end of the array" (WebGL's bufferSubData), so a pool with
  // nothing live re-sent its whole buffer every frame: about 350 KB a frame on a quiet night, all of it unused.
  // And drawn empty, each pool still had three bind its program and uniforms in every pass (22 draws a frame).
  const shown = (root: THREE.Object3D) => {
    let n = 0;
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) n++; });
    return n;
  };
  const instanced = (root: THREE.Object3D) => {
    const out: { name: string; a: THREE.BufferAttribute }[] = [];
    root.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (!m.isMesh) return;
      for (const [name, a] of Object.entries(m.geometry.attributes)) if ((a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) out.push({ name, a: a as THREE.BufferAttribute });
      if (m.isInstancedMesh) {
        out.push({ name: 'instanceMatrix', a: m.instanceMatrix });
        if (m.instanceColor) out.push({ name: 'instanceColor', a: m.instanceColor });
      }
    });
    return out;
  };
  const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const particles = new ParticleBatch(300, false), volume = new VolumeBatch(200, false), flames = new Flames(300, 24);
  const casings = new Casings(40), wood = new WoodDebris(40);
  // The decal atlas is drawn on a canvas: a stand-in that takes every call is enough here.
  const g2d: object = new Proxy({}, { get: () => () => g2d });
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => g2d }) };
  const decals = new DecalBatch(520);
  const cam = new THREE.PerspectiveCamera();
  let lit = false;
  const pools: { name: string; root: THREE.Object3D; step: () => void; add: () => void; live: number }[] = [
    { name: 'particles', root: particles.mesh, step: () => particles.update(1 / 60), live: 1,
      add: () => particles.emit({ x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, life: 2, size: 0.1, r: 1, g: 1, b: 1, alpha: 1 }) },
    { name: 'smoke', root: volume.mesh, step: () => volume.update(1 / 60, cam), live: 1,
      add: () => volume.emit({ x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, life: 2, size: 0.5, size1: 1 }) },
    { name: 'flames', root: flames.root, step: () => { flames.begin(); if (lit) flames.flame(0, 0, 0, 0.3, 0.6, 1, 1, 1); flames.end(1 / 60); }, live: 1,
      add: () => { lit = true; } },
    { name: 'casings', root: casings.mesh, step: () => casings.update(1 / 60), live: 1,
      add: () => casings.eject(v3(0, 1, 0), v3(1, 0, 0), 0, false, v3()) },
    { name: 'wood debris', root: wood.mesh, step: () => wood.update(1 / 60), live: 2,
      add: () => wood.burst(v3(0, 1, 0), v3(1, 0, 0), v3(0, 0, 1), 0.2, 0.2, 2) },
    { name: 'decals', root: decals.mesh, step: () => decals.update(1 / 60), live: 1,
      add: () => decals.add(0, v3(0, 0, 0), v3(0, 1, 0), 0.2, 0.2, 0.2, 0.2, 0.85, 30) },
  ];
  let bad = '';
  for (const pool of pools) {
    const attrs = instanced(pool.root);
    const before = attrs.map(({ a }) => a.version);
    for (let i = 0; i < 3; i++) pool.step();
    const sent = attrs.filter(({ a }, i) => a.version !== before[i]).map(({ name }) => name);
    if (!attrs.length) bad ||= `found no instanced buffers on the ${pool.name}`;
    else if (sent.length) bad ||= `the empty ${pool.name} pool flagged ${sent.join(', ')} for upload`;
    else if (shown(pool.root)) bad ||= `the empty ${pool.name} pool is still drawn`;
    pool.add();
    pool.step();
    if (!shown(pool.root)) bad ||= `the ${pool.name} pool is not drawn with something live in it`;
    // With something live, the update covers just the live slots, never an open-ended range.
    for (const { name, a } of attrs) {
      if (a.version === before[attrs.findIndex((x) => x.a === a)]) continue;
      const r = a.updateRanges;
      if (r.length !== 1 || r[0].start !== 0 || r[0].count !== pool.live * a.itemSize) bad ||= `the ${pool.name} pool's ${name} sends ${JSON.stringify(r)}, not its ${pool.live} live slot(s)`;
    }
    if (attrs.every(({ a }, i) => a.version === before[i])) bad ||= `the ${pool.name} pool sent nothing with something live in it`;
  }
  // Decals stay on for half a minute and more: a steady mark sends nothing again until it fades (the whole
  // 8 KB tint buffer went up every frame), and a frame of fading marks sends one span, not the pool.
  const tint = decals.mesh.geometry.getAttribute('iTint') as THREE.BufferAttribute;
  decals.add(0, v3(1, 0, 0), v3(0, 1, 0), 0.2, 0.2, 0.2, 0.2, 0.7, 30);
  decals.add(0, v3(2, 0, 0), v3(0, 1, 0), 0.2, 0.2, 0.2, 0.2, 0.6, 30);
  decals.update(1 / 60);
  for (const a of [tint, decals.mesh.instanceMatrix]) a.clearUpdateRanges();
  const steady = tint.version;
  for (let i = 0; i < 60; i++) decals.update(1 / 60);
  if (tint.version !== steady || tint.updateRanges.length) bad ||= `steady decals sent their tint again (${JSON.stringify(tint.updateRanges)})`;
  decals.update(27);
  const r = tint.updateRanges;
  if (r.length !== 1 || r[0].start !== 0 || r[0].count !== 3 * 4) bad ||= `three fading decals sent ${JSON.stringify(r)}, not one span of 3 slots`;
  if (bad) fail(bad);
  else ok(`${pools.map((p) => p.name).join(', ')}: not drawn and nothing sent while empty, drawn with only the live slots sent once something is in them; steady decals send nothing`);
}

console.log('Power lines stay at least a pixel wide');
{
  // 3.6 cm wires went under a pixel 10 to 20 m out and broke into dotted trails against the sky.
  let bad = '';
  const mat = new THREE.MeshStandardMaterial({ flatShading: true });
  const plainKey = mat.customProgramCacheKey();
  patchWire(mat, WIRE_RADIUS);
  const src = THREE.ShaderLib.physical;
  const shader = { vertexShader: src.vertexShader, fragmentShader: src.fragmentShader, uniforms: THREE.UniformsUtils.clone(src.uniforms) } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  const vs = shader.vertexShader;
  const at = vs.indexOf('#include <project_vertex>');
  const grow = vs.indexOf('mvPosition.xyz += normalize(transformedNormal) * grow;');
  if (!vs.includes('uniform float uWirePx;') || !('uWirePx' in shader.uniforms)) bad ||= 'the wire shader has no pixel-size uniform';
  else if (at < 0 || grow < at || !vs.slice(grow).includes('gl_Position = projectionMatrix * mvPosition;')) bad ||= 'the wire is not grown after project_vertex (three renamed the chunk?)';
  else if (vs.indexOf('#include <defaultnormal_vertex>') < 0 || vs.indexOf('#include <defaultnormal_vertex>') > at) bad ||= 'transformedNormal is not set before the wire grows';
  else if (mat.customProgramCacheKey() === plainKey) bad ||= 'the wire program shares its cache key with plain standard materials';
  // The pixel size follows the camera and viewport that draw it (the phone's 540 rows, a 70 degree view).
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
  const renderer = { getCurrentViewport: (v: THREE.Vector4) => v.set(0, 0, 960, 540) } as unknown as THREE.WebGLRenderer;
  mat.onBeforeRender(renderer, new THREE.Scene(), cam, new THREE.BufferGeometry(), new THREE.Mesh(), null);
  const px = (shader.uniforms.uWirePx as { value: number }).value;
  const want = (2 * Math.tan((35 * Math.PI) / 180)) / 540;
  if (Math.abs(px - want) > want * 1e-6) bad ||= `uWirePx is ${px}, not ${want} radians per pixel`;
  // A 3-sided tube is at least 1.5 corner radii across, so the smallest radius drawn must give a pixel.
  if (1.5 * WIRE_MIN_PX < 1) bad ||= `a ${WIRE_MIN_PX} px radius draws a 3-sided wire under a pixel wide`;
  const props = readFileSync(new URL('../src/environment/Props.ts', import.meta.url), 'utf8');
  if (!/wireMaterial\(this\.lib\)/.test(props) || !/TubeGeometry\(curve, \d+, WIRE_RADIUS, 3,/.test(props)) bad ||= 'Props.buildWires no longer uses the pixel-wide wire material and radius';
  const near = WIRE_RADIUS / (WIRE_MIN_PX * want);
  if (bad) fail(bad);
  else ok(`grown to ${WIRE_MIN_PX} px radius past ${near.toFixed(0)} m on a phone (${(near * 2).toFixed(0)} m at 1080p), untouched closer`);
}

console.log('Zombie looks are ready for wounds before the night');
{
  // The first wound on each look built its per-bone vertex lists by pushing every vertex onto growing arrays: 5-20 ms
  // and over 1 MB of garbage, mid-night on that look's first spawn (warm() had built the body but not these).
  let bad = '';
  const view = readFileSync(new URL('../src/zombies/ZombieView.ts', import.meta.url), 'utf8');
  if (!/private build\([^]*?new Humanoid\([^]*?body\.prepareWounds\(\);[^]*?return \{ body, probe \}/.test(view)) bad ||= 'ZombieView.build no longer prepares the wound lists (warm() builds every look through it)';
  let looks = 0, verts = 0;
  for (const [kind, n] of [['walker', 3], ['runner', 2], ['brute', 2]] as const) for (let i = 0; i < n; i++) {
    const h = new Humanoid(zombieLookOf(kind, i));
    const entry = (h as unknown as { body: { geometry: THREE.BufferGeometry; byBone?: Float32Array[] } }).body;
    if (entry.byBone) { bad ||= `${kind} ${i}: lists built before prepareWounds`; continue; }
    (h as { prepareWounds?: () => void }).prepareWounds?.();
    // The same lists the old pushes built: each bone's bind-pose vertices, in order.
    const pos = entry.geometry.getAttribute('position'), si = entry.geometry.getAttribute('skinIndex');
    const want: number[][] = Array.from({ length: BONE_COUNT }, () => []);
    for (let v = 0; v < pos.count; v++) want[si.getX(v)]?.push(pos.getX(v), pos.getY(v), pos.getZ(v));
    const got = entry.byBone;
    if (!got || got.length !== BONE_COUNT) { bad ||= `${kind} ${i}: no lists after prepareWounds`; continue; }
    for (let b = 0; b < BONE_COUNT; b++) {
      const w = Float32Array.from(want[b]);
      if (got[b].length !== w.length || got[b].some((x, j) => x !== w[j])) bad ||= `${kind} ${i}: bone ${b} lists ${got[b].length / 3} vertices, not the ${w.length / 3} it holds`;
    }
    looks++;
    verts += pos.count;
    h.dispose();
  }
  if (bad) fail(bad);
  else ok(`${looks} looks (${verts} vertices): built by ZombieView.build, so the loading warm-up covers them, and the same lists as before`);
}

console.log('Reduced flashing softens the supply helicopter\'s lights');
{
  // The setting promises softened strobes, but the helicopter's white strobe (60 ms every 1.6 s) and red beacon
  // blinked hard through the whole supply run with it on.
  let bad = '';
  const drops = readFileSync(new URL('../src/gameplay/SupplyDrops.ts', import.meta.url), 'utf8');
  if (!/const reduced = settings\.value\.accessibility\.reducedFlashing;\s*this\.light\(this\.beacon, BEACON, navLight\(time, 1\.1, 0\.16, reduced\)\);\s*this\.light\(this\.strobe, STROBE, navLight\(time, 1\.6, 0\.06, reduced\)\);/.test(drops)) bad ||= 'the helicopter no longer drives its beacon and strobe through navLight with the setting';
  for (const [name, period, on] of [['beacon', 1.1, 0.16], ['strobe', 1.6, 0.06]] as const) {
    let max = 0, jump = 0, lit = 0, prev = navLight(0, period, on, true);
    const hard = new Set<number>();
    for (let f = 1; f <= 600; f++) {
      const t = f / 60, k = navLight(t, period, on, true);
      max = Math.max(max, k);
      jump = Math.max(jump, Math.abs(k - prev));
      prev = k;
      hard.add(navLight(t, period, on, false));
      if (navLight(t, period, on, false) === 1) lit++;
    }
    if (max > 0.5 + 1e-9) bad ||= `${name}: reaches ${max.toFixed(2)} with reduced flashing (half strength at most)`;
    if (jump > 0.05) bad ||= `${name}: jumps ${jump.toFixed(3)} between frames at 60 fps with reduced flashing`;
    if (hard.size !== 2 || Math.abs(lit / 600 - on / period) > 0.02) bad ||= `${name}: no longer blinks as before with the setting off (lit ${(lit / 600).toFixed(3)} of the time)`;
  }
  if (bad) fail(bad);
  else ok('beacon and strobe swell and fade at half strength (under 0.05 a frame at 60 fps) with reduced flashing, blink as before without');
}

if (failures) {
  console.log(`\n${failures} render check(s) FAILED`);
  process.exit(1);
}
console.log('\nrender checks passed');
