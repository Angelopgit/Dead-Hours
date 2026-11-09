import * as THREE from 'three';

/** Atlas cells. */
export const DECAL = { hole: 0, splat: 1, pool: 2, crack: 3 } as const;

function atlas(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S * 2;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, S * 2, S * 2);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blob = (cx: number, cy: number, r: number, lumps: number, jag: number) => {
    g.beginPath();
    const n = 28;
    const ph = rnd() * 6;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 + Math.sin(a * lumps + ph) * jag + (rnd() - 0.5) * jag * 0.8);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.fill();
  };
  // Bullet hole: dark core, chipped halo, hairline cracks.
  {
    const cx = S / 2, cy = S / 2;
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, S * 0.42);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.16, 'rgba(255,255,255,1)');
    rg.addColorStop(0.24, 'rgba(255,255,255,0.55)');
    rg.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 20, cy + Math.sin(a) * 20);
      g.lineTo(cx + Math.cos(a + (rnd() - 0.5) * 0.4) * (50 + rnd() * 50), cy + Math.sin(a + (rnd() - 0.5) * 0.4) * (50 + rnd() * 50));
      g.stroke();
    }
  }
  // Blood splatter: central blob, spatter and streaks to one side (+x is "away from the shot").
  {
    const ox = S, cx = ox + S * 0.42, cy = S / 2;
    g.fillStyle = 'rgba(255,255,255,0.95)';
    blob(cx, cy, S * 0.16, 5, 0.25);
    for (let i = 0; i < 26; i++) {
      const a = (rnd() - 0.5) * 2.2;
      const d = S * (0.15 + rnd() * 0.3);
      g.globalAlpha = 0.6 + rnd() * 0.4;
      blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, S * (0.012 + rnd() * 0.03), 3, 0.3);
    }
    g.globalAlpha = 0.75;
    for (let i = 0; i < 7; i++) {
      const a = (rnd() - 0.5) * 1.2;
      g.lineWidth = 3 + rnd() * 6;
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * S * 0.12, cy + Math.sin(a) * S * 0.12);
      g.lineTo(cx + Math.cos(a) * S * (0.3 + rnd() * 0.18), cy + Math.sin(a) * S * (0.3 + rnd() * 0.18));
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  // Pool: smooth, glossy-edged puddle.
  {
    const cx = S / 2, cy = S + S / 2;
    g.fillStyle = 'rgba(255,255,255,0.75)';
    blob(cx, cy, S * 0.4, 4, 0.12);
    g.fillStyle = 'rgba(255,255,255,1)';
    blob(cx, cy, S * 0.33, 5, 0.12);
  }
  // Cracked glass: radial cracks and a ring.
  {
    const cx = S + S / 2, cy = S + S / 2;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 1.5;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + rnd() * 0.3;
      g.beginPath();
      g.moveTo(cx, cy);
      let x = cx, y = cy;
      for (let k = 0; k < 4; k++) {
        x += Math.cos(a + (rnd() - 0.5) * 0.5) * 26;
        y += Math.sin(a + (rnd() - 0.5) * 0.5) * 26;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (const r of [22, 48]) {
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    g.arc(cx, cy, 7, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

const VERT = /* glsl */ `
  attribute float iCell;
  attribute vec4 iTint;
  varying vec2 vUv;
  varying vec4 vTint;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv * 0.5 + vec2(mod(iCell, 2.0), 1.0 - floor(iCell / 2.0)) * 0.5;
    vTint = iTint;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying vec4 vTint;
  #include <fog_pars_fragment>
  void main() {
    float a = texture2D(uAtlas, vUv).a * vTint.a;
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float ff = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float ff = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      a *= 1.0 - ff;
    #endif
    if (a < 0.004) discard;
    // Multiply blend: result = dst * mix(1, tint, a).
    gl_FragColor = vec4(vTint.rgb * a, a);
  }
`;

interface Slot { born: number; life: number; grow: number; size: number; alpha: number; active: boolean }

/** Queues slots lo..hi of an instanced attribute for upload, rather than the whole pool's buffer. */
function sendSlots(a: THREE.BufferAttribute, lo: number, hi = lo): void {
  if (hi < lo) return;
  a.addUpdateRange(lo * a.itemSize, (hi - lo + 1) * a.itemSize);
  a.needsUpdate = true;
}

/**
 * Surface marks (bullet holes, blood splatter, pools) as instanced quads that darken what is
 * under them (multiply blending). A fixed ring of slots: new marks recycle the oldest, and
 * every mark fades out at the end of its lifetime.
 */
export class DecalBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly tex: THREE.CanvasTexture;
  private readonly cell: Float32Array;
  private readonly tint: Float32Array;
  private readonly slots: Slot[] = [];
  private readonly matrices: THREE.Matrix4[] = [];
  private next = 0;
  private capacity: number;
  private time = 0;
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly z = new THREE.Vector3(0, 0, 1);
  private readonly e = new THREE.Vector3();
  private readonly qd = new THREE.Quaternion();
  private readonly sc = new THREE.Vector3();

  constructor(private readonly maxCapacity: number) {
    this.capacity = maxCapacity;
    this.tex = atlas();
    const geo = new THREE.PlaneGeometry(1, 1);
    const aCell = new THREE.InstancedBufferAttribute(new Float32Array(maxCapacity), 1);
    const aTint = new THREE.InstancedBufferAttribute(new Float32Array(maxCapacity * 4), 4);
    aTint.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iCell', aCell);
    geo.setAttribute('iTint', aTint);
    this.cell = aCell.array as Float32Array;
    this.tint = aTint.array as Float32Array;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uAtlas: { value: this.tex } },
      fog: true,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.MultiplyBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, maxCapacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    this.mesh.visible = false;
    for (let i = 0; i < maxCapacity; i++) {
      this.slots.push({ born: 0, life: 0, grow: 0, size: 0, alpha: 0, active: false });
      this.matrices.push(new THREE.Matrix4());
    }
  }

  setCapacity(fraction: number): void {
    this.capacity = Math.max(24, Math.floor(this.maxCapacity * fraction));
    if (this.next >= this.capacity) this.next = 0;
    for (let i = this.capacity; i < this.maxCapacity; i++) this.slots[i].active = false;
  }

  /**
   * Adds a mark at `pos` facing `normal`. `along` (optional) orients the texture's +X (splatter
   * streaks) along a surface direction; `grow` seconds makes it spread from nothing (pools).
   */
  add(cell: number, pos: THREE.Vector3, normal: THREE.Vector3, size: number, r: number, g: number, b: number, alpha: number, life: number, grow = 0, along?: THREE.Vector3): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const slot = this.slots[i];
    slot.born = this.time;
    slot.life = life;
    slot.grow = grow;
    slot.size = size;
    slot.alpha = alpha;
    slot.active = true;
    this.n.copy(normal).normalize();
    this.q.setFromUnitVectors(this.z, this.n);
    let spin = Math.random() * Math.PI * 2;
    if (along) {
      // Rotate so the quad's +X follows `along` projected onto the surface.
      const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(this.q);
      const proj = along.clone().addScaledVector(this.n, -along.dot(this.n));
      if (proj.lengthSq() > 1e-6) {
        proj.normalize();
        spin = Math.atan2(new THREE.Vector3().crossVectors(xAxis, proj).dot(this.n), xAxis.dot(proj));
      }
    }
    this.q2.setFromAxisAngle(this.n, spin);
    this.q.premultiply(this.q2);
    const m = this.matrices[i];
    const s = grow > 0 ? 0.05 : 1;
    m.compose(pos.clone().addScaledVector(this.n, 0.006), this.q, this.s.set(size * s, size * s, 1));
    this.mesh.setMatrixAt(i, m);
    this.cell[i] = cell;
    this.tint[i * 4] = r;
    this.tint[i * 4 + 1] = g;
    this.tint[i * 4 + 2] = b;
    this.tint[i * 4 + 3] = alpha;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.visible = true;
    // Only this slot goes to the GPU: the whole pool was 42 KB with every mark (bullet holes come a dozen a second).
    sendSlots(this.mesh.geometry.getAttribute('iCell') as THREE.BufferAttribute, i);
    sendSlots(this.mesh.geometry.getAttribute('iTint') as THREE.BufferAttribute, i);
    sendSlots(this.mesh.instanceMatrix, i);
  }

  /** Takes away every mark inside a box (the wall they were on is gone). */
  removeIn(min: THREE.Vector3, max: THREE.Vector3): void {
    const e = this.e;
    for (let i = 0; i < this.mesh.count; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      e.setFromMatrixPosition(this.matrices[i]);
      if (e.x < min.x || e.x > max.x || e.y < min.y || e.y > max.y || e.z < min.z || e.z > max.z) continue;
      // Run out: the next update fades it to nothing.
      s.born = this.time - s.life;
    }
  }

  clear(): void {
    for (const s of this.slots) s.active = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.next = 0;
  }

  update(dt: number): void {
    this.time += dt;
    // Only the span of marks that changed this frame (fading out, or a pool still spreading) is sent: the
    // whole tint buffer went up every frame, 8 KB, mostly unchanged and all of it with no marks at all.
    let tintLo = Infinity, tintHi = -1, matLo = Infinity, matHi = -1;
    const e = this.e, q = this.qd, sc = this.sc;
    for (let i = 0; i < this.mesh.count; i++) {
      const s = this.slots[i];
      const age = this.time - s.born;
      if (s.active && age >= s.life) s.active = false;
      // As stored (32-bit), or every steady mark would read as changed.
      const alpha = Math.fround(s.active ? s.alpha * Math.min(1, (s.life - age) / Math.min(4, s.life * 0.3)) : 0);
      if (this.tint[i * 4 + 3] !== alpha) {
        this.tint[i * 4 + 3] = alpha;
        tintLo = Math.min(tintLo, i);
        tintHi = i;
      }
      if (s.active && s.grow > 0 && age < s.grow + 0.1) {
        const k = Math.min(1, age / s.grow);
        const grow = 1 - (1 - k) * (1 - k);
        const m = this.matrices[i];
        m.decompose(e, q, sc);
        const size = s.size * Math.max(0.05, grow);
        m.compose(e, q, sc.set(size, size, 1));
        this.mesh.setMatrixAt(i, m);
        matLo = Math.min(matLo, i);
        matHi = i;
      }
    }
    sendSlots(this.mesh.geometry.getAttribute('iTint') as THREE.BufferAttribute, tintLo, tintHi);
    sendSlots(this.mesh.instanceMatrix, matLo, matHi);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
  }
}
