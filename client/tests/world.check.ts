/**
 * Headless world checks: walks a character controller (configured like PlayerController)
 * through the shared map's real collision. Run with `npm run check:world -w client`.
 *
 * Covers spawn clearance, every doorway in both directions, every staircase both ways, the
 * safehouse routes, the backyard passages, routes into each district, door leaves blocking when
 * closed and clearing when open, furniture clipping into walls, and the flashlight turning down
 * near walls.
 */
import * as THREE from 'three';
import { MAPLE_HOLLOW as map, OAK, PLAYER, propColliders } from '@dead-hours/shared';
import { Physics, initPhysics, RAPIER, GROUP, groups } from '../src/core/Physics';
import { DoorSystem } from '../src/gameplay/Doors';
import { Acoustics, type Space } from '../src/audio/Acoustics';
import { beamPower, falloff, HOTSPOT_FAR, HOTSPOT_NEAR, lampPower, TRIM_ALBEDO } from '../src/lighting/BeamPower';
import { BODY_KNEE, GLOSS_CEIL, GLOSS_KNEE, glossCap, softCeil } from '../src/lighting/GlossCap';
import { Lighting } from '../src/lighting/Lighting';
import { FOG_DENSITY, fogLeft, PICKUP_DRAW_RANGE } from '../src/environment/FogRange';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

type V = [number, number];
const DT = 1 / 60;
const half = (PLAYER.height - PLAYER.radius * 2) / 2;
let failures = 0;
const fail = (msg: string) => { failures++; console.log('  FAIL ' + msg); };

