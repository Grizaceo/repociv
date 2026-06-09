// ─── Instanced terrain material: atlas texture + normal-map bump + Civ V lighting ──
import {
  Color,
  MeshStandardMaterial,
  Texture,
} from 'three';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Shader = any;
import { HEX_SIZE } from '../constants.ts';
import { type Terrain } from '../types.ts';

/** Stable terrain-to-atlas index mapping. Keep in sync with terrain-atlas-3d.json. */
export const TERRAIN_ATLAS_INDEX: Record<Terrain, number> = {
  plains:   0,
  forest:   1,
  mountain: 2,
  desert:   3,
  ocean:    4,
  ice:      5,
  hills:    6,
  sacred:   7,
};

/** Per-biome prism height scale (local Y multiplier in vertex shader). */
export const TERRAIN_HEIGHT_SCALE: Record<Terrain, number> = {
  plains:   1.0,
  forest:   1.0,
  mountain: 1.35,
  desert:   1.0,
  ocean:    0.75,
  ice:      0.95,
  hills:    1.1,
  sacred:   1.0,
};

/** Elevation in world units (coordinates with terrainElevation() in isoHex.ts). */
export const TERRAIN_ELEVATION_WORLD: Record<Terrain, number> = {
  plains:   0,
  forest:   1,
  mountain: 3,
  desert:   0,
  ocean:   -1,
  ice:      0,
  hills:    2,
  sacred:   0,
};

export interface TerrainMaterialOptions {
  terrainAtlas?: Texture | null;
  normalAtlas?: Texture | null;
  roughnessAtlas?: Texture | null;
  atlasColumns?: number;
  atlasRows?: number;
}

