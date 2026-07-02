// ─── Post-processing: warm grade + vignette + contained bloom ───────────────
// The Civ V read is as much grading as geometry: a golden-hour warmth, gentle
// midtone gold, corners that fall off so the eye stays on the map, and a
// whisper of bloom on the emissive crystals/gems. Chain:
//
//   RenderPass (linear HalfFloat, 4x MSAA)
//     → UnrealBloomPass (high threshold — only true highlights bleed)
//     → OutputPass (ACES tonemap + sRGB, same curve as the direct path)
//     → GradeVignettePass (single fullscreen quad, post-tonemap so the
//       grade behaves like photo work, not physical light)
//
// Cost: one scene render (unchanged) + bloom's downsampled mip chain + two
// fullscreen quads. The toggle (renderMode.resolveInitialPostFx) swaps back
// to plain renderer.render() with zero residue — dispose() drops every RT.
import {
  HalfFloatType,
  Vector2,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Tuning: subtle by design. If a screenshot makes the effect obvious side by
// side but you can't name it while playing, it's right.
const BLOOM_STRENGTH = 0.18; // whisper — emissive gems get a halo, nothing else
const BLOOM_RADIUS = 0.2;
const BLOOM_THRESHOLD = 0.9; // linear-space: above the sky/terrain band
const VIGNETTE_STRENGTH = 0.32; // corner falloff amount (0 = off)
const WARM_BALANCE: [number, number, number] = [1.04, 1.005, 0.955];
const GOLD_MIDTONE_MIX = 0.08;

/** Fullscreen grade+vignette, applied after tone mapping (sRGB space). */
export const GradeVignetteShader = {
  name: 'GradeVignetteShader',
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: VIGNETTE_STRENGTH },
    uWarmBalance: { value: WARM_BALANCE },
    uGoldMix: { value: GOLD_MIDTONE_MIX },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform vec3 uWarmBalance;
    uniform float uGoldMix;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Warm white balance: nudge red up, blue down.
      vec3 graded = c.rgb * uWarmBalance;
      // Golden midtone tint, weighted to fade out in shadows and highlights
      // so blacks stay black and skies don't turn sepia.
      float lum = dot(graded, vec3(0.299, 0.587, 0.114));
      float midWeight = 1.0 - abs(lum - 0.5) * 2.0;
      graded = mix(graded, graded * vec3(1.0, 0.92, 0.74), uGoldMix * max(midWeight, 0.0));
      // Vignette: quadratic falloff from a wide clear centre.
      float d = length(vUv - 0.5);
      float vig = 1.0 - uVignette * smoothstep(0.42, 0.86, d);
      gl_FragColor = vec4(graded * vig, c.a);
    }
  `,
};

export class PostFX3D {
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private target: WebGLRenderTarget;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    width: number,
    height: number,
  ) {
    // MSAA lives on the composer's target now — the canvas' own antialias
    // flag only applies when rendering straight to it.
    this.target = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, this.target);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(width, height);

    this.composer.addPass(new RenderPass(scene, camera));
    this.bloomPass = new UnrealBloomPass(
      new Vector2(width, height),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(GradeVignetteShader));
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    // EffectComposer.dispose() frees its internal RTs and every pass's
    // dispose() (bloom's mip chain included); the seed target is ours.
    this.composer.dispose();
    this.target.dispose();
  }
}
