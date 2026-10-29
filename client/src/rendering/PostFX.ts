import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Final grade in display space: split-tone color grading, saturation, vignette,
 * film grain and a fade-to-black / damage tint used by gameplay.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uGrain: { value: 0.045 },
    uVignette: { value: 0.42 },
    uSaturation: { value: 0.82 },
    uShadowTint: { value: new THREE.Vector3(0.93, 1.0, 1.1) },
    uHighlightTint: { value: new THREE.Vector3(1.06, 1.0, 0.9) },
    uLift: { value: 0.012 },
    uContrast: { value: 1.06 },
    uFade: { value: 0 },
    uDamage: { value: 0 },
    uFlash: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uSaturation, uLift, uContrast, uFade, uDamage, uFlash;
    uniform vec3 uShadowTint, uHighlightTint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c *= mix(uShadowTint, uHighlightTint, smoothstep(0.05, 0.6, l));
      c = (c - 0.5) * uContrast + 0.5 + uLift;
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.2, length(d * vec2(1.15, 1.0)));
      c *= mix(1.0 - uVignette, 1.0, v);
      // Damage: red vignette pulse.
      c = mix(c, vec3(0.35, 0.02, 0.02), uDamage * (1.0 - v) * 0.85);
      float g = hash(vUv * vec2(1920.0, 1080.0) + fract(uTime * 7.3) * 91.7) - 0.5;
      c += g * uGrain * (1.0 - l * 0.6);
      c += uFlash;
      c *= 1.0 - uFade;
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

export class PostFX {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  private readonly renderPass: RenderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, msaa: boolean) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: msaa ? 4 : 0,
    });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.55, 0.9);
    // A single NaN/Inf pixel (driver precision edge cases) would smear across the whole
    // bloom mip chain and black out the frame; sanitize at the bloom's input.
    const hp = this.bloom.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace(
      'vec4 texel = texture2D( tDiffuse, vUv );',
      `vec4 texel = texture2D( tDiffuse, vUv );
       if (any(isnan(texel)) || any(isinf(texel))) texel = vec4(0.0);
       texel.rgb = min(texel.rgb, vec3(48.0));`,
    );
    hp.needsUpdate = true;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  get uniforms() {
    return this.grade.uniforms as unknown as typeof GradeShader.uniforms;
  }

  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  setMsaa(enabled: boolean): void {
    const samples = enabled ? 4 : 0;
    this.composer.renderTarget1.samples = samples;
    this.composer.renderTarget2.samples = samples;
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
  }

  render(dt: number): void {
    this.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
  }
}
