/** Letters and digits that can't be mistaken for each other when read out (no I, O, 0, 1). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 5;

const rooms = new Map<string, string>();

/** A fresh join code for a room. */
export function claimCode(roomId: string): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < LENGTH; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(code)) {
      rooms.set(code, roomId);
      return code;
    }
  }
}

export function releaseCode(code: string): void {
  rooms.delete(code);
}

/** The room a code belongs to (codes are typed in any case, with or without spaces). */
export function roomForCode(code: string): string | undefined {
  return rooms.get(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}
