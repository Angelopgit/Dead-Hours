import * as THREE from 'three';
import { MOON_DIR } from '../lighting/Lighting';

/** Overcast night sky dome: horizon glow, drifting fbm cloud layer, veiled moon, lightning flash. */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uZenith: { value: new THREE.Color(0x070a10) },
    uHorizon: { value: new THREE.Color(0x2a3444) },
    uCloud: { value: new THREE.Color(0x2a3240) },
    uMoonDir: { value: MOON_DIR.clone() },
  };

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uFlash;
        uniform vec3 uZenith, uHorizon, uCloud, uMoonDir;
        varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
          return v;
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
          // Cloud layer projected onto a plane.
          vec2 uv = d.xz / max(d.y + 0.12, 0.05) * 0.9;
          uv += vec2(uTime * 0.012, uTime * 0.004);
          float c = fbm(uv * 1.3);
          float c2 = fbm(uv * 3.1 + 5.0);
          float clouds = smoothstep(0.35, 0.85, c * 0.75 + c2 * 0.35);
          float md = max(dot(d, uMoonDir), 0.0);
          float moonGlow = pow(md, 18.0) * 0.55 + pow(md, 900.0) * 3.0;
          vec3 moonCol = vec3(0.65, 0.74, 0.9);
          col += moonCol * moonGlow * (1.0 - clouds * 0.85);
          vec3 cloudCol = uCloud * (0.55 + 0.6 * c2) + moonCol * pow(md, 6.0) * 0.25;
          col = mix(col, cloudCol, clouds * smoothstep(0.0, 0.25, h) * 0.9);
          col += vec3(0.55, 0.6, 0.75) * uFlash * (0.4 + clouds);
          // Ground side fades into fog color.
          col = mix(col, uHorizon * 0.8, smoothstep(0.02, -0.15, d.y));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  update(dt: number, cameraPos: THREE.Vector3): void {
    this.uniforms.uTime.value += dt;
    this.mesh.position.copy(cameraPos);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
