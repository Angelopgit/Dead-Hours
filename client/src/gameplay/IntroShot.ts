import gsap from 'gsap';

/** The opening shot's camera: where it is (px, py, pz) and the point it looks at (tx, ty, tz). */
export interface IntroCam { px: number; py: number; pz: number; tx: number; ty: number; tz: number }

/**
 * Where the establishing shot starts and where it has drifted to by the glide. It looks at the
 * safehouse from the far side of Hale Street, so it crosses the south sidewalk's poles and lights
 * (z 7.9: a utility pole every 24 m with three wires sagging to about 7.95 m, a streetlight between):
 * it goes between the streetlight at x -18 and the pole at -8, starting below the wires and passing
 * 2 m under them. It used to start at x -18 and 9 m up, which flew it 0.24 m past the pole at -8
 * and level with the wires 4 m in front of them, so they crossed the screen as thick black bars.
 * check:world keeps the path 2 m from poles and lights and 1.5 m from the wires.
 */
export const INTRO_FROM: IntroCam = { px: -22, py: 7, pz: 14, tx: 0, ty: 3, tz: -18 };
export const INTRO_DRIFT: IntroCam = { px: -10, py: 5.5, pz: 6, tx: 1, ty: 2.2, tz: -15 };

/**
 * Fade from black, the establishing shot, a glide down to the survivor, then a dip to black over the
 * hand-over. Tweens `c` (and `fade.opacity`); `done` runs at the end.
 */
export function introTimeline(c: IntroCam, survivor: { x: number; z: number }, fade: object, done: () => void): gsap.core.Timeline {
  Object.assign(c, INTRO_FROM);
  gsap.set(fade, { opacity: 1 });
  const { px, py, pz, tx, ty, tz } = INTRO_DRIFT;
  return gsap.timeline({ onComplete: done })
    .to(fade, { opacity: 0, duration: 1.4, ease: 'power2.out' }, 0)
    .to(c, { px, py, pz, duration: 4.5, ease: 'sine.inOut' }, 0)
    .to(c, { tx, ty, tz, duration: 4.5, ease: 'sine.inOut' }, 0)
    .to(c, { px: 2.8, py: 2.1, pz: -11.5, tx: survivor.x, ty: 1.4, tz: survivor.z, duration: 2.6, ease: 'power2.inOut' }, 4.2)
    .to(fade, { opacity: 1, duration: 0.45, ease: 'power1.in' }, 6.4)
    .to(fade, { opacity: 0, duration: 0.6, ease: 'power1.out' }, 6.95);
}
