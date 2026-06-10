// ─── Instanced terrain material: atlas texture + normal-map bump + Civ V lighting ──
import {
  Color,
  MeshStandardMaterial,
  Texture,
} from 'three';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Shader = any;
import { Vector2 } from 'three';
import { HEX_SIZE } from '../constants.ts';
import { TILE_PRISM_HEIGHT } from './hexGeometry.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { AXIAL_DIRECTIONS } from '../hex.ts';
import { type Terrain } from '../types.ts';

/** Unit XZ direction toward each axial neighbor, pre-divided by the
 *  center-to-shared-edge distance, so dot(vLocalXZ, dir) == 1.0 exactly at
 *  that edge. Order matches AXIAL_DIRECTIONS — the same order used to build
 *  the instanceCoastMask bits in HexWorldScene.ts. */
const COAST_EDGE_DIRS: Vector2[] = AXIAL_DIRECTIONS.map((d) => {
  const origin = axialToWorld3D(0, 0, 0);
  const neighbor = axialToWorld3D(d.q, d.r, 0);
  const dx = neighbor.x - origin.x;
  const dz = neighbor.z - origin.z;
  const dist = Math.hypot(dx, dz);
  const half = dist / 2;
  return new Vector2(dx / dist / half, dz / dist / half);
});

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

/** Per-biome prism height scale (local Y multiplier in vertex shader).
 *  At TILE_PRISM_HEIGHT=24, scale=1.0 makes hills (elev=2) prism bottom touch plains (elev=0) top.
 *  Scales >1.0 add extra depth for drama; mountain needs ≥1.5 to bridge 3-step gap. */
