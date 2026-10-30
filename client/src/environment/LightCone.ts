import * as THREE from 'three';

/** Soft additive volumetric cone used for streetlight shafts in fog. */
export function createLightConeMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uIntensity: { value: 1 } },
    vertexShader: /* glsl */ `
      varying float vH;
      varying vec3 vN;
      varying vec3 vPos;
      void main() {
        vH = uv.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalMatrix * normal;
        vPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying float vH;
      varying vec3 vN;
      varying vec3 vPos;
      void main() {
        // With MSAA, pixels along a triangle's edge are shaded at the pixel centre, which can lie
        // just outside the triangle, so varyings run past their range there. At the cone's base
        // vH dipped below zero and pow() returned NaN/Inf: a dashed bright ring on the ground that
        // the bloom smeared over the screen. Interpolated per-vertex view directions could also
        // cancel to zero with the camera inside the cone. Clamp, and never normalize zero.
        float h = clamp(vH, 0.0, 1.0);
        float dist = length(vPos);
        vec3 v = dist > 1e-4 ? -vPos / dist : vec3(0.0, 0.0, 1.0);
        float nl = length(vN);
        vec3 n = nl > 1e-4 ? vN / nl : v;
        float edge = pow(max(abs(dot(n, v)), 1e-4), 1.6);
        // Fade the shaft out around the camera, so standing under a lamp doesn't put a glowing
        // sheet right in front of the lens.
        float near = smoothstep(0.8, 3.0, dist);
        float a = pow(max(h, 1e-4), 1.8) * edge * 0.085 * clamp(uIntensity, 0.0, 2.0) * near;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}