export function createTerrainMaterial(
  options: TerrainMaterialOptions = {},
): MeshStandardMaterial {
  // Note: roughnessAtlas is handled per-biome inside the shader via uRoughnessAtlas,
  // NOT via mat.roughnessMap (which would use wrong raw-tile UVs instead of atlas UVs).
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.04,
  });

  mat.onBeforeCompile = (shader: Shader) => {
    // ── Uniforms ─────────────────────────────────────────────────────────────
    shader.uniforms.uTime             = { value: 0 };
    shader.uniforms.uHexRadius        = { value: HEX_SIZE };
    shader.uniforms.uUseAtlas         = { value: options.terrainAtlas ? 1 : 0 };
    shader.uniforms.uTerrainAtlas     = { value: options.terrainAtlas ?? null };
    shader.uniforms.uNormalAtlas      = { value: options.normalAtlas ?? null };
    shader.uniforms.uUseNormalAtlas   = { value: options.normalAtlas ? 1 : 0 };
    shader.uniforms.uRoughnessAtlas   = { value: options.roughnessAtlas ?? null };
    shader.uniforms.uUseRoughAtlas    = { value: options.roughnessAtlas ? 1 : 0 };
    shader.uniforms.uAtlasColumns     = { value: options.atlasColumns ?? 4 };
    shader.uniforms.uAtlasRows        = { value: options.atlasRows ?? 3 };
    (mat.userData as { shader?: Shader }).shader = shader;

    // ── Vertex ────────────────────────────────────────────────────────────────
    shader.vertexShader =
      'attribute float instanceTerrain;\n' +
      'attribute float instanceNeighborTerrain;\n' +
      'varying float vTerrainIndex;\n' +
      'varying float vNeighborTerrainIndex;\n' +
      'varying vec2  vLocalXZ;\n' +
      'varying vec2  vUv;\n' +
      'varying float vTopFace;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainIndex = instanceTerrain;
        vNeighborTerrainIndex = instanceNeighborTerrain;
        vLocalXZ      = vec2(position.x, position.z);
        vUv           = uv;
        // normal.y > 0.5 in local space → top face
        vTopFace      = step(0.5, normal.y);

        // Differential elevation: scale prism height by biome
        float heightScale = 1.0;
        float tidx = floor(instanceTerrain + 0.5);
        if (tidx < 0.5) heightScale = 1.0;          // plains
        else if (tidx < 1.5) heightScale = 1.0;      // forest
        else if (tidx < 2.5) heightScale = 1.35;   // mountain
        else if (tidx < 3.5) heightScale = 1.0;     // desert
        else if (tidx < 4.5) heightScale = 0.75;   // ocean
        else if (tidx < 5.5) heightScale = 0.95;   // ice
        else if (tidx < 6.5) heightScale = 1.1;    // hills
        else if (tidx < 7.5) heightScale = 1.0;    // sacred

        // Only scale the downward (negative Y) part of the prism
        if (transformed.y < 0.0) {
          transformed.y *= heightScale;
        }

        // Ocean wave animation: gentle vertical displacement
        if (abs(tidx - 4.0) < 0.5) {
          float wave = 0.35 * sin(uTime * 1.4 + transformed.x * 0.12 + transformed.z * 0.08);
          float wave2 = 0.18 * sin(uTime * 2.1 - transformed.x * 0.07 + transformed.z * 0.11);
          transformed.y += wave + wave2;
        }`,
      );

    // ── Fragment uniforms declaration ─────────────────────────────────────────
    const uniformDecl =
      'varying float vTerrainIndex;\n' +
      'varying float vNeighborTerrainIndex;\n' +
      'varying vec2  vLocalXZ;\n' +
      'varying vec2  vUv;\n' +
      'varying float vTopFace;\n' +
      'uniform float uTime;\n' +
      'uniform float uHexRadius;\n' +
      'uniform int   uUseAtlas;\n' +
      'uniform sampler2D uTerrainAtlas;\n' +
      'uniform sampler2D uNormalAtlas;\n' +
      'uniform int   uUseNormalAtlas;\n' +
      'uniform sampler2D uRoughnessAtlas;\n' +
      'uniform int   uUseRoughAtlas;\n' +
      'uniform float uAtlasColumns;\n' +
      'uniform float uAtlasRows;\n';

    // Helper: compute atlas UV from terrain index + tile UV
    const atlasUvFn = `
vec2 terrainAtlasUv(float idx, vec2 tileUv) {
  float col = mod(idx, uAtlasColumns);
  float row = floor(idx / uAtlasColumns);
  return vec2((col + tileUv.x) / uAtlasColumns,
              (row + tileUv.y) / uAtlasRows);
}
`;

    shader.fragmentShader = uniformDecl + atlasUvFn + shader.fragmentShader
      // ── Colour from atlas (top face only) ──────────────────────────────────
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float tidx  = floor(vTerrainIndex + 0.5);
        float ntidx = floor(vNeighborTerrainIndex + 0.5);
        float radial = clamp(length(vLocalXZ) / uHexRadius, 0.0, 1.0);
        if (uUseAtlas > 0 && vTopFace > 0.5) {
          vec2 auv = terrainAtlasUv(tidx, vUv);
          vec3 tex = texture2D(uTerrainAtlas, auv).rgb;
          // Lift very dark textures so no biome goes black under warm lights
          tex = max(tex, vec3(0.06));
          // Saturation boost: push away from grey
          float lum = dot(tex, vec3(0.299, 0.587, 0.114));
          tex = mix(vec3(lum), tex, 1.30);
          // Neighbour biome blend at hex edges
          float edgeBlend = smoothstep(0.72, 0.98, radial);
          if (ntidx >= 0.0 && abs(ntidx - tidx) > 0.5) {
            vec2 nauv = terrainAtlasUv(ntidx, vUv);
            vec3 nTex = texture2D(uTerrainAtlas, nauv).rgb;
            nTex = max(nTex, vec3(0.06));
            float nLum = dot(nTex, vec3(0.299, 0.587, 0.114));
            nTex = mix(vec3(nLum), nTex, 1.30);
            tex = mix(tex, nTex, edgeBlend * 0.45);
          }
          // Top-face brightening so atlas colours read through warm PBR lights
          tex *= 1.18;
          diffuseColor.rgb = mix(diffuseColor.rgb, tex, 0.93);
        }
        // Radial vignette — very subtle
        if (vTopFace > 0.5) {
          diffuseColor.rgb *= mix(1.04, 0.94, radial * radial);
        }
        // Side faces: clay-tinted dark
        if (vTopFace < 0.5) {
          diffuseColor.rgb *= 0.55;
          diffuseColor.r *= 1.10;
          diffuseColor.g *= 1.04;
        }
        // Ocean shimmer
        bool isOcean = (diffuseColor.b > diffuseColor.r * 1.05 &&
                        diffuseColor.g < diffuseColor.b * 0.92);
        if (isOcean && vTopFace > 0.5) {
          float wave  = 0.06 * sin(uTime * 1.8 + vLocalXZ.x * 0.09 + vLocalXZ.y * 0.07);
          float wave2 = 0.03 * sin(uTime * 2.6 - vLocalXZ.x * 0.05 + vLocalXZ.y * 0.11);
          diffuseColor.rgb += vec3(wave * 0.3, wave * 0.25 + wave2 * 0.4, wave + wave2 * 1.2);
        }`,
      )
      // ── Per-biome roughness from atlas (correct atlas UV, not raw tile UV) ──
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        if (uUseRoughAtlas > 0 && vTopFace > 0.5) {
          float _rtidx = floor(vTerrainIndex + 0.5);
          vec2 rauv = terrainAtlasUv(_rtidx, vUv);
          float rgh = texture2D(uRoughnessAtlas, rauv).r;
          roughnessFactor = rgh;
        }`,
      )
      // ── Normal-map perturbation from atlas ──────────────────────────────────
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (uUseNormalAtlas > 0 && vTopFace > 0.5) {
          float _ntidx = floor(vTerrainIndex + 0.5);
          float _nntidx = floor(vNeighborTerrainIndex + 0.5);
          vec2 nauv  = terrainAtlasUv(_ntidx, vUv);
          vec3 nTex  = texture2D(uNormalAtlas, nauv).rgb * 2.0 - 1.0;
          // Blend neighbor normal at edges
          float _radial = clamp(length(vLocalXZ) / uHexRadius, 0.0, 1.0);
          float _edgeBlend = smoothstep(0.72, 0.98, _radial);
          if (_nntidx >= 0.0 && abs(_nntidx - _ntidx) > 0.5) {
            vec2 nnauv = terrainAtlasUv(_nntidx, vUv);
            vec3 nNeighbor = texture2D(uNormalAtlas, nnauv).rgb * 2.0 - 1.0;
            nTex = mix(nTex, nNeighbor, _edgeBlend * 0.45);
          }
          // Blend atlas normal into surface normal (TBN for a flat-top hex is identity-ish)
          normal = normalize(normal + vec3(nTex.x * 0.55, nTex.z, nTex.y * 0.55));
        }`,
      );
  };

  mat.customProgramCacheKey = () => 'repociv-terrain-v7';
  return mat;
}

