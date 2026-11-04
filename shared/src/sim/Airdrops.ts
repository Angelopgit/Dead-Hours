import { RAPIER, GROUP, groups } from '../physics/Physics';
import { SERUM, SUPPLY_DROPS, caseSpot } from '../config/drops';
import { WEAPONS, type WeaponId } from '../config/weapons';
import type { HeliFlight } from './events';
import { NAV_INDOOR, NAV_NEAR_WALL } from './NavGrid';
import { dist2D, type Vec3 } from './math';
import type { Simulation, SupplyDrop } from './Simulation';

/** "a, b and c" (blanks left out), for notices. */
const list = (items: string[]): string => {
  const xs = items.filter(Boolean);
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

/**
 * Helicopter supply drops: when the next one is due, where it can land (open ground the
 * helicopter can reach), what it carries (now and then an exclusive weapon or a Halberg serum),
 * and clearing a crate away once it is emptied. Split out of Simulation, whose state it works on.
 */
export class Airdrops {
  constructor(private readonly s: Simulation) {}


  runDrops(): void {
    const D = SUPPLY_DROPS;
    if (this.s.phaseTime >= this.s.nextDropAt) {
      const flight = this.planFlight();
      if (flight) {
        const id = this.s.drops.length;
        const weapon = this.rollExclusive();
        const serum = this.forceSerum || this.s.rand() < D.serumChance;
        this.forceSerum = false;
        const frags = this.s.rand() < D.fragChance;
        const molotovs = this.s.rand() < D.molotovChance;
        this.s.drops.push({ id, flight, stage: 'inbound', interactable: -1, body: null, weapon, caseItem: -1, serum, serumItem: -1, frags, molotovs });
        this.s.emit({ type: 'heli', drop: id, flight, ...(weapon ? { weapon } : {}), ...(serum ? { serum } : {}) });
        const packed = list(['Universal ammo', frags ? 'grenades' : '', molotovs ? 'Molotovs' : '']);
        const extras = [weapon ? `${WEAPONS[weapon].model} aboard` : '', serum ? `${SERUM.name} aboard` : ''].filter(Boolean);
        if (extras.length) this.s.emit({ type: 'notice', player: null, text: 'RARE SUPPLY DROP INBOUND', sub: `${packed}. ${list(extras)}.` });
        else this.s.emit({ type: 'notice', player: null, text: 'SUPPLY DROP INBOUND', sub: frags || molotovs ? `${packed}.` : 'Universal ammo. It refills every gun.' });
        const [lo, hi] = D.interval;
        this.s.nextDropAt = this.s.phaseTime + lo + this.s.rand() * (hi - lo);
      } else {
        this.s.nextDropAt = this.s.phaseTime + 5;
      }
    }
    for (const d of this.s.drops) {
      const f = d.flight;
      if (d.stage === 'inbound') {
        if (this.s.time >= f.arrive && this.s.time - this.lastDt() < f.arrive) this.s.noise(f.ground, D.hoverNoise, null);
        if (this.s.time >= f.release) {
          d.stage = 'falling';
          this.s.noise(f.ground, D.hoverNoise, null);
          this.s.emit({ type: 'supplyDrop', drop: d.id, stage: 'released', pos: { x: f.over.x, y: f.ground.y + f.releaseHeight, z: f.over.z } });
        }
      } else if (d.stage === 'falling' && this.s.time >= f.land) {
        d.stage = 'landed';
        const g = f.ground;
        const alive = [...this.s.players.values()].filter((p) => p.alive).length;
        d.interactable = this.s.interactables.length;
        this.s.interactables.push({
          id: d.interactable, kind: 'supply', pos: { x: g.x, y: g.y + 0.5, z: g.z },
          supply: D.baseUses + alive, range: 2.1, takenBy: new Map(),
          ...(d.frags ? { frags: true } : {}), ...(d.molotovs ? { molotovs: true } : {}),
        });
        // A solid crate: people walk around it, not through it.
        const w = this.s.physics.world;
        d.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(g.x, g.y + 0.36, g.z));
        w.createCollider(RAPIER.ColliderDesc.cuboid(0.55, 0.36, 0.38).setCollisionGroups(groups(GROUP.dynamic, 0xffff)), d.body);
        if (d.weapon) {
          const c = caseSpot(f);
          d.caseItem = this.s.interactables.length;
          this.s.interactables.push({ id: d.caseItem, kind: 'exclusive', pos: { x: c.x, y: c.y + 0.2, z: c.z }, supply: 1, range: 1.9, weapon: d.weapon });
        }
        if (d.serum) {
          const c = caseSpot(f, -1);
          d.serumItem = this.s.interactables.length;
          this.s.interactables.push({ id: d.serumItem, kind: 'serum', pos: { x: c.x, y: c.y + 0.2, z: c.z }, supply: 1, range: 1.9 });
        }
        this.s.noise(g, D.landNoise, null);
        this.s.emit({ type: 'supplyDrop', drop: d.id, stage: 'landed', pos: { ...g } });
      } else if (d.stage === 'landed' && this.s.time - f.land > D.lifetime) {
        this.removeDrop(d);
      }
    }
  }

  /** Whether this drop carries an exclusive weapon, and which: rarely before three minutes survived. */
  private rollExclusive(): WeaponId | null {
    const D = SUPPLY_DROPS;
    if (this.forceExclusive) {
      const w = this.forceExclusive;
      this.forceExclusive = null;
      return w;
    }
    if (this.s.rand() >= (this.s.phaseTime < D.exclusiveAfter ? D.exclusiveEarly : D.exclusiveChance)) return null;
    const total = D.exclusiveWeights.reduce((s, [, k]) => s + k, 0);
    let x = this.s.rand() * total;
    for (const [w, k] of D.exclusiveWeights) if ((x -= k) < 0) return w;
    return D.exclusiveWeights[D.exclusiveWeights.length - 1][0];
  }

  private lastDt(): number {
    return this.s.stepDt;
  }

  private removeDrop(d: SupplyDrop): void {
    if (d.stage === 'gone') return;
    d.stage = 'gone';
    if (d.interactable >= 0) this.s.interactables[d.interactable].supply = 0;
    if (d.caseItem >= 0) this.s.interactables[d.caseItem].supply = 0;
    if (d.serumItem >= 0) this.s.interactables[d.serumItem].supply = 0;
    if (d.body) this.s.physics.world.removeRigidBody(d.body);
    d.body = null;
    this.s.emit({ type: 'supplyDrop', drop: d.id, stage: 'gone', pos: { ...d.flight.ground } });
  }

  /** Open ground for a crate to land on: flat walkable cells all around, nothing overhead. */
  private openGround(pos: Vec3): boolean {
    const nav = this.s.nav;
    const r = SUPPLY_DROPS.clearRadius;
    for (let dz = -r; dz <= r; dz += 0.5) {
      for (let dx = -r; dx <= r; dx += 0.5) {
        if (dx * dx + dz * dz > r * r) continue;
        const m = nav.nodeAt(pos.x + dx, pos.y, pos.z + dz, 0);
        if (!nav.reachable(m) || nav.flags[m] & (NAV_INDOOR | NAV_NEAR_WALL) || Math.abs(nav.nodeY[m] - pos.y) > 0.2) return false;
      }
    }
    for (const o of this.s.overhead) if (Math.hypot(o.x - pos.x, o.z - pos.z) < o.r + 1.4) return false;
    for (const [dx, dz] of [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
      if (this.s.physics.raycast(pos.x + dx, pos.y + 0.6, pos.z + dz, 0, 1, 0, 60) !== null) return false;
    }
    return true;
  }

  /** Picks a landing spot near the survivors and plans the helicopter's flight over it. */
  planFlight(): HeliFlight | null {
    const D = SUPPLY_DROPS;
    const alive = [...this.s.players.values()].filter((p) => p.alive);
    if (!alive.length || !this.s.outdoorNodes.length) return null;
    for (let tries = 0; tries < 200; tries++) {
      // Somewhere in the distance band around one of the survivors.
      const who = alive[Math.floor(this.s.rand() * alive.length)].motion.pos;
      const ang = this.s.rand() * Math.PI * 2, dd = D.minDistance + this.s.rand() * (D.maxDistance - D.minDistance);
      const n = this.s.nav.nodeAt(who.x + Math.cos(ang) * dd, 0.1, who.z + Math.sin(ang) * dd, 0.5);
      if (!this.s.nav.reachable(n) || this.s.nav.flags[n] & NAV_INDOOR) continue;
      const pos = this.s.nav.nodePos(n);
      let nearest = Infinity;
      for (const p of alive) nearest = Math.min(nearest, dist2D(p.motion.pos, pos));
      if (nearest < D.minDistance || nearest > D.maxDistance) continue;
      if (!this.openGround(pos)) continue;
      const a = this.s.rand() * Math.PI * 2;
      const b = a + (this.s.rand() < 0.5 ? -1 : 1) * (0.5 + this.s.rand() * 0.6);
      const reach = this.s.map.halfExtent + 45;
      const over = { x: pos.x, y: pos.y + D.altitude, z: pos.z };
      const from = { x: over.x - Math.cos(a) * reach, y: over.y + 6, z: over.z - Math.sin(a) * reach };
      const to = { x: over.x + Math.cos(b) * reach, y: over.y + 10, z: over.z + Math.sin(b) * reach };
      const start = this.s.time;
      // Cruise, then a few seconds slowing into the hover (the client eases the same way).
      const arrive = start + dist2D(from, over) / D.speed + 2.5;
      const release = arrive + D.hover;
      const leave = release + D.linger;
      const end = leave + dist2D(over, to) / D.speed + 2.5;
      return {
        from, over, to, start, arrive, release, leave, end,
        ground: { x: pos.x, y: pos.y, z: pos.z }, land: release + D.releaseHeight / D.fallSpeed, releaseHeight: D.releaseHeight,
      };
    }
    return null;
  }

  /** The next drop carries this weapon whatever the roll (debugging and tests). */
  forceExclusive: WeaponId | null = null;

  /** The next drop carries a Halberg serum whatever the roll (debugging and tests). */
  forceSerum = false;

  /** Starts a supply drop now (debugging and tests); `weapon` puts an exclusive in it, `serum` a serum. */
  callSupplyDrop(weapon?: WeaponId, serum = false): SupplyDrop | null {
    if (weapon && WEAPONS[weapon]?.exclusive) this.forceExclusive = weapon;
    if (serum) this.forceSerum = true;
    if (this.s.phase !== 'survival') return null;
    this.s.nextDropAt = this.s.phaseTime;
    this.runDrops();
    const d = this.s.drops[this.s.drops.length - 1];
    return d && d.stage === 'inbound' && d.flight.start === this.s.time ? d : null;
  }
}
