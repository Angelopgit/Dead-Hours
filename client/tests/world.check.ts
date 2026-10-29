/**
 * Headless world checks: walks a character controller (configured like PlayerController)
 * through the shared map's real collision. Run with `npm run check:world -w client`.
 *
 * Covers spawn clearance, every doorway in both directions, stairs to the upper floor and
 * basement, the backyard passages, routes into each district, door leaves blocking when
 * closed and clearing when open, and furniture clipping into walls.
 */
import * as THREE from 'three';
import { MAPLE_HOLLOW as map, PLAYER, propColliders } from '@dead-hours/shared';
import { Physics, initPhysics, RAPIER, GROUP, groups } from '../src/core/Physics';
import { DoorSystem } from '../src/gameplay/Doors';

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

console.log('Narrow backyard passages');
// Sheds sit ~1.2 m from a lot divider; walk the gap between the shed's side and the fence.
const dividers = [-40, -14.5, 17, 40, -31, -4, 24, 47];
for (const s of map.props.filter((p) => p.kind === 'shed')) {
  const fx = dividers.reduce((a, b) => (Math.abs(b - s.x) < Math.abs(a - s.x) ? b : a));
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

console.log(failures ? `\n${failures} FAILURES` : '\nALL WORLD CHECKS PASSED');
process.exit(failures ? 1 : 0);
