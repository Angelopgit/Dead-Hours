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
