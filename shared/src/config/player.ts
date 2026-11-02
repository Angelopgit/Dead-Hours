/** Movement tuning shared by client prediction and (later) server validation. */
export const PLAYER = {
  radius: 0.35,
  height: 1.8,
  crouchHeight: 1.2,
  eyeHeight: 1.62,
  walkSpeed: 3.4,
  sprintSpeed: 6.2,
  crouchSpeed: 1.7,
  aimSpeed: 2.3,
  acceleration: 14,
  airControl: 0.35,
  jumpVelocity: 5.2,
  gravity: -19.6,
  maxStepHeight: 0.4,
  maxSlopeDeg: 50,
  maxHealth: 100,
} as const;

/**
 * Going down instead of dying, while a teammate is still standing to pick you up. Alone (solo,
 * or the last one up) zero health is death as before.
 */
export const DOWNED = {
  /** Seconds a downed survivor lasts on their own. */
  bleedOut: 30,
  /** Bleed-out seconds each point of damage taken while down costs. */
  hitBleed: 0.4,
  /** Seconds a teammate holds interact to get them up (bleeding pauses meanwhile). */
  reviveTime: 4,
  /** How close the reviver must stay (metres, across the floor). */
  reviveRange: 1.9,
  /** Health they get up with. */
  reviveHealth: 30,
  /** Downs a survivor can come back from in one night; the next time at zero is death. */
  maxDowns: 2,
  crawlSpeed: 0.75,
  eyeHeight: 0.45,
} as const;

/**
 * Lying flat on the belly: a low, slow, quiet, steady stance. Zombies see a prone survivor at a
 * shorter range, and they hear less of them crawling; guns kick and spread less.
 */
export const PRONE = {
  /** Capsule height while lying down (the body is drawn longer: see reachAhead/reachBehind). */
  height: 0.7,
  /** Eye height above the ground, propped up on the elbows. */
  eyeHeight: 0.42,
  /** Belly crawl (m/s), and while aiming along the ground. */
  crawlSpeed: 1.0,
  aimSpeed: 0.55,
  /** Seconds to get down onto the belly and back up; crawling is slow meanwhile. */
  downTime: 0.35,
  upTime: 0.45,
  /**
   * The head end and the feet end of the body from the capsule (m): walls this close ahead or
   * behind push the body clear so the head and feet stay out of them.
   */
  reachAhead: 0.85,
  reachBehind: 0.85,
  /** How fast the body swings round to follow the view (rad/s). */
  turnRate: 3.2,
  /** How far the view can look up and down lying on the belly (radians). */
  pitchUp: 0.85,
  pitchDown: -0.6,
  /** Zombies see a prone survivor at this part of their sight range (crouching is 0.55). */
  sight: 0.38,
  /** Crawling is heard this far (m). */
  noise: 0.8,
  /** Cone of fire (crouching is 0.75). */
  spread: 0.55,
} as const;

/**
 * The dolphin dive: crouch (or prone) while sprinting throws the survivor forward through the
 * air onto their belly; they slide a little and end up prone.
 */
export const DIVE = {
  /** Moving at least this fast (m/s) on the ground while sprinting. */
  minSpeed: 4.4,
  /** Launch speed along the run (m/s), and upward. */
  speed: 7.0,
  lift: 3.4,
  /** Fraction of the speed the belly slide starts with on touchdown, and how fast it stops (m/s²). */
  slideKeep: 0.7,
  slideDecel: 11,
  /** Longest slide (s). */
  slideMax: 0.6,
  /** The thud of landing is heard this far (m). */
  noise: 7,
} as const;
