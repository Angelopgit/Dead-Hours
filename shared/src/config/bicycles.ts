/**
 * Bicycles left lying around the neighbourhood: pick one up and pedal off, quicker than a
 * skateboard and good for two. Online a second survivor can hop on the pegs over the back wheel
 * and shoot while the rider pedals (the rider's hands stay on the bars: the bell is all they can
 * work). A hard hit knocks a survivor off, and a wall taken head-on at speed throws both.
 */
export const BICYCLE = {
  /** Bikes on the map each night (one of them near the safehouse, so it gets found). */
  count: 4,
  /** The one near the safehouse lies this far from the first spawn inside it (metres). */
  nearSafehouse: [5, 18] as const,
  /** The others lie at least this far from the spawn and from each other. */
  spacing: 30,
  /** And this far from any skateboard (they'd lie on top of each other). */
  clearOfBoards: 3,
  /** How close the feet must be to pick one up or hop on the pegs (across the floor), and how far above or below. */
  reach: 2.1,
  reachUp: 1.0,
  /** The pegs can only be hopped onto while the bike goes slower than this (m/s). */
  pegMaxSpeed: 3.5,

  // ---- riding (client prediction; the server only checks speeds against maxSpeed)
  /** Top speed pedalling, and standing up on the pedals (sprint held). */
  pedalTop: 10.5,
  sprintTop: 13.5,
  /** Speed gained per second from a standstill at full effort; it tails off over the last part of the way to the top. */
  pedalAccel: 6.5,
  pedalEase: 2.2,
  /** Wheel turns per turn of the cranks (the gearing), and the slowest cadence (rad/s) when setting off. */
  gear: 2.6,
  minCadence: 4,
  /** Rolling resistance (m/s²) and air drag (per (m/s)²) while coasting. */
  rolling: 0.12,
  drag: 0.0028,
  /** Coasting slower than this (m/s) it slows this much more (m/s²): a foot goes down and it comes to rest. */
  settleBelow: 2.5,
  settle: 0.55,
  /** Grass and dirt: extra slowing (m/s²), and the share of the pedalling that still counts. */
  offRoad: 1.6,
  offRoadPedal: 0.6,
  /** Hand brakes (m/s² at full stick). */
  brake: 9,
  /** Braking this hard (share of full) above this speed skids the back tyre. */
  skidBrake: 0.6,
  skidSpeed: 4,
  /** Turn rate (rad/s): walking the bike round on the spot, at riding pace, and at top speed. */
  turnStill: 1.3,
  turnSlow: 2.3,
  turnFast: 0.95,
  /** Steering reaches this share of its rate in the air. */
  airTurn: 0.25,
  /** Most a bike leans into a turn (radians). */
  maxLean: 0.5,
  /** Bunny hop (alone only: not with someone on the pegs). */
  hop: 3.6,
  /** Hop onto the saddle (a little lift as the rider swings a leg over). */
  mountHop: 0.8,
  /** Carrying someone on the pegs: top speed and pick-up shrink to these shares. */
  loadTop: 0.88,
  loadAccel: 0.7,
  /** Taking a wall head-on faster than this throws the rider (and the passenger) off. */
  bailSpeed: 6,
  bailKeep: 0.35,
  /** Front wheel ahead of the rider's middle (the probe that stops it going into walls), at this height. */
  frontReach: 1.05,
  frontProbe: 0.42,
  /** Getting off keeps at most this much of the speed (running it out). */
  stepOffSpeed: 5,
  /** Hard cap, and what the server lets a rider (or a passenger) move at (with its usual slack on top). */
  maxSpeed: 15,

  // ---- what the bike does to everything else
  /** Hits at least this hard knock a survivor off (a walker's swipe does, a screamer's doesn't). */
  knockDamage: 10,
  /** Riding is smoother than running: this share of the speed counts toward the spread of the passenger's shots. */
  spreadSpeed: 0.45,
  /** Tyres and the freewheel are heard this far at top speed (sprinting feet carry 11 m), every `noiseEvery` seconds. */
  noise: 5,
  noiseEvery: 0.4,
  /** A crash is heard this far; the bell this far (zombies come to it). */
  crashNoise: 10,
  bellNoise: 16,
  /** Seconds between rings. */
  bellEvery: 0.55,

  // ---- the bike itself (metres, origin on the ground under the saddle, +Z the front)
  wheel: 0.33,
  rearAxle: -0.42,
  frontAxle: 0.8,
  /** Where a passenger stands: on the pegs over the rear axle, this high off the ground (the soles on top of the pegs). */
  pegBack: 0.42,
  pegHeight: 0.36,
  /** Hips of the rider over the saddle (relative to the ground under it). */
  seat: 0.99,
  /** Top of the saddle (height, and how far ahead of the origin). */
  saddle: { y: 0.92, z: -0.05 },
  /** The cranks' axle (height, how far ahead), the crank arms' length, and how far out the pedals sit. */
  bottomBracket: { y: 0.3, z: 0.17 },
  crank: 0.165,
  pedalOut: 0.13,
  /** The handlebar grips (half the width, height, how far ahead) and the steering axis's foot (head tube, how far ahead). */
  grips: { x: 0.29, y: 1.1, z: 0.5 },
  head: { y: 0.95, z: 0.6 },
  /** How far out from the middle a passenger's feet stand on the pegs. */
  pegOut: 0.14,
  /** Frame colours to pick from. */
  looks: 6,
} as const;
