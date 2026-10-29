/** Room names registered on the Colyseus server. */
export const ROOMS = {
  survival: 'survival',
} as const;

/** Client → server messages. */
export const C2S = {
  input: 'input',
  ready: 'ready',
  selectLoadout: 'loadout',
} as const;

/** Server → client messages. */
export const S2C = {
  notice: 'notice',
} as const;

/** Compact per-tick input frame sent by clients (prediction + reconciliation from Phase 4). */
export interface InputFrame {
  seq: number;
  dt: number;
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  aim: boolean;
}

export interface JoinOptions {
  name: string;
  primary: string;
  secondary: string;
  /** encodeAppearance() of the survivor's look; the server sanitizes it and shares it in the room state. */
  appearance: string;
}
