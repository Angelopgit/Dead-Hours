/**
 * Headless controller and touch checks: aim assist geometry against a fake world, and the
 * stick response curve. Run with `npm run check:controls`.
 *
 * Aim assist must pull onto a zombie near the crosshair only while the player moves or turns
 * (or just pressed aim), never through a wall, never onto one outside its cone, and never
 * when switched off.
 */
import * as THREE from 'three';
import type { Simulation } from '@dead-hours/shared';
import type { Physics } from '../src/core/Physics';
import { AimAssist } from '../src/gameplay/AimAssist';

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) console.log('  ok   ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
};

let wall: number | null = null;
const physics = { raycast: () => wall } as unknown as Physics;
const zombie = (x: number, z: number, alive = true) => ({ alive, pos: { x, y: 0, z }, scale: 1, def: { height: 1.75, radius: 0.3 } });

/** Camera at eye height looking down -Z (yaw 0). */
const origin = new THREE.Vector3(0, 1.6, 0);
const dirFor = (yaw: number, pitch: number) => new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
const chestPitch = Math.atan2(1.75 * 0.68 - 1.6, 12);

/** Runs the assist for `secs` at 60 fps, turning the view as the game does; returns the angle left (deg). */
function run(sim: Simulation, start: number, opts: { aiming: boolean; active: boolean; level?: 'off' | 'low' | 'standard'; secs?: number; snap?: boolean }): number {
  const a = new AimAssist(physics);
  if (opts.snap) a.aimPressed();
  let yaw = start, pitch = chestPitch;
  for (let i = 0; i < (opts.secs ?? 1) * 60; i++) {
    const r = a.update(1 / 60, sim, origin, dirFor(yaw, pitch), yaw, pitch, opts.aiming, opts.active, opts.level ?? 'standard');
    if (r) { yaw += r.yaw; pitch += r.pitch; }
  }
  const z = sim.zombies[0];
  const want = Math.atan2(-(z.pos.x - origin.x), -(z.pos.z - origin.z));
  return Math.abs(THREE.MathUtils.radToDeg(want - yaw));
}

const sim = { zombies: [zombie(0, -12)] } as unknown as Simulation;
const off = THREE.MathUtils.degToRad(4);

console.log('Aim assist');
check(run(sim, off, { aiming: true, active: true }) < 0.5, 'aiming and moving: pulls onto a zombie 4° off the crosshair');
check(run(sim, off, { aiming: false, active: true }) < 1, 'hip fire and moving: pulls too, more gently');
check(Math.abs(run(sim, off, { aiming: true, active: false }) - 4) < 0.01, 'standing still with the stick at rest: no pull');
check(run(sim, off, { aiming: true, active: false, snap: true, secs: 0.3 }) < 1.5, 'just pressed aim: snaps onto it even standing still');
check(Math.abs(run(sim, off, { aiming: true, active: true, level: 'off' }) - 4) < 0.01, 'switched off: no pull');
const low = run(sim, off, { aiming: true, active: true, level: 'low', secs: 0.3 });
const std = run(sim, off, { aiming: true, active: true, secs: 0.3 });
check(low < 4 && low > std, `low helps less than standard (${low.toFixed(2)}° vs ${std.toFixed(2)}° left after 0.3 s)`);
const far = THREE.MathUtils.degToRad(15);
check(Math.abs(run(sim, far, { aiming: true, active: true }) - 15) < 0.01, 'a zombie 15° away is left alone');
wall = 5;
check(Math.abs(run(sim, off, { aiming: true, active: true }) - 4) < 0.01, 'behind a wall: no pull');
wall = null;
check(Math.abs(run({ zombies: [zombie(0, -12, false)] } as unknown as Simulation, off, { aiming: true, active: true }) - 4) < 0.01, 'dead zombies are ignored');
check(Math.abs(run({ zombies: [zombie(0, -80)] } as unknown as Simulation, THREE.MathUtils.degToRad(1), { aiming: true, active: true }) - 1) < 0.01, 'out of range (80 m) is ignored');

const a = new AimAssist(physics);
const on = a.update(1 / 60, sim, origin, dirFor(0, chestPitch), 0, chestPitch, true, false, 'standard');
check(!!on && on.friction < 0.6, `on target: turning slows (friction ${on?.friction.toFixed(2)})`);
const none = a.update(1 / 60, { zombies: [] } as unknown as Simulation, origin, dirFor(0, 0), 0, 0, true, false, 'standard');
check(none === null, 'nothing near: full speed');

console.log(failures ? `\n${failures} FAILED` : '\nALL CONTROL CHECKS PASSED');
process.exit(failures ? 1 : 0);