export const TERRAIN_HEIGHT_SCALE: Record<Terrain, number> = {
  plains:   1.0,
  forest:   1.0,
  mountain: 1.58,
  desert:   1.0,
  ocean:    0.70,
  ice:      0.90,
  hills:    1.12,
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
    shader.uniforms.uPrismHeight      = { value: TILE_PRISM_HEIGHT };
    shader.uniforms.uUseAtlas         = { value: options.terrainAtlas ? 1 : 0 };
    shader.uniforms.uTerrainAtlas     = { value: options.terrainAtlas ?? null };
    shader.uniforms.uNormalAtlas      = { value: options.normalAtlas ?? null };
    shader.uniforms.uUseNormalAtlas   = { value: options.normalAtlas ? 1 : 0 };
    shader.uniforms.uRoughnessAtlas   = { value: options.roughnessAtlas ?? null };
    shader.uniforms.uUseRoughAtlas    = { value: options.roughnessAtlas ? 1 : 0 };
    shader.uniforms.uAtlasColumns     = { value: options.atlasColumns ?? 4 };
    shader.uniforms.uAtlasRows        = { value: options.atlasRows ?? 3 };
    shader.uniforms.uCoastDir         = { value: COAST_EDGE_DIRS };
    (mat.userData as { shader?: Shader }).shader = shader;

    // ── Vertex ────────────────────────────────────────────────────────────────
    shader.vertexShader =
      'uniform float uTime;\n' +
      'uniform float uHexRadius;\n' +
      'attribute float instanceTerrain;\n' +
      'attribute float instanceNeighborTerrain;\n' +
      'attribute float instanceCoastMask;\n' +
      'varying float vTerrainIndex;\n' +
      'varying float vNeighborTerrainIndex;\n' +
      'varying float vCoastMask;\n' +
      'varying vec2  vLocalXZ;\n' +
      'varying vec2  vWorldXZ;\n' +
      'varying float vLocalY;\n' +
      'varying vec2  vUv;\n' +
      'varying float vTopFace;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainIndex = instanceTerrain;
        vNeighborTerrainIndex = instanceNeighborTerrain;
        vCoastMask    = instanceCoastMask;
        vLocalXZ      = vec2(position.x, position.z);
        vWorldXZ      = instanceMatrix[3].xz + transformed.xz;
        vLocalY       = transformed.y;
        vUv           = uv;
        // normal.y > 0.5 in local space → top face
        vTopFace      = step(0.5, normal.y);

        // Differential elevation: scale prism height by biome
        float heightScale = 1.0;
        float tidx = floor(instanceTerrain + 0.5);
        if (tidx < 0.5) heightScale = 1.0;          // plains
        else if (tidx < 1.5) heightScale = 1.0;     // forest
        else if (tidx < 2.5) heightScale = 1.58;   // mountain — 1.5+ needed to bridge 3 elevation steps
        else if (tidx < 3.5) heightScale = 1.0;     // desert
        else if (tidx < 4.5) heightScale = 0.70;   // ocean
        else if (tidx < 5.5) heightScale = 0.90;   // ice
        else if (tidx < 6.5) heightScale = 1.12;    // hills — 1.0+ closes gap to plains, 1.12 adds drama
        else if (tidx < 7.5) heightScale = 1.0;    // sacred

        // Only scale the downward (negative Y) part of the prism
        if (transformed.y < 0.0) {
          transformed.y *= heightScale;
        }

        // Cheap top-cap relief for hills/mountain: low-poly undulation so
        // elevated tiles stop being perfect mesas (iter3 gap #4). Static
        // world-position phase (no uTime): two same-biome neighbors displace
        // their shared edge identically, so tops stay continuous; the whole
        // cap (top fan + bevel + side-top ring, every vertex above the
        // bevel) moves together, so the prism stays watertight. Amplitude
        // 5% of hexRadius — within the ≤8% contract.
        bool reliefBiome = abs(tidx - 2.0) < 0.5 || abs(tidx - 6.0) < 0.5;
        if (reliefBiome && transformed.y > -1.0) {
          vec2 reliefPos = instanceMatrix[3].xz + transformed.xz;
          float relief = sin(reliefPos.x * 0.085) * cos(reliefPos.y * 0.097)
                       + 0.6 * sin(reliefPos.x * 0.21 + reliefPos.y * 0.16);
          transformed.y += relief * (uHexRadius * 0.05);
        }

        // Ocean wave animation: gentle vertical displacement. Phase runs on
        // WORLD position — with local coords every instance got its own
        // phase, so the shared edge between two ocean tiles displaced
        // differently and the sea opened visible seams.
        if (abs(tidx - 4.0) < 0.5) {
          vec2 wavePos = instanceMatrix[3].xz + transformed.xz;
          float wave = 0.35 * sin(uTime * 1.4 + wavePos.x * 0.12 + wavePos.y * 0.08);
          float wave2 = 0.18 * sin(uTime * 2.1 - wavePos.x * 0.07 + wavePos.y * 0.11);
          transformed.y += wave + wave2;
        }`,
      );

    // ── Fragment uniforms declaration ─────────────────────────────────────────
    const uniformDecl =
      'varying float vTerrainIndex;\n' +
      'varying float vNeighborTerrainIndex;\n' +
      'varying float vCoastMask;\n' +
      'varying vec2  vLocalXZ;\n' +
      'varying vec2  vWorldXZ;\n' +
      'varying float vLocalY;\n' +
      'varying vec2  vUv;\n' +
      'varying float vTopFace;\n' +
      'uniform vec2  uCoastDir[6];\n' +
      'uniform float uTime;\n' +
      'uniform float uHexRadius;\n' +
      'uniform float uPrismHeight;\n' +
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

vec2 terrainMacroUv(float idx, vec2 tileUv, vec2 worldXZ) {
  float scale = mix(3.2, 4.8, clamp(idx / 7.0, 0.0, 1.0));
  vec2 worldUv = fract(worldXZ / (uHexRadius * scale) + vec2(idx * 0.137, idx * 0.173));
  return mix(tileUv, worldUv, 0.78);
}

float terrainDetailNoise(vec2 p) {
  float a = sin(p.x * 0.055) * sin(p.y * 0.047);
  float b = sin(p.x * 0.113 + 1.7) * cos(p.y * 0.097 - 0.8);
  return 0.5 + 0.5 * (0.65 * a + 0.35 * b);
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
          vec2 macroUv = terrainMacroUv(tidx, vUv, vWorldXZ);
          vec2 auv = terrainAtlasUv(tidx, macroUv);
          vec3 tex = texture2D(uTerrainAtlas, auv).rgb;
          // Lift very dark textures so no biome goes black under warm lights
          tex = max(tex, vec3(0.08));
          // Mild saturation push only — enough to read biomes, not enough to look sticker-like
          float lum = dot(tex, vec3(0.299, 0.587, 0.114));
          tex = mix(vec3(lum), tex, 1.12);
          // Desert: compress local contrast and bias slightly toward a calmer sand tone.
          if (tidx > 2.5 && tidx < 3.5) {
            tex = mix(vec3(lum), tex, 0.92);
            tex = mix(tex, vec3(0.73, 0.63, 0.40), 0.12);
          }
          // Sacred should feel special, not neon enough to dominate the whole map.
          if (tidx > 6.5) {
            tex = mix(vec3(dot(tex, vec3(0.299, 0.587, 0.114))), tex, 0.82);
            tex *= 0.82;
          }
          // Neighbour biome blend at hex edges
          float edgeBlend = smoothstep(0.58, 0.96, radial);
          if (ntidx >= 0.0 && abs(ntidx - tidx) > 0.5) {
            vec2 nMacroUv = terrainMacroUv(ntidx, vUv, vWorldXZ);
            vec2 nauv = terrainAtlasUv(ntidx, nMacroUv);
            vec3 nTex = texture2D(uTerrainAtlas, nauv).rgb;
            nTex = max(nTex, vec3(0.08));
            float nLum = dot(nTex, vec3(0.299, 0.587, 0.114));
            nTex = mix(vec3(nLum), nTex, 1.12);
            if (ntidx > 2.5 && ntidx < 3.5) {
              nTex = mix(vec3(nLum), nTex, 0.92);
              nTex = mix(nTex, vec3(0.73, 0.63, 0.40), 0.12);
            }
            if (ntidx > 6.5) {
              nTex = mix(vec3(dot(nTex, vec3(0.299, 0.587, 0.114))), nTex, 0.82);
              nTex *= 0.82;
            }
            bool mountainForestPair =
              ((tidx > 1.5 && tidx < 2.5) && (ntidx > 0.5 && ntidx < 1.5)) ||
              ((tidx > 0.5 && tidx < 1.5) && (ntidx > 1.5 && ntidx < 2.5));
            if (mountainForestPair) {
              edgeBlend = min(1.0, edgeBlend * 1.30);
            }
            tex = mix(tex, nTex, edgeBlend * 0.62);
          }
          // Top-face brightening so atlas colours read through warm PBR lights
          tex *= 1.15;
          // Very light global tonal glue so biomes feel painted under the same sky.
          tex = mix(tex, tex * vec3(0.97, 0.995, 0.96), 0.15);
          // Subtle world-space microvariation so broad top faces feel like terrain, not flat panels.
          float detail = terrainDetailNoise(vWorldXZ);
          if (tidx < 0.5) {
            tex *= mix(0.985, 1.035, detail);
            tex = mix(tex, tex * vec3(0.96, 1.03, 0.95), 0.10 * detail);
          } else if (tidx < 1.5) {
            tex *= mix(0.97, 1.02, detail);
            tex = mix(tex, tex * vec3(0.94, 1.02, 0.95), 0.12 * detail);
          } else if (tidx < 2.5) {
            tex *= mix(0.96, 1.015, detail);
            tex = mix(tex, tex * vec3(0.97, 0.99, 1.01), 0.10 * detail);
          } else if (tidx < 6.5) {
            tex *= mix(0.985, 1.025, detail);
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, tex, 0.82);
        }
        // Radial vignette — very subtle
        if (vTopFace > 0.5) {
          diffuseColor.rgb *= mix(1.03, 0.985, radial * radial);
        }
        // Side faces: use a vertical gradient so elevated tiles read as terrain mass, not flat dark boxes.
        if (vTopFace < 0.5) {
          float cliffT = clamp((-vLocalY) / max(uPrismHeight, 0.001), 0.0, 1.0);
          float topShade = (tidx > 1.5 && tidx < 2.5) ? 0.86 : 0.90;
          float bottomShade = (tidx > 1.5 && tidx < 2.5) ? 0.60 : 0.68;
          float cliffShade = mix(topShade, bottomShade, smoothstep(0.08, 1.0, cliffT));
          diffuseColor.rgb *= cliffShade;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.96, 0.98, 0.94), 0.18);
        }
        // Ocean shimmer
        bool isOcean = (diffuseColor.b > diffuseColor.r * 1.05 &&
                        diffuseColor.g < diffuseColor.b * 0.92);
        if (isOcean && vTopFace > 0.5) {
          float wave  = 0.06 * sin(uTime * 1.8 + vLocalXZ.x * 0.09 + vLocalXZ.y * 0.07);
          float wave2 = 0.03 * sin(uTime * 2.6 - vLocalXZ.x * 0.05 + vLocalXZ.y * 0.11);
          diffuseColor.rgb += vec3(wave * 0.3, wave * 0.25 + wave2 * 0.4, wave + wave2 * 1.2);
        }
        // Civ V shoreline ring: foam band hugging each edge where ocean
        // meets land. instanceCoastMask carries a 6-bit mask of boundary
        // edges (AXIAL_DIRECTIONS order); uCoastDir[k] is the matching edge
        // normal pre-scaled so dot(vLocalXZ, dir) == 1.0 at the shared edge.
        // Both sides of the boundary get foam — stronger on the water side.
        // The pulse reuses uTime like the shimmer above, so ?freeze=<s>
        // keeps golden captures deterministic.
        if (vTopFace > 0.5 && vCoastMask > 0.5) {
          float coastMask = floor(vCoastMask + 0.5);
          float edgeT = 0.0;
          for (int k = 0; k < 6; k++) {
            float bit = mod(floor(coastMask / pow(2.0, float(k))), 2.0);
            if (bit > 0.5) {
              edgeT = max(edgeT, dot(vLocalXZ, uCoastDir[k]));
            }
          }
          bool selfOcean = (tidx > 3.5 && tidx < 4.5);
          float ring = smoothstep(0.74, 0.97, edgeT);
          float foamPulse = 0.82 + 0.18 * sin(uTime * 1.7 + vWorldXZ.x * 0.045 + vWorldXZ.y * 0.038);
          float foamAmt = ring * foamPulse * (selfOcean ? 0.60 : 0.30);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.85, 0.88), foamAmt);
        }`,
      )
      // ── Per-biome roughness from atlas (correct atlas UV, not raw tile UV) ──
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        if (uUseRoughAtlas > 0 && vTopFace > 0.5) {
          float _rtidx = floor(vTerrainIndex + 0.5);
          vec2 rmacroUv = terrainMacroUv(_rtidx, vUv, vWorldXZ);
          vec2 rauv = terrainAtlasUv(_rtidx, rmacroUv);
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
          vec2 nmacroUv = terrainMacroUv(_ntidx, vUv, vWorldXZ);
          vec2 nauv  = terrainAtlasUv(_ntidx, nmacroUv);
          vec3 nTex  = texture2D(uNormalAtlas, nauv).rgb * 2.0 - 1.0;
          // Blend neighbor normal at edges
          float _radial = clamp(length(vLocalXZ) / uHexRadius, 0.0, 1.0);
          float _edgeBlend = smoothstep(0.58, 0.96, _radial);
          if (_nntidx >= 0.0 && abs(_nntidx - _ntidx) > 0.5) {
            vec2 nnmacroUv = terrainMacroUv(_nntidx, vUv, vWorldXZ);
            vec2 nnauv = terrainAtlasUv(_nntidx, nnmacroUv);
            vec3 nNeighbor = texture2D(uNormalAtlas, nnauv).rgb * 2.0 - 1.0;
            nTex = mix(nTex, nNeighbor, _edgeBlend * 0.62);
          }
          // Blend atlas normal into surface normal (TBN for a flat-top hex is identity-ish)
          normal = normalize(normal + vec3(nTex.x * 0.55, nTex.z, nTex.y * 0.55));
        }`,
      );
  };

  // Cache key: bump on any GLSL change so the GPU program is
  // re-compiled. Source-level changes to the chunk-replace blocks
  // below require a version bump here, otherwise three's WebGL
  // program cache will keep the old program around. See test in
  // terrainShader.test.ts.
  mat.customProgramCacheKey = () => 'repociv-terrain-v17';
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
