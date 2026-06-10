import { describe, it, expect } from 'vitest';
import { createTerrainMaterial } from './terrainShader.ts';

// We don't have a WebGL context in vitest, so we can't run the full
// GPU program. But we CAN:
//   1. Construct the material and confirm onBeforeCompile fires.
//   2. Capture the modified shader source and snapshot it, so any
//      accidental change to the GLSL string-replace blocks is caught
//      by a CI diff. This is the only sane way to detect "the
//      fragmentShader is now subtly broken" without a real GL context.
//   3. Verify customProgramCacheKey is non-empty and versioned.
//
// If you INTENTIONALLY change the GLSL: bump the version constant in
// customProgramCacheKey AND run `vitest -u` to refresh the snapshot.

describe('terrainShader', () => {
  it('creates a material without throwing', () => {
    const mat = createTerrainMaterial();
    expect(mat).toBeDefined();
    expect(typeof mat.onBeforeCompile).toBe('function');
  });

  it('exposes a versioned customProgramCacheKey', () => {
    const mat = createTerrainMaterial();
    // Bumping the version in terrainShader.ts must update this.
    expect(mat.customProgramCacheKey?.()).toBe('repociv-terrain-v17');
  });

  it('produces a stable fragment shader from onBeforeCompile', () => {
    const mat = createTerrainMaterial();
    // We can't trigger a real compile without a renderer, but we
    // can invoke onBeforeCompile with a fake shader-shaped object
    // and read back the modified source. The capture in the
    // captureFragment helper below mirrors the shape three.js
    // passes: it has vertexShader/fragmentShader as strings plus a
    // uniforms map.
    const capture = captureFragment(mat);
    // The shader MUST contain the uniform declarations we inject.
    // (We don't pin the full string — that's what the snapshot is
    // for. We pin the presence of stable anchors so a silent
    // truncation of the string-replace blocks fails loudly.)
    expect(capture.fragment).toContain('uniform float uTime;');
    expect(capture.fragment).toContain('uniform sampler2D uTerrainAtlas;');
    expect(capture.fragment).toContain('uniform sampler2D uNormalAtlas;');
    // The texture-binding block the chunk-replace adds. The function
    // definition is the stable bit; the call sites (which use
    // vTerrainIndex, vWorldXZ, etc.) change as we add biomes.
    expect(capture.fragment).toMatch(/vec2 terrainAtlasUv\(float idx, vec2 tileUv\)/);
    expect(capture.fragment).toMatch(/vec2 terrainMacroUv\(/);
    // Snapshot for byte-level stability across the chunk-replace chain.
    expect(capture.fragment).toMatchSnapshot();
  });

  it('produces a stable vertex shader from onBeforeCompile', () => {
    const mat = createTerrainMaterial();
    const capture = captureFragment(mat);
    // The vertex shader should expose the time uniform, instance
    // attributes, and the height-scale & elevation locals we use to
    // extrude the prisms. These are the most upgrade-fragile parts:
    // rename `heightScale` and the biome blocks silently stop
    // scaling.
    expect(capture.vertex).toContain('uniform float uTime;');
    expect(capture.vertex).toContain('attribute float instanceTerrain;');
    expect(capture.vertex).toContain('attribute float instanceNeighborTerrain;');
    expect(capture.vertex).toContain('float heightScale = ');
    // Per-biome scaling block — a silent loss of one of these lines
    // (e.g. when three.js's <begin_vertex> chunk is renamed) is the
    // most common shader regression we see on three upgrades.
    expect(capture.vertex).toContain('heightScale = 1.58');   // mountain
    expect(capture.vertex).toContain('heightScale = 0.70');   // ocean
    expect(capture.vertex).toMatchSnapshot();
  });
});

/**
 * Invoke the material's onBeforeCompile with a shader-shaped stub and
 * return the (mutated) vertex and fragment source. The stub is
 * intentionally permissive — three's real callback types are large
 * and would force us to construct a fake renderer to satisfy them.
 */
function captureFragment(mat: ReturnType<typeof createTerrainMaterial>): {
  vertex: string;
  fragment: string;
} {
  const stubShader = {
    vertexShader: 'void main() {\n  #include <begin_vertex>\n  vec3 transformed = position;\n}',
    fragmentShader:
      'void main() {\n  #include <color_fragment>\n  #include <roughnessmap_fragment>\n  #include <normal_fragment_maps>\n  gl_FragColor = vec4(diffuseColor.rgb, 1.0);\n}',
    uniforms: {} as Record<string, { value: unknown }>,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mat.onBeforeCompile as any)(stubShader, /* renderer */ stubRenderer());
  return { vertex: stubShader.vertexShader, fragment: stubShader.fragmentShader };
}

// Minimal renderer stub. We only need onBeforeCompile to be callable
// without throwing; the actual WebGL state is never touched in the
// fake path.
function stubRenderer() {
  return {
    capabilities: { isWebGL2: true },
    getProgramParameter: () => true,
  };
}