export function updateTerrainShaderTime(mat: MeshStandardMaterial, time: number): void {
  const shader = (mat.userData as { shader?: Shader }).shader;
  if (shader?.uniforms.uTime) shader.uniforms.uTime.value = time;
}

export function updateTerrainShaderAtlas(
  mat: MeshStandardMaterial,
  texture: Texture | null,
  normalTexture?: Texture | null,
  roughnessTexture?: Texture | null,
): void {
  const shader = (mat.userData as { shader?: Shader }).shader;
  if (!shader) return;
  shader.uniforms.uUseAtlas.value     = texture ? 1 : 0;
  shader.uniforms.uTerrainAtlas.value = texture;
  if (normalTexture !== undefined) {
    shader.uniforms.uUseNormalAtlas.value = normalTexture ? 1 : 0;
    shader.uniforms.uNormalAtlas.value    = normalTexture;
  }
  if (roughnessTexture !== undefined) {
    shader.uniforms.uUseRoughAtlas.value   = roughnessTexture ? 1 : 0;
    shader.uniforms.uRoughnessAtlas.value  = roughnessTexture;
  }
}

/** Sky / horizon palette — warm Civ V afternoon. */
export const SKY_TOP     = new Color(0x89b5d4);   // was 0x7a9ec8 — warmer blue
export const SKY_HORIZON = new Color(0x9ab870);   // was 0x8aab85 — greener mid
export const FOG_DENSITY = 0.00025;               // was 0.00032 — slightly less haze
