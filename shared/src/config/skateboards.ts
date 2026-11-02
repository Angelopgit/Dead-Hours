/**
 * Skateboards left lying around the neighbourhood: hop on, push off, carve down the street and
 * shoot from the deck. Riding is quieter than sprinting and a lot faster, but a hit knocks the
 * rider off and a wall taken head-on at speed throws them.
 */
export const SKATEBOARD = {
  /** Boards on the map each night (one of them near the safehouse, so it gets found). */
  count: 6,
  /** The one near the safehouse lies this far from the first spawn inside it (metres): the front walk or the sidewalk. */
  nearSafehouse: [6, 17] as const,
  /** The others lie at least this far from the spawn and from each other. */
  spacing: 24,
  /** How close the feet must be to hop on (across the floor), and how far above or below. */
  reach: 1.9,
  reachUp: 1.0,

  // ---- riding (client prediction; the server only checks speeds against maxSpeed)
  /** Top speed from pushing, and with sprint held (pushing hard). */
  pushTop: 9.5,
  sprintTop: 12.5,
  /** Seconds per kick: foot down, push back, foot back on the tail. */
  pushPeriod: 0.5,
  /** Part of the kick cycle the foot is on the ground pushing. */
  pushFrom: 0.16,
  pushTo: 0.64,
  /** Speed gained per second while the foot pushes, from a standstill; it tails off over the last half of the way to the top. */
  pushAccel: 15,
  pushEase: 2,
  /** Rolling resistance (m/s²) and air drag (per (m/s)²) while coasting. */
  rolling: 0.25,
  drag: 0.0035,
  /** Grass and dirt grab the wheels: extra slowing (m/s²), and the share of a push that still counts. */
  offRoad: 4.5,
  offRoadPush: 0.3,
  /** Braking with the back foot (m/s² at full stick). */
  brake: 7.5,
  /** Turn rate (rad/s) at walking pace (kick turns) and at top speed (wide carves). */
  turnSlow: 2.9,
  turnFast: 1.6,
  /** Steering reaches this share of its rate in the air. */
  airTurn: 0.35,
  /** Ollie: straight up off the tail. */
  ollie: 4.7,
  /** Hop onto the board (a little jump as the feet land on the deck). */
  mountHop: 1.8,
  /** Taking a wall head-on faster than this throws the rider off. */
  bailSpeed: 6.5,
  /** Share of the speed left after a head-on hit that counts as stopped dead. */
  bailKeep: 0.35,
  /** Stepping off keeps at most this much of the speed (running it out). */
  stepOffSpeed: 6,
  /** Hard cap, and what the server lets a rider move at (with its usual slack on top). */
  maxSpeed: 14,

  // ---- what the deck does to everything else
  /** Hits at least this hard knock the rider off (a zombie's swipe, a blast, a raider's round). */
  knockDamage: 7,
  /** Rolling is smooth: this share of the speed counts toward the spread of shots. */
  spreadSpeed: 0.4,
  /** Wheels on asphalt carry this far at top speed (sprinting feet carry 11 m), every `noiseEvery` seconds. */
  noise: 7,
  noiseEvery: 0.4,
  /** A landing after an ollie and a bail are heard this far. */
  landNoise: 9,

  // ---- the board itself
  /** Height of the deck's top above the ground (where the feet stand). */
  deck: 0.11,
  /** Length and width of the deck, and wheel radius. */
  length: 0.8,
  width: 0.205,
  wheel: 0.027,
  /** Deck graphics to pick from. */
  looks: 8,
} as const;
