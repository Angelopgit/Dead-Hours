import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { ScenePass, type SceneFXOptions } from './SceneFX';
import { createNightLUT, LUT_SIZE } from './ColorLUT';

/**
 * Final grade in display space: the night color grade (a 3D LUT, see ColorLUT), vignette, film
 * grain and a fade-to-black / damage tint used by gameplay.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tLut: { value: null as THREE.Data3DTexture | null },
    uLutMix: { value: 1 },
    uTime: { value: 0 },
    uGrain: { value: 0.045 },
    uVignette: { value: 0.42 },
    uFade: { value: 0 },
    uDamage: { value: 0 },
    uFlash: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp sampler3D;
    uniform sampler2D tDiffuse;
    uniform sampler3D tLut;
    uniform float uLutMix, uTime, uGrain, uVignette, uFade, uDamage, uFlash;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // A stray NaN/Inf pixel shows as black instead of a white speck.
      if (any(greaterThanEqual(floatBitsToUint(c) & 0x7fffffffu, uvec3(0x7f800000u)))) c = vec3(0.0);
      c = clamp(c, 0.0, 1.0);
      vec3 graded = texture(tLut, c * ${((LUT_SIZE - 1) / LUT_SIZE).toFixed(6)} + ${(0.5 / LUT_SIZE).toFixed(6)}).rgb;
      c = mix(c, graded, uLutMix);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.2, length(d * vec2(1.15, 1.0)));
      c *= mix(1.0 - uVignette, 1.0, v);
      // Damage: red vignette pulse.
      c = mix(c, vec3(0.35, 0.02, 0.02), uDamage * (1.0 - v) * 0.85);
      // Grain: stronger in the shadows, like film; two hashes so it doesn't crawl in lines.
      if (uGrain > 0.0) {
        vec2 gp = vUv * vec2(1920.0, 1080.0);
        float g = (hash(gp + fract(uTime * 7.3) * 91.7) + hash(gp * 1.37 - fract(uTime * 3.1) * 57.3)) - 1.0;
        c += g * uGrain * (1.0 - l * 0.7);
      }
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
  /** Scene draw + SSAO + volumetric fog + motion blur. */
  readonly scene: ScenePass;
  private readonly lut = createNightLUT();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, msaa: boolean) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // MSAA lives on the scene pass's own target; the composer's buffers only see full-screen passes.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, target);
    this.scene = new ScenePass(scene, camera);
    this.scene.configure({ aoSamples: 0, fogScale: 0, fogSteps: 0, fogLights: 0, blurTaps: 0, msaa });
    this.composer.addPass(this.scene);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.55, 0.9);
    // A single NaN/Inf pixel (driver precision edge cases) would smear across the whole bloom
    // mip chain. The high pass runs at half resolution, so read the four full-resolution texels
    // under each output pixel one by one and drop bad ones before any filtering mixes them in:
    // texture filtering can turn Inf into a huge finite value that slips past the check. Tested
    // on the bits, because some shader compilers fold isnan()/isinf() away as "can't happen".
    const hp = this.bloom.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace(
      'vec4 texel = texture2D( tDiffuse, vUv );',
      `ivec2 size = textureSize( tDiffuse, 0 );
       ivec2 p = ivec2( vUv * vec2( size ) - 0.5 );
       vec4 texel = vec4( 0.0 );
       for ( int i = 0; i < 4; i ++ ) {
         vec4 t = texelFetch( tDiffuse, clamp( p + ivec2( i & 1, i >> 1 ), ivec2( 0 ), size - 1 ), 0 );
         bool bad = any( greaterThanEqual( floatBitsToUint( t ) & 0x7fffffffu, uvec4( 0x7f800000u ) ) )
           || max( max( t.r, t.g ), t.b ) > 4096.0;
         texel += bad ? vec4( 0.0 ) : clamp( t, vec4( 0.0 ), vec4( 48.0 ) );
       }
       texel *= 0.25;`,
    );
    if (!hp.fragmentShader.includes('texelFetch')) console.warn('PostFX: bloom input guard not applied');
    hp.needsUpdate = true;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.tLut.value = this.lut;
    this.composer.addPass(this.grade);
  }

  get uniforms() {
    return this.grade.uniforms as unknown as typeof GradeShader.uniforms;
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    this.scene.camera = camera;
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  /** Scene effects for the current graphics settings (see Engine). */
  configure(o: SceneFXOptions): void {
    this.scene.configure(o);
    this.scene.setSize(this.composer.renderTarget1.width, this.composer.renderTarget1.height);
  }

  render(dt: number): void {
    this.uniforms.uTime.value += dt;
    this.scene.setDelta(dt);
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
    this.scene.dispose();
    this.lut.dispose();
  }
}