class Walker {
  body: RAPIER.RigidBody;
  col: RAPIER.Collider;
  ctrl: RAPIER.KinematicCharacterController;
  vy = 0;
  vx = 0;
  vz = 0;
  grounded = false;
  constructor(private p: Physics, x: number, y: number, z: number) {
    const w = p.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + PLAYER.height / 2 + 0.02, z));
    this.col = w.createCollider(RAPIER.ColliderDesc.capsule(half, PLAYER.radius).setCollisionGroups(groups(GROUP.player, GROUP.static | GROUP.dynamic)), this.body);
    this.ctrl = w.createCharacterController(0.02);
    this.ctrl.setUp({ x: 0, y: 1, z: 0 });
    this.ctrl.enableAutostep(PLAYER.maxStepHeight, 0.15, false);
    this.ctrl.enableSnapToGround(0.35);
    this.ctrl.setMaxSlopeClimbAngle((PLAYER.maxSlopeDeg * Math.PI) / 180);
    this.ctrl.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.ctrl.setSlideEnabled(true);
    p.world.step();
  }
  get pos() {
    const t = this.body.translation();
    return { x: t.x, y: t.y - PLAYER.height / 2, z: t.z };
  }
  step(wx: number, wz: number, speed = PLAYER.walkSpeed) {
    const k = 1 - Math.exp(-PLAYER.acceleration * DT);
    this.vx += (wx * speed - this.vx) * k;
    this.vz += (wz * speed - this.vz) * k;
    this.vy += PLAYER.gravity * DT;
    if (this.grounded && this.vy < 0) this.vy = 0;
    const desired = { x: this.vx * DT, y: this.vy * DT, z: this.vz * DT };
    this.ctrl.computeColliderMovement(this.col, desired, undefined, groups(GROUP.player, GROUP.static | GROUP.dynamic));
    const m = this.ctrl.computedMovement();
    this.grounded = this.ctrl.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
    this.p.world.step();
  }
  /** Steers to each waypoint; returns false at the first one it can't reach. */
  walk(points: V[], label: string, tol = 0.3, speed: number = PLAYER.walkSpeed): boolean {
    for (const [tx, tz] of points) {
      const s = this.pos;
      const limit = (Math.hypot(tx - s.x, tz - s.z) / speed) * 2.5 + 1.5;
      let t = 0;
      for (; t < limit; t += DT) {
        const p = this.pos;
        const dx = tx - p.x, dz = tz - p.z;
        const d = Math.hypot(dx, dz);
        if (d < tol) break;
        this.step(dx / d, dz / d, d < 0.6 ? speed * 0.5 : speed);
      }
      if (t >= limit) {
        const p = this.pos;
        fail(`${label}: stuck before (${tx}, ${tz}) at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
        return false;
      }
    }
    for (let i = 0; i < 20; i++) this.step(0, 0);
    return true;
  }
  dispose() {
    this.p.world.removeCharacterController(this.ctrl);
    this.p.world.removeRigidBody(this.body);
  }
}

function route(p: Physics, label: string, start: [number, number, number], points: V[], expectY?: number, speed: number = PLAYER.walkSpeed): void {
  const w = new Walker(p, ...start);
  for (let i = 0; i < 30; i++) w.step(0, 0);
  const ok = w.walk(points, label, 0.3, speed);
  const e = w.pos;
  const yOk = expectY === undefined || Math.abs(e.y - expectY) < 0.12;
  if (ok && !yOk) fail(`${label}: ended at y ${e.y.toFixed(2)}, expected ${expectY}`);
  if (ok && yOk) console.log(`  ok   ${label} -> (${e.x.toFixed(2)}, ${e.y.toFixed(2)}, ${e.z.toFixed(2)})`);
  w.dispose();
}

await initPhysics();
const phys = new Physics(map);
const enterable = new Set(map.houses.filter((h) => h.enterable).map((h) => h.id));

console.log('Spawns clear of geometry');
const capsule = new RAPIER.Capsule(half, PLAYER.radius - 0.02);
for (const s of map.playerSpawns) {
  let hit = false;
  phys.world.intersectionsWithShape({ x: s.x, y: s.y + PLAYER.height / 2 + 0.03, z: s.z }, { x: 0, y: 0, z: 0, w: 1 }, capsule, () => { hit = true; return false; });
  if (hit) fail(`spawn (${s.x}, ${s.y}, ${s.z}) overlaps geometry`); else console.log(`  ok   spawn (${s.x}, ${s.z})`);
}

console.log('Every doorway of enterable buildings is walkable (both directions)');
for (const d of map.doors) {
  if (!enterable.has(d.houseId)) continue;
  const nx = d.axis === 'x' ? 0 : 1, nz = d.axis === 'x' ? 1 : 0;
  const floor = d.floorY ?? 0.3;
  for (const side of [1, -1]) {
    const a: [number, number, number] = [d.x + nx * 1.1 * side, floor + 0.05, d.z + nz * 1.1 * side];
    const b: V = [d.x - nx * 1.1 * side, d.z - nz * 1.1 * side];
    route(phys, `${d.id}${d.exterior ? ` ${d.style ?? 'wood'}` : ''} side ${side}`, a, [b]);
    // Crouch-walking speed: thresholds must not stall slow movers (zombies shamble slower still).
    route(phys, `${d.id} side ${side} at crouch speed`, a, [b], undefined, PLAYER.crouchSpeed * 0.5);
  }
}

console.log('Safehouse routes');
route(phys, 'living room -> up the stairs -> landing', [-0.7, 0.32, -16.6], [[-0.7, -18.2], [-0.7, -23.75]], 3.55);
route(phys, 'landing -> front bedroom (west)', [-0.7, 3.6, -23.8], [[0.6, -23.8], [1.2, -20.2], [1.2, -17.2]], 3.55);
route(phys, 'landing -> front bedroom (east)', [-0.7, 3.6, -23.8], [[4.5, -23.8], [4.5, -20.2], [4.5, -17.2]], 3.55);
route(phys, 'landing -> west bedroom', [-0.7, 3.6, -23.8], [[-0.7, -24.0], [-2.6, -24.0], [-4.2, -21.0]], 3.55);
route(phys, 'landing -> down the stairs -> living room', [-0.7, 3.6, -23.8], [[-0.7, -23.3], [-0.7, -17.6], [1.5, -17.0]], 0.3);
route(phys, 'kitchen -> basement', [-4.0, 0.32, -16.6], [[-6.15, -16.6], [-6.15, -17.2], [-6.15, -22.9], [-4.0, -22.9], [-3.5, -19.5]], -2.7);
route(phys, 'basement -> kitchen', [-3.5, -2.68, -21], [[-6.15, -23.1], [-6.15, -17.0], [-5.6, -16.8], [-3.5, -16.8]], 0.3);
route(phys, 'front door -> living -> kitchen -> back door', [2.4, 0.05, -13.0], [[2.4, -16.0], [1.0, -16.7], [-1.4, -16.7], [-2.0, -17.6], [-2.0, -22.8], [-2.4, -23.6], [-2.4, -26.5]]);
route(phys, 'east door -> garage interior', [6.0, 0.32, -22.5], [[7.6, -22.5], [8.6, -21.6], [10, -19]]);

console.log('Every staircase, both ways');
for (const st of map.stairs) {
  const dir = Math.sign(st.to - st.from);
  const mid = (st.a0 + st.a1) / 2;
  const pt = (along: number): V => (st.axis === 'z' ? [mid, along] : [along, mid]);
  const below = pt(st.from - dir * 0.45), above = pt(st.to + dir * 0.7);
  const tag = `${st.houseId ?? 'stairs'} ${st.y0.toFixed(2)} -> ${st.y1.toFixed(2)}`;
  route(phys, `${tag} up`, [below[0], st.y0 + 0.05, below[1]], [above], st.y1);
  route(phys, `${tag} down`, [above[0], st.y1 + 0.05, above[1]], [below], st.y0);
}

console.log('Narrow backyard passages');
// Sheds sit ~1.2 m from a lot divider; walk the gap between the shed's side and the fence. The
// divider is the nearest fence running along Z beside the shed.
const dividerFences = map.props.filter((p) => p.kind === 'fence' && Math.abs(Math.abs(Math.sin(p.rotY)) - 1) < 1e-3);
for (const s of map.props.filter((p) => p.kind === 'shed')) {
  const beside = dividerFences.filter((f) => Math.abs(f.z - s.z) < (f.length ?? 0) / 2);
  if (!beside.length) { fail(`shed at (${s.x}, ${s.z}) has no lot divider beside it`); continue; }
  const fx = beside.reduce((a, b) => (Math.abs(b.x - s.x) < Math.abs(a.x - s.x) ? b : a)).x;
  const side = s.x + Math.sign(fx - s.x) * 1.5;
  const px = (fx + side) / 2;
  const front = Math.cos(s.rotY) > 0 ? 1 : -1;
  route(phys, `passage beside shed at (${s.x}, ${s.z}), gap ${Math.abs(fx - side).toFixed(2)} m`, [px, 0.05, s.z + front * 2.6], [[px, s.z - front * 2.0]]);
}

console.log('Districts reachable from the street');
route(phys, 'street -> gas station store', [70, 0.05, 0], [[85, -5], [92, -30], [92, -36]], 0.2);
route(phys, 'street -> park gazebo', [86, 0.05, 4], [[88, 10], [92, 30], [100, 39]]);
route(phys, 'street -> checkpoint chicane', [-80, 0.05, -2], [[-90, 2.8], [-96, 3.0], [-100, 3.0], [-101.6, -4.6], [-106, -4.6], [-108.6, -0.4], [-109.5, -0.4]]);
route(phys, 'safehouse back door -> north alley via gate', [-2.4, 0.05, -26.0], [[-3.7, -26.3], [-3.7, -29], [-2, -40], [-2, -47]]);
// Kinney Street, the next street over: down Pell Lane, through the shared alley, and in from the park.
route(phys, 'Hale Street -> Kinney Street via Pell Lane', [-65, 0.05, 6], [[-65, 30], [-65, 62], [-70.5, 70], [-70.5, 80], [-66, 92], [-50, 93], [-20, 93], [-10, 95.5], [5, 95.5], [14, 92], [32, 92], [50, 94], [62, 96], [84, 96], [92, 94]]);
route(phys, 'Hale south alley -> Kinney Street through a back gate and side yard', [2, 0.05, 46], [[4, 49], [4, 54], [12.5, 64], [12.5, 84], [12.5, 88.5]]);
route(phys, 'park -> Kinney Street dead end down the trail', [88, 0.05, 30], [[89, 40], [89, 52], [89, 70], [89, 86], [89, 92]]);
route(phys, 'Kinney Street -> past a parked car, out the back gate to the woods', [21.5, 0.05, 99.5], [[21.5, 104], [21.5, 120], [10, 134], [10, 138], [10, 142]]);

console.log('Door leaves block when closed and clear when open');
{
  const root = new THREE.Group();
  const doors = new DoorSystem(map, phys, root);
  const roll = doors.doors.find((d) => d.kind === 'rollup')!;
  const cam = new THREE.PerspectiveCamera();
  const w = new Walker(phys, roll.spec.x, 0.05, roll.spec.z - 2.0 * -1);
  for (let i = 0; i < 30; i++) { doors.update(DT, cam); w.step(0, 0); }
  // Closed: blocked.
  const dir = Math.sign(roll.spec.z - w.pos.z);
  for (let i = 0; i < 120; i++) { doors.update(DT, cam); w.step(0, dir); }
  const blocked = Math.abs(w.pos.z - roll.spec.z) > 0.3;
  if (!blocked) fail('closed roll-up door let the player through'); else console.log(`  ok   closed door blocks (z ${w.pos.z.toFixed(2)})`);
  roll.toggle(new THREE.Vector3(w.pos.x, w.pos.y, w.pos.z));
  for (let i = 0; i < 150; i++) { doors.update(DT, cam); phys.world.step(); }
  for (let i = 0; i < 150; i++) { doors.update(DT, cam); w.step(0, dir); }
  const through = (w.pos.z - roll.spec.z) * dir > 1.0;
  if (!through) fail(`open roll-up door still blocks (z ${w.pos.z.toFixed(2)})`); else console.log(`  ok   open door passes (z ${w.pos.z.toFixed(2)})`);
  w.dispose();
  // Hinged doors: closed blocks, open passes.
  for (const d of doors.doors.filter((dd) => dd.kind === 'hinged')) {
    const nx = d.spec.axis === 'x' ? 0 : 1, nz = d.spec.axis === 'x' ? 1 : 0;
    const floor = d.spec.floorY ?? 0.3;
    const out = d.spec.outward;
    const wk = new Walker(phys, d.spec.x + nx * 1.2 * out, floor + 0.05, d.spec.z + nz * 1.2 * out);
    for (let i = 0; i < 20; i++) wk.step(0, 0);
    for (let i = 0; i < 90; i++) { doors.update(DT, cam); wk.step(-nx * out, -nz * out); }
    const p0 = wk.pos;
    const across0 = ((p0.x - d.spec.x) * nx + (p0.z - d.spec.z) * nz) * out;
    d.toggle(new THREE.Vector3(p0.x, p0.y, p0.z));
    for (let i = 0; i < 60; i++) { doors.update(DT, cam); phys.world.step(); }
    for (let i = 0; i < 120; i++) { doors.update(DT, cam); wk.step(-nx * out, -nz * out); }
    const p1 = wk.pos;
    const across1 = ((p1.x - d.spec.x) * nx + (p1.z - d.spec.z) * nz) * out;
    if (across0 < 0.2) fail(`${d.spec.id} (${d.spec.style ?? 'wood'}) closed but player reached ${across0.toFixed(2)}`);
    else if (across1 > -1.0) fail(`${d.spec.id} (${d.spec.style ?? 'wood'}) open but player stopped at ${across1.toFixed(2)}`);
    else console.log(`  ok   ${d.spec.id} ${d.spec.style ?? 'wood'}: closed stops at ${across0.toFixed(2)}, open reaches ${across1.toFixed(2)}`);
    d.toggle(new THREE.Vector3(p1.x, p1.y, p1.z));
    for (let i = 0; i < 90; i++) { doors.update(DT, cam); phys.world.step(); }
    wk.dispose();
  }
}

console.log('Props clipping into walls or floors (deeper than 6 cm; vehicles may ride up on curbs)');
{
  const solidsOnly = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const body = solidsOnly.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const tagged: string[] = [];
  for (const s of map.solids) {
    if (s.collide === false) continue;
    const c = solidsOnly.createCollider(RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2).setTranslation(s.x, s.y, s.z), body);
    tagged[c.handle] = `${s.mat} ${s.w.toFixed(2)}x${s.h.toFixed(2)}x${s.d.toFixed(2)} @(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})`;
  }
  solidsOnly.step();
  // Fences and barriers are built to butt into things; crashed vehicles straddle curbs on purpose.
  const skip = new Set(['fence', 'ironFence', 'railing', 'sandbags', 'jerseyBarrier', 'roadblock', 'utilityPole', 'streetlight', 'parkLamp']);
  const vehicles = new Set(['car', 'policeCar', 'wreckedCar', 'armoredTruck']);
  let n = 0;
  for (const p of map.props) {
    if (skip.has(p.kind)) continue;
    for (const b of propColliders(p)) {
      const shrink = 0.06;
      if (b.hx <= shrink || b.hy <= shrink || b.hz <= shrink) continue;
      const shape = new RAPIER.Cuboid(b.hx - shrink, b.hy - shrink, b.hz - shrink);
      const q = { x: 0, y: Math.sin(b.rotY / 2), z: 0, w: Math.cos(b.rotY / 2) };
      solidsOnly.intersectionsWithShape({ x: b.x, y: b.y, z: b.z }, q, shape, (c) => {
        if (vehicles.has(p.kind) && tagged[c.handle].startsWith('sidewalk')) return true;
        n++;
        fail(`overlap ${p.kind}${p.variant !== undefined ? `/${p.variant}` : ''} @(${p.x}, ${p.y ?? 0}, ${p.z}) rot ${(p.rotY ?? 0).toFixed(2)} with ${tagged[c.handle]}`);
        return true;
      });
    }
  }
  if (!n) console.log('  ok   no furniture or fixtures inside walls');
}

console.log('Acoustics: the space around each place, and walls between gun and ear');
{
  const ac = new Acoustics(phys);
  const ear = (x: number, y: number, z: number): [number, number, number] => [x, y + 1.6, z];
  const places: [string, [number, number, number], Space][] = [
    ['Hale Street', ear(-40, 0.15, -4.6), 'street'],
    ['safehouse living room', ear(4.8, 0.32, -22.3), 'room'],
    ['safehouse basement', ear(-3.5, -2.68, -21), 'basement'],
    ['safehouse garage', ear(10, 0.15, -19), 'hall'],
    ['Rudy’s shop floor', ear(92, 0.2, -36), 'hall'],
    ['park gazebo', ear(100, 0.4, 39), 'street'],
    ['Kinney Street', ear(-20, 0.15, OAK.z - 1), 'street'],
    ['Oyelaran living room', ear(10, 0.32, 113.5), 'room'],
    ['Oyelaran basement', ear(7, -2.68, 113.5), 'basement'],
  ];
  for (const [name, at, want] of places) {
    const got = ac.spaceAt(...at);
    if (got !== want) fail(`${name}: heard as ${got}, expected ${want}`);
    else console.log(`  ok   ${name}: ${got}`);
  }
  const open = ac.occlusion(-40, 1.6, -4.6, -30, 1.6, -4.6);
  const walled = ac.occlusion(-40, 1.6, -4.6, ...ear(4.8, 0.32, -22.3));
  const deep = ac.occlusion(-40, 1.6, -4.6, ...ear(-3.5, -2.68, -21));
  if (open.walls) fail(`10 m down an empty street crosses ${open.walls} wall(s)`);
  else if (!walled.walls || walled.gain >= 0.5 || walled.cutoff > 2000) fail(`street to living room isn't muffled (${JSON.stringify(walled)})`);
  else if (!(deep.gain < walled.gain && deep.cutoff <= walled.cutoff)) fail(`basement isn't more muffled than the living room (${JSON.stringify(deep)})`);
  else console.log(`  ok   open street clear; living room through ${walled.walls} wall(s) at ${(20 * Math.log10(walled.gain)).toFixed(0)} dB below ${walled.cutoff.toFixed(0)} Hz; basement ${(20 * Math.log10(deep.gain)).toFixed(0)} dB below ${deep.cutoff.toFixed(0)} Hz`);
}

console.log('Flashlight lights a room without burning the nearest wall white');
{
  // The player's chest lamp (gameplay/Flashlight.ts): 95 cd, 30 m, 0.36 rad, penumbra 0.6, decay 1.45.
  const FULL = 95;
  const lamp = new THREE.SpotLight(0xffffff, 0, 30, 0.36, 0.6, 1.45);
  const shine = (x: number, y: number, z: number, dx: number, dy: number, dz: number) => {
    const from = new THREE.Vector3(x, y, z);
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const power = beamPower(phys, lamp, FULL, from, dir);
    const hit = phys.raycastHit(x, y, z, dir.x, dir.y, dir.z, 30);
    // The white trim round the windows and doors, the palest thing on these walls.
    const lit = (p: number) => (hit ? (FULL * p * falloff(hit.distance, 30, 1.45) * TRIM_ALBEDO) / Math.PI : 0);
    return { power, hit, glow: lit(power), was: lit(1) };
  };
  // Safehouse living room, the lamp at chest height beside the windows: the north wall 2.5 m off,
  // then half a metre, then the room's length (7 m) the other way; down Hale Street nothing is near.
  const chest = 0.35 + 1.3;
  const rows: [string, ReturnType<typeof shine>][] = [
    ['wall 0.5 m', shine(3.5, chest, -24.25, 0, 0, -1)],
    ['wall 2.5 m', shine(3.5, chest, -22.3, 0, 0, -1)],
    ['across the room', shine(4.0, chest, -22.3, 0, -0.05, 1)],
  ];
  for (const [name, r] of rows) {
    const what = `${name} (${r.hit?.surface ?? 'nothing'} at ${r.hit?.distance.toFixed(2)} m): ${(r.power * 100).toFixed(0)}% power, trim at ${r.glow.toFixed(2)} (full power ${r.was.toFixed(1)})`;
    if (!r.hit || r.hit.surface !== 'plaster') fail(`${what}: expected a plaster wall in front`);
    else if (r.glow > HOTSPOT_NEAR + 1e-6) fail(`${what}: brighter than the bloom cap ${HOTSPOT_NEAR}`);
    else if (r.power < 1 && r.glow < HOTSPOT_FAR * 0.9) fail(`${what}: turned down further than it needs to`);
    else console.log(`  ok   ${what}`);
  }
  const street = shine(-40, 1.5, -4.6, 1, -0.06, 0);
  if (street.power < 1) fail(`down Hale Street the beam is turned down to ${(street.power * 100).toFixed(0)}%`);
  else console.log('  ok   down Hale Street: full power');
  if (!(rows[0][1].power < rows[1][1].power && rows[1][1].power < rows[2][1].power)) fail('nearer walls should turn the beam down further');

  // A Molotov's light (Pyro: 45 cd a metre over the fire, 13 m, decay 2) beside the safehouse's
  // north wall, and in the middle of Hale Street with no car parked beside it.
  const fire = new THREE.PointLight(0xffffff, 0, 13, 2);
  const byWall = new THREE.Vector3(3.5, 0.35 + 1, -24.3);
  const wallPower = lampPower(phys, fire, 45, byWall);
  const wallD = phys.raycast(byWall.x, byWall.y, byWall.z, 0, 0, -1, 13) ?? 13;
  const wallGlow = (45 * wallPower * falloff(wallD, 13, 2) * TRIM_ALBEDO) / Math.PI;
  const what = `Molotov ${wallD.toFixed(2)} m from a wall: ${(wallPower * 100).toFixed(0)}% power, trim at ${wallGlow.toFixed(2)} (full power ${(wallGlow / wallPower).toFixed(1)})`;
  if (wallGlow > HOTSPOT_NEAR + 1e-6 || wallPower >= 1) fail(`${what}: brighter than the bloom cap ${HOTSPOT_NEAR}`);
  else console.log(`  ok   ${what}`);
  const openPower = lampPower(phys, fire, 45, new THREE.Vector3(25, 1, 0));
  if (openPower < 1) fail(`a Molotov in the middle of Hale Street is turned down to ${(openPower * 100).toFixed(0)}%`);
  else console.log('  ok   Molotov in the middle of Hale Street: full power');
}

console.log('Wet reflections and fire-lit bodies stay under a soft ceiling');
{
  const rows = [0.2, GLOSS_KNEE, 0.9, 3, 64].map((x) => [x, glossCap(x)] as const);
  const rising = rows.every(([, y], i) => i === 0 || y >= rows[i - 1][1]);
  const line = rows.map(([x, y]) => `${x} -> ${y.toFixed(2)}`).join(', ');
  if (glossCap(0.2) !== 0.2 || glossCap(64) > GLOSS_CEIL || glossCap(3) < 0.9 || !rising) fail(`gloss cap: ${line}`);
  else console.log(`  ok   ${line}`);
  // Bodies: a key light on a white shirt (~0.6) passes untouched; a burning body's own fire (~20) stays near 1.
  const body = [0.6, 0.9, 20].map((x) => [x, softCeil(x, BODY_KNEE, GLOSS_CEIL)] as const);
  const bodyLine = body.map(([x, y]) => `${x} -> ${y.toFixed(2)}`).join(', ');
  if (body[0][1] !== 0.6 || body[1][1] < 0.8 || body[2][1] > GLOSS_CEIL) fail(`body light cap: ${bodyLine}`);
  else console.log(`  ok   bodies: ${bodyLine}`);
}

console.log('The loading frame readies every shadow-depth program');
{
  // three compiles a caster's depth program only when the caster enters a shadow camera right after one of another
  // kind, so which ones compile depends on what the camera holds: two did mid-night as the park's iron fence came
  // within the moon's 76 m. The loading frame stretches the moon's shadow over the whole map and has every caster
  // pick its own program.
  const light = new Lighting(new THREE.Scene());
  const cam = light.moon.shadow.camera;
  const before = [cam.left, cam.right, cam.top, cam.bottom, cam.far, ...light.moon.position.toArray()];
  const hook = THREE.Object3D.prototype.onBeforeShadow;
  const b = map.bounds;
  const back = light.warmShadows(b);
  light.moon.updateMatrixWorld(); light.moon.target.updateMatrixWorld();
  light.moon.shadow.updateMatrices(light.moon);
  const outside: string[] = [];
  for (const x of [b.x0, b.x1]) for (const z of [b.z0, b.z1]) for (const y of [0, 14]) {
    const p = new THREE.Vector3(x, y, z).project(cam);
    if (Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) > 1) outside.push(`(${x}, ${y}, ${z})`);
  }
  const depth = new THREE.MeshDepthMaterial();
  const v0 = depth.version;
  const caster = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  caster.onBeforeShadow(null as never, caster, cam, cam, caster.geometry, depth, null as never);
  const picked = depth.version > v0;
  back();
  const after = [cam.left, cam.right, cam.top, cam.bottom, cam.far, ...light.moon.position.toArray()];
  if (outside.length) fail(`map corners outside the whole-map moon shadow: ${outside.join(' ')}`);
  else if (!picked) fail('a caster drawn into the loading frame\'s shadow kept the depth program of the one before it');
  else if (after.some((v, i) => v !== before[i]) || THREE.Object3D.prototype.onBeforeShadow !== hook) fail(`shadows not put back: ${before.join(',')} -> ${after.join(',')}`);
  else console.log(`  ok   all 8 corners of ${b.x1 - b.x0} x ${b.z1 - b.z0} m inside, each caster picks its program, then back to ${cam.right * 2} m`);
}

console.log('Loose bikes, boards and syringes stop drawing where the fog has hidden them');
{
  // Past PICKUP_DRAW_RANGE even the thinnest fog leaves under 2% of an object; seen from the woods the far ones
  // were some 50 draw calls a frame. Each view hides its far models by that range.
  const thinnest = Math.min(...Object.values(FOG_DENSITY));
  const left = fogLeft(PICKUP_DRAW_RANGE, thinnest);
  const views = ['Bicycles', 'Skateboards', 'Syringes'].filter((f) => {
    const src = readFileSync(new URL(`../src/gameplay/${f}.ts`, import.meta.url), 'utf8');
    return !/model\.root\.visible = [^;]*PICKUP_DRAW_RANGE/.test(src);
  });
  if (left >= 0.02) fail(`fog leaves ${(left * 100).toFixed(1)}% at ${PICKUP_DRAW_RANGE} m (density ${thinnest})`);
  else if (views.length) fail(`views that still draw past ${PICKUP_DRAW_RANGE} m: ${views.join(', ')}`);
  else console.log(`  ok   ${(left * 100).toFixed(1)}% left at ${PICKUP_DRAW_RANGE} m in the thinnest fog; bikes, boards and syringes hide past it`);
}

console.log('A loose skateboard is a handful of draws');
{
  // Each board was 17 meshes (deck, 8 truck parts, 4 wheels, 4 hubs), 17 draws and 13 shadow draws: six boards in
  // view near the woods were 68 draws a frame. Parts of one material that move together are one mesh now.
  // Skateboards.ts plays sounds through the AudioEngine, whose recordings come from Vite: a silent stand-in here.
  register('data:text/javascript,' + encodeURIComponent('export async function resolve(s, c, next) { return /\\/audio\\/AudioEngine(\\.ts)?$/.test(s) '
    + "? { url: 'data:text/javascript,export const audio = new Proxy({}, { get: () => () => {} });', shortCircuit: true } : next(s, c); }"));
  const { createBoard } = await import('../src/gameplay/Skateboards');
  const board = createBoard(0);
  let draws = 0, shadow = 0;
  board.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { draws++; if (o.castShadow) shadow++; } });
  const spinning = board.axles.every((a) => a.children.length === 2 && a.children.every((m) => (m as THREE.Mesh).isMesh));
  board.dispose();
  if (draws > 6 || shadow > 4) fail(`a board takes ${draws} draws and ${shadow} shadow draws`);
  else if (!spinning) fail('each axle should carry its wheels and hubs, so they spin with it');
  else console.log(`  ok   ${draws} draws and ${shadow} shadow draws a board (was 17 and 13), wheels and hubs on the spinning axles`);
}

