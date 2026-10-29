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
