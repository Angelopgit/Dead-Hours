/**
 * Bone order of the character skeleton (skinIndex values). The character faces +Z, so local +X
 * is its left side: armL/legL sit at +X.
 */
export const BONE = {
  hips: 0, spine: 1, head: 2,
  armLUpper: 3, armLLower: 4, armRUpper: 5, armRLower: 6,
  legLUpper: 7, legLLower: 8, legRUpper: 9, legRLower: 10,
} as const;
export const BONE_COUNT = 11;
