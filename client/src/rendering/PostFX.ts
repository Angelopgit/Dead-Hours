import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ScenePass, type SceneFXOptions } from './SceneFX';
import { createNightLUT, LUT_SIZE } from './ColorLUT';

/** Bloom takes light over this luminance (linear, before exposure). */
export const BLOOM_THRESHOLD = 0.9;
/**
 * ...and eases in over this much more. The stock high pass is a hard cut (0.01 wide), so a texel
 * just over the threshold bloomed as hard as a lamp bulb: Molotov flames, a burning body, a wet
 * road and a wall in the flashlight all sit around 1 and smeared glare over the street. Now they
 * glow faintly; bulbs, muzzle flashes, sparks and blasts (several times over) bloom as before.
 */
export const BLOOM_KNEE = 0.5;

/** Grade uniforms (see FINAL_FRAG): gameplay drives fade, damage and flash. */
function gradeUniforms() {
  return {
    tLut: { value: null as THREE.Data3DTexture | null },
    uLutMix: { value: 1 },
    uTime: { value: 0 },
    uGrain: { value: 0.045 },
    uVignette: { value: 0.42 },
    uFade: { value: 0 },
    uDamage: { value: 0 },
    uFlash: { value: 0 },
    /** The bloom pass's result (half resolution), added when uBloom is 1. */
    tBloom: { value: null as THREE.Texture | null },
    uBloom: { value: 0 },
  };
}
type GradeUniforms = ReturnType<typeof gradeUniforms>;

/**
 * The last full-screen pass, in one: the bloom added over the scene, tone mapping and the sRGB
 * transfer (as three's OutputPass), then the grade in display space: the night color grade (a 3D LUT,
 * see ColorLUT), vignette, film grain and a fade-to-black / damage tint used by gameplay. These were
 * three passes (bloom's own additive blend, OutputPass, grade), each reading and writing the whole
 * screen in half floats; one pass does the same math once.
 */
const FINAL_VERT = /* glsl */ `
  precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  in vec3 position;
  in vec2 uv;
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FINAL_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform float uBloom;
  uniform sampler3D tLut;
  uniform float uLutMix, uTime, uGrain, uVignette, uFade, uDamage, uFlash;
  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>
  in vec2 vUv;
  out vec4 fragColor;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec4 col = texture(tDiffuse, vUv);
    // Bloom, upsampled from half resolution the way the bloom pass's own blend did.
    if (uBloom > 0.0) col.rgb += texture(tBloom, vUv).rgb;
    #if defined( ACES_FILMIC_TONE_MAPPING )
      col.rgb = ACESFilmicToneMapping(col.rgb);
    #elif defined( LINEAR_TONE_MAPPING )
      col.rgb = LinearToneMapping(col.rgb);
    #elif defined( REINHARD_TONE_MAPPING )
      col.rgb = ReinhardToneMapping(col.rgb);
    #elif defined( CINEON_TONE_MAPPING )
      col.rgb = CineonToneMapping(col.rgb);
    #elif defined( AGX_TONE_MAPPING )
      col.rgb = AgXToneMapping(col.rgb);
    #elif defined( NEUTRAL_TONE_MAPPING )
      col.rgb = NeutralToneMapping(col.rgb);
    #elif defined( CUSTOM_TONE_MAPPING )
      col.rgb = CustomToneMapping(col.rgb);
    #endif
    #ifdef SRGB_TRANSFER
      col = sRGBTransferOETF(col);
    #endif
    vec3 c = col.rgb;
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
    fragColor = vec4(max(c, 0.0), 1.0);
  }
`;

/** OutputPass (keeps its tone mapping and color space switches) with the bloom and the grade folded in. */
class FinalPass extends OutputPass {
  readonly grade: GradeUniforms = gradeUniforms();

  constructor() {
    super();
    Object.assign(this.uniforms, this.grade);
    this.material.glslVersion = THREE.GLSL3;
    this.material.vertexShader = FINAL_VERT;
    this.material.fragmentShader = FINAL_FRAG;
    this.material.needsUpdate = true;
  }
}

const BLUR_X = new THREE.Vector2(1, 0);
const BLUR_Y = new THREE.Vector2(0, 1);

/**
 * three's UnrealBloomPass up to its composite: the bright pass, the blurred mips and their mix at
 * half resolution. Its last step, an additive blend of that over the whole screen, is left to
 * FinalPass, which reads `output` while it reads the scene anyway.
 */
class Bloom extends UnrealBloomPass {
  private readonly quad = new FullScreenQuad();
  private readonly oldClear = new THREE.Color();

  get output(): THREE.Texture {
    return this.renderTargetsHorizontal[0].texture;
  }

  override render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    renderer.getClearColor(this.oldClear);
    const oldAlpha = renderer.getClearAlpha();
    const oldAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);
    const hp = this.highPassUniforms as Record<string, THREE.IUniform>;
    hp.tDiffuse.value = readBuffer.texture;
    hp.luminosityThreshold.value = this.threshold;
    this.quad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this.quad.render(renderer);
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      this.quad.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = BLUR_X;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this.quad.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = BLUR_Y;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this.quad.render(renderer);
      input = this.renderTargetsVertical[i];
    }
    const c = this.compositeMaterial;
    this.quad.material = c;
    c.uniforms.bloomStrength.value = this.strength;
    c.uniforms.bloomRadius.value = this.radius;
    c.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this.quad.render(renderer);
    renderer.setClearColor(this.oldClear, oldAlpha);
    renderer.autoClear = oldAuto;
  }

  override dispose(): void {
    super.dispose();
    this.quad.dispose();
  }
}

export class PostFX {
  readonly composer: EffectComposer;
  readonly bloom: Bloom;
  /** Bloom added, tone mapping, sRGB and the grade: the one pass that writes the screen. */
  private readonly final: FinalPass;
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
    this.bloom = new Bloom(new THREE.Vector2(size.x, size.y), 0.55, 0.55, BLOOM_THRESHOLD);
    (this.bloom.highPassUniforms as Record<string, THREE.IUniform<number>>).smoothWidth.value = BLOOM_KNEE;
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
    this.final = new FinalPass();
    this.final.grade.tLut.value = this.lut;
    this.composer.addPass(this.final);
  }

  get uniforms(): GradeUniforms {
    return this.final.grade;
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
    const u = this.final.grade;
    u.uTime.value += dt;
    u.uBloom.value = this.bloom.enabled ? 1 : 0;
    u.tBloom.value = this.bloom.output;
    this.scene.setDelta(dt);
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
    this.final.dispose();
    this.scene.dispose();
    this.lut.dispose();
  }
}