console.log('A boost syringe is a handful of draws');
{
  // Each syringe was 14 meshes: 13 draws and 9 shadow draws lying capped on a counter, and every one within the
  // pickup draw range drew, through the house walls. The white parts, the dark rings and the plunger's rod and
  // thumb rest are one mesh each now (the plunger's parts still ride on the plunger).
  const { SyringeModel } = await import('../src/gameplay/Syringes');
  const s = new SyringeModel('strength');
  s.setCap(true);
  let draws = 0, shadow = 0;
  s.root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    let shown = true;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) shown = false;
    if (shown) draws++;
    if (shown && o.castShadow) shadow++;
  });
  const plunger = s.root.children.find((c) => !(c as THREE.Mesh).isMesh);
  const before = plunger?.position.z ?? 0;
  s.setFill(0);
  const travels = !!plunger && plunger.children.length === 2 && plunger.position.z - before > 0.08;
  s.dispose();
  if (draws > 7 || shadow > 5) fail(`a capped syringe takes ${draws} draws and ${shadow} shadow draws`);
  else if (!travels) fail('the stopper, rod and thumb rest should be the two meshes on the plunger, pushed home together');
  else console.log(`  ok   ${draws} draws and ${shadow} shadow draws a syringe (was 13 and 9), the plunger's parts pushed home together`);
}

