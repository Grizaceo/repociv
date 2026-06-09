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

export interface TerrainMaterialOptions {
  terrainAtlas?: Texture | null;
  normalAtlas?: Texture | null;
  atlasColumns?: number;
  atlasRows?: number;
}

export function createTerrainMaterial(
  options: TerrainMaterialOptions = {},
): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.04,
  });

  mat.onBeforeCompile = (shader: Shader) => {
    // ── Uniforms ─────────────────────────────────────────────────────────────
    shader.uniforms.uTime            = { value: 0 };
    shader.uniforms.uHexRadius       = { value: HEX_SIZE };
    shader.uniforms.uUseAtlas        = { value: options.terrainAtlas ? 1 : 0 };
    shader.uniforms.uTerrainAtlas    = { value: options.terrainAtlas ?? null };
    shader.uniforms.uNormalAtlas     = { value: options.normalAtlas ?? null };
    shader.uniforms.uUseNormalAtlas  = { value: options.normalAtlas ? 1 : 0 };
    shader.uniforms.uAtlasColumns    = { value: options.atlasColumns ?? 4 };
    shader.uniforms.uAtlasRows       = { value: options.atlasRows ?? 3 };
    (mat.userData as { shader?: Shader }).shader = shader;

    // ── Vertex ────────────────────────────────────────────────────────────────
    shader.vertexShader =
      'attribute float instanceTerrain;\n' +
      'varying float vTerrainIndex;\n' +
      'varying vec2  vLocalXZ;\n' +
      'varying vec2  vUv;\n' +
      'varying float vTopFace;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainIndex = instanceTerrain;
        vLocalXZ      = vec2(position.x, position.z);
        vUv           = uv;
        // normal.y > 0.5 in local space → top face
        vTopFace      = step(0.5, normal.y);`,
      );

    // ── Fragment uniforms declaration ─────────────────────────────────────────
    const uniformDecl =
      'varying float vTerrainIndex;\n' +
      'varying vec2  vLocalXZ;\n' +
      'varying vec2  vUv;\n' +
      'varying float vTopFace;\n' +
      'uniform float uTime;\n' +
      'uniform float uHexRadius;\n' +
      'uniform int   uUseAtlas;\n' +
      'uniform sampler2D uTerrainAtlas;\n' +
      'uniform sampler2D uNormalAtlas;\n' +
      'uniform int   uUseNormalAtlas;\n' +
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
        float tidx = floor(vTerrainIndex + 0.5);
        if (uUseAtlas > 0 && vTopFace > 0.5) {
          vec2 auv = terrainAtlasUv(tidx, vUv);
          vec3 tex = texture2D(uTerrainAtlas, auv).rgb;
          diffuseColor.rgb = mix(diffuseColor.rgb, tex, 0.85);
        }
        // Radial vignette (brighter centre, darker edges — Civ V hex look)
        float radial = clamp(length(vLocalXZ) / uHexRadius, 0.0, 1.0);
        diffuseColor.rgb *= mix(1.08, 0.86, radial * radial);
        // Side faces: darker, warm-shadowed
        if (vTopFace < 0.5) {
          diffuseColor.rgb *= 0.60;
          // Slight warm clay tint on sides
          diffuseColor.r *= 1.08;
          diffuseColor.g *= 1.03;
        }
        // Ocean shimmer — animated highlights on water tiles
        bool isOcean = (diffuseColor.b > diffuseColor.r * 1.1 &&
                        diffuseColor.g < diffuseColor.b * 0.90);
        if (isOcean && vTopFace > 0.5) {
          float wave  = 0.055 * sin(uTime * 1.8 + vLocalXZ.x * 0.09 + vLocalXZ.y * 0.07);
          float wave2 = 0.030 * sin(uTime * 2.6 - vLocalXZ.x * 0.05 + vLocalXZ.y * 0.11);
          diffuseColor.rgb += vec3(wave * 0.45, wave * 0.38 + wave2 * 0.5, wave + wave2);
        }`,
      )
      // ── Normal-map perturbation from atlas ──────────────────────────────────
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (uUseNormalAtlas > 0 && vTopFace > 0.5) {
          float _ntidx = floor(vTerrainIndex + 0.5);
          vec2 nauv  = terrainAtlasUv(_ntidx, vUv);
          vec3 nTex  = texture2D(uNormalAtlas, nauv).rgb * 2.0 - 1.0;
          // Blend atlas normal into surface normal (TBN for a flat-top hex is identity-ish)
          normal = normalize(normal + vec3(nTex.x * 0.55, nTex.z, nTex.y * 0.55));
        }`,
      );
  };

  mat.customProgramCacheKey = () => 'repociv-terrain-v3';
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
): void {
  const shader = (mat.userData as { shader?: Shader }).shader;
  if (!shader) return;
  shader.uniforms.uUseAtlas.value     = texture ? 1 : 0;
  shader.uniforms.uTerrainAtlas.value = texture;
  if (normalTexture !== undefined) {
    shader.uniforms.uUseNormalAtlas.value = normalTexture ? 1 : 0;
    shader.uniforms.uNormalAtlas.value    = normalTexture;
  }
}

/** Sky / horizon palette — warm Civ V afternoon. */
export const SKY_TOP     = new Color(0x89b5d4);   // was 0x7a9ec8 — warmer blue
export const SKY_HORIZON = new Color(0x9ab870);   // was 0x8aab85 — greener mid
export const FOG_DENSITY = 0.00025;               // was 0.00032 — slightly less haze
