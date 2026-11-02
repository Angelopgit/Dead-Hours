import * as THREE from 'three';

/**
 * Getting a night ready before it is shown: every shader it can need compiled, every texture on
 * the GPU, and the compiled programs kept for the rest of the visit. Without this the first frame
 * of a night recompiles every lit material (the night adds lights), and the first zombie, gib,
 * blast or supply drop compiles its own shaders mid-fight: a stall of up to seconds on a slow GPU,
 * long enough online to miss the server's pings.
 */

/** The next task: lets the page breathe (sockets, the loading screen) between chunks of work. */
export const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** The next animation frame (or a moment, if the page is hidden and frames are held back). */
export const nextFrame = (): Promise<void> => new Promise((r) => {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    r();
  };
  requestAnimationFrame(go);
  setTimeout(go, 100);
});

/** The parts of three's WebGLProgram used here (not in its public types). */
interface Program {
  usedTimes: number;
  isReady(): boolean;
  getUniforms(): unknown;
}

let offscreen: THREE.WebGLRenderTarget | null = null;

/**
 * Starts compiling every material under `scene` (visible or not) for `targetScene`'s current
 * lights, the way the game draws them: into a render target (PostFX draws the scene into its own
 * target and grades it after), which leaves tone mapping and the output conversion out of the
 * shaders. Compiled with the canvas bound instead, every one would be a different program from the
 * one the first frame asks for.
 */
export function compileForPost(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Scene): Set<THREE.Material> {
  offscreen ??= new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(offscreen);
  try {
    return renderer.compile(scene, camera, targetScene);
  } finally {
    renderer.setRenderTarget(prev);
  }
}

/**
 * Compiles every material under `scene` as its first frame would (see compileForPost), without
 * freezing the page. Where the GPU compiles in parallel (KHR_parallel_shader_compile, most desktop
 * browsers) all of them are started at once and this waits until they are done; elsewhere each
 * program is linked in its own task. `stop` abandons it.
 */
export async function compileScene(
  renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, targetScene: THREE.Scene,
  onProgress: (f: number) => void, stop: () => boolean = () => false,
): Promise<void> {
  const materials = compileForPost(renderer, scene, camera, targetScene);
  const programs = new Set<Program>();
  for (const m of materials) {
    const p = (renderer.properties.get(m) as { currentProgram?: Program }).currentProgram;
    if (p) programs.add(p);
  }
  const list = [...programs];
  if (!list.length) return onProgress(1);
  if (renderer.extensions.has('KHR_parallel_shader_compile')) {
    for (;;) {
      const ready = list.filter((p) => p.isReady()).length;
      onProgress(ready / list.length);
      if (ready === list.length || stop()) return;
      await nextFrame();
    }
  }
  let done = 0;
  for (const p of list) {
    if (stop()) return;
    // Links it now (the first draw would otherwise, all of them in one frame).
    p.getUniforms();
    onProgress(++done / list.length);
    await nextTask();
  }
}

/** Every texture the materials under `root` use (maps and shader uniforms). */
function texturesOf(root: THREE.Object3D): Set<THREE.Texture> {
  const out = new Set<THREE.Texture>();
  const take = (v: unknown) => {
    const t = v as THREE.Texture | null;
    if (t && t.isTexture && !(t as { isRenderTargetTexture?: boolean }).isRenderTargetTexture && t.image) out.add(t);
  };
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const v of Object.values(m)) take(v);
      const uniforms = (m as THREE.ShaderMaterial).uniforms;
      if (uniforms) for (const u of Object.values(uniforms)) take(u?.value);
    }
  });
  return out;
}

/** Puts every texture under `root` on the GPU (a few milliseconds of uploads per task). */
export async function uploadTextures(renderer: THREE.WebGLRenderer, root: THREE.Object3D, onProgress: (f: number) => void, stop: () => boolean = () => false): Promise<void> {
  const list = [...texturesOf(root)];
  let i = 0;
  while (i < list.length && !stop()) {
    const end = performance.now() + 12;
    while (i < list.length && performance.now() < end) renderer.initTexture(list[i++]);
    onProgress(i / list.length);
    await nextTask();
  }
  onProgress(1);
}

const pinned = new WeakSet<object>();

/**
 * Keeps every shader program compiled so far for the rest of the visit. three throws a program
 * away when the last material using it is disposed or switches to another set of lights, so
 * without this every night (and every return to the menu, whose lights differ) compiled the
 * world's shaders again, and every night's zombies, gore and blasts compiled theirs again.
 */
export function pinPrograms(renderer: THREE.WebGLRenderer): number {
  let n = 0;
  for (const p of (renderer.info.programs ?? []) as unknown as Program[]) {
    if (pinned.has(p)) continue;
    pinned.add(p);
    p.usedTimes++;
    n++;
  }
  return n;
}