console.log('A door is a few draws, not one per part');
{
  // Every door drew each part on its own: a wooden door 7 draws (slab, four panels, two knobs), the garage door 21
  // (ten slats, ten seams, the handle), 336 draws and 335 shadow draws for the map's 46 doors. Parts of one material
  // that move together are one mesh now. The panels keep the leaf-wide UVs, so bullet holes still go through them.
  const doors = new DoorSystem(map, phys, new THREE.Group());
  const most = { wood: 3, glass: 4, rollup: 3 };
  let total = 0, shadow = 0, worst = '';
  for (const d of doors.doors) {
    let n = 0, cast = 0;
    d.pivot.traverse((o) => { if ((o as THREE.Mesh).isMesh) { n++; total++; if (o.castShadow) { shadow++; cast++; } } });
    const style = d.spec.style ?? 'wood';
    if (n > most[style] && !worst) worst = `a ${style} door takes ${n} draws`;
    // The knobs are too small to show a moon shadow: a wooden door's shadow is the slab and its panels.
    if (style === 'wood' && cast > 2) worst ||= `a wooden door casts ${cast} shadow draws (its knobs should cast none)`;
    if (style === 'rollup') {
      const panel = d.pivot.children.find((c) => !(c as THREE.Mesh).isMesh);
      if (!panel || panel.children.length !== 3) worst ||= 'the garage door\'s slats, seams and handle should be the three meshes on its sliding panel';
    }
    if (style === 'wood') {
      // The panels' mesh: its UVs are where each corner sits on the leaf.
      const panels = d.pivot.children.find((c) => (c as THREE.Mesh).geometry?.attributes.position.count === 96) as THREE.Mesh | undefined;
      const pos = panels?.geometry.attributes.position, uv = panels?.geometry.attributes.uv;
      let off = panels ? 0 : Infinity;
      if (pos && uv) for (let i = 0; i < pos.count; i++) off = Math.max(off, Math.abs(uv.getX(i) * d.spec.w - pos.getX(i)), Math.abs(uv.getY(i) * d.spec.h - pos.getY(i)));
      if (off > 1e-5) worst ||= `a wooden door's panels are off the leaf's damage map by ${off}`;
    }
  }
  if (worst) fail(worst);
  else console.log(`  ok   ${doors.doors.length} doors: ${total} draws and ${shadow} shadow draws (was 336 and 335), knobs cast no shadow, panels on the leaf's damage map`);
}

console.log('Flesh chunks build without three.js warnings');
{
  // The lump asked an already non-indexed icosahedron for toNonIndexed(): a console warning every night, and the
  // geometry it then used had been disposed (it was the same object).
  const { FleshChunks } = await import('../src/effects/Chunks');
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
  let chunks: InstanceType<typeof FleshChunks> | null = null;
  try { chunks = new FleshChunks(phys); } finally { console.warn = warn; }
  const g = chunks!.mesh.geometry;
  if (said.length) fail(`building the chunks warned: ${said[0]}`);
  else if (g.index || !g.attributes.normal || g.attributes.uv) fail('the lump should be faceted: non-indexed, normals, no uv');
  else console.log(`  ok   no warnings; the lump is ${g.attributes.position.count / 3} facets`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL WORLD CHECKS PASSED');
process.exit(failures ? 1 : 0);
