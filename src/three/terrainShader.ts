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
      'attribute float instanceOceanDepth;\n' +
      'varying float vTerrainIndex;\n' +
      'varying float vNeighborTerrainIndex;\n' +
      'varying float vCoastMask;\n' +
      'varying float vOceanDepth;\n' +
      'varying vec2  vLocalXZ;\n' +
      'varying vec2  vWorldXZ;\n' +
      'varying float vLocalY;\n' +
      'varying vec2  vUv;\n' +
      'varying float vTopFace;\n' +
      // ── GLSL noise functions (public domain, hash-based value noise) ──────
      'float hash21(vec2 p) {\n' +
      '  p = fract(p * vec2(123.34, 456.21));\n' +
      '  p += dot(p, p + 45.32);\n' +
      '  return fract(p.x * p.y);\n' +
      '}\n' +
      'float valueNoise2D(vec2 p) {\n' +
      '  vec2 i = floor(p);\n' +
      '  vec2 f = fract(p);\n' +
      '  vec2 u = f * f * (3.0 - 2.0 * f);\n' +
      '  float a = hash21(i);\n' +
      '  float b = hash21(i + vec2(1.0, 0.0));\n' +
      '  float c = hash21(i + vec2(0.0, 1.0));\n' +
      '  float d = hash21(i + vec2(1.0, 1.0));\n' +
      '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n' +
      '}\n' +
      'float fbm3(vec2 p) {\n' +
      '  float s = 0.0;\n' +
      '  float a = 0.5;\n' +
      '  for (int i = 0; i < 3; i++) {\n' +
      '    s += a * valueNoise2D(p);\n' +
      '    p *= 2.0;\n' +
      '    a *= 0.5;\n' +
      '  }\n' +
      '  return s;\n' +
      '}\n' +
      'float ridge3(vec2 p) {\n' +
      '  float s = 0.0;\n' +
      '  float a = 0.5;\n' +
      '  for (int i = 0; i < 3; i++) {\n' +
      '    float n = 1.0 - abs(valueNoise2D(p) * 2.0 - 1.0);\n' +
      '    s += a * n * n;\n' +
      '    p *= 2.0;\n' +
      '    a *= 0.5;\n' +
      '  }\n' +
      '  return s;\n' +
      '}\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainIndex = instanceTerrain;
        vNeighborTerrainIndex = instanceNeighborTerrain;
        vCoastMask    = instanceCoastMask;
        vOceanDepth   = instanceOceanDepth;
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

        // Ocean: flatten the bevel groove. Adjacent water tiles each dip
        // BEVEL_DEPTH at their rim, and from a low camera the V-groove
        // between them reads as black notches on the sea silhouette. Water
        // has no need for the bevel (it exists to soften land prism edges),
        // so lift the whole top cap to y=0 — the sea becomes one continuous
        // surface and the wave displacement (world-phase) keeps it seamless.
        if (abs(tidx - 4.0) < 0.5 && transformed.y > -1.0) {
          transformed.y = 0.0;
        }

        // Top-cap micro-relief for all land biomes: FBM noise replaces
        // the old sin/cos mesa-breaker. World-space phase (no uTime)
        // keeps same-biome neighbors continuous; only top cap + bevel
        // (y > -1.0) moves so prisms stay watertight.
        bool isOceanTile = abs(tidx - 4.0) < 0.5;
        bool isIceTile = abs(tidx - 5.0) < 0.5;
        if (!isOceanTile && !isIceTile && transformed.y > -1.0) {
          vec2 noisePos = instanceMatrix[3].xz + transformed.xz;
          if (tidx < 0.5) {
            // plains: gentle rolling, 3% hexRadius
            float r = (fbm3(noisePos * 0.04) - 0.5) * 2.0;
            transformed.y += r * (uHexRadius * 0.03);
          } else if (tidx < 1.5) {
            // forest: slightly more varied, 4%
            float r = (fbm3(noisePos * 0.05) - 0.5) * 2.0;
            transformed.y += r * (uHexRadius * 0.04);
          } else if (tidx < 2.5) {
            // mountain: jagged peaks, 12%, ridge noise
            float r = ridge3(noisePos * 0.06);
            transformed.y += r * (uHexRadius * 0.12);
          } else if (tidx < 3.5) {
            // desert: dune-like swells, 5%, anisotropic
            vec2 dunePos = vec2(noisePos.x * 0.03 + noisePos.y * 0.08, noisePos.y * 0.02);
            float r = (fbm3(dunePos) - 0.5) * 2.0;
            transformed.y += r * (uHexRadius * 0.05);
          } else if (tidx < 6.5) {
            // hills: clear ridgelines, 8%, ridge noise
            float r = ridge3(noisePos * 0.055);
            transformed.y += r * (uHexRadius * 0.08);
          } else if (tidx < 7.5) {
            // sacred: gentle, 3%
            float r = (fbm3(noisePos * 0.045) - 0.5) * 2.0;
            transformed.y += r * (uHexRadius * 0.03);
          }
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
      'varying float vOceanDepth;\n' +
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
          // Desert: compress local contrast and bias toward Civ V pale sand —
          // the raw atlas cell reads as plowed brown furrows otherwise.
          if (tidx > 2.5 && tidx < 3.5) {
            tex = mix(vec3(lum), tex, 0.78);
            tex = mix(tex, vec3(0.80, 0.71, 0.50), 0.30);
          }
          // Sacred: Civ V natural-wonder feel — pale gilded stone. The raw
          // cell (and the #1e1530 palette) read as dark violet bruises that
          // dominated every overview shot.
          if (tidx > 6.5) {
            float slum = dot(tex, vec3(0.299, 0.587, 0.114));
            tex = mix(tex, vec3(0.85, 0.77, 0.55) * (0.55 + 0.9 * slum), 0.78);
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
              nTex = mix(vec3(nLum), nTex, 0.78);
              nTex = mix(nTex, vec3(0.80, 0.71, 0.50), 0.30);
            }
            if (ntidx > 6.5) {
              float nslum = dot(nTex, vec3(0.299, 0.587, 0.114));
              nTex = mix(nTex, vec3(0.85, 0.77, 0.55) * (0.55 + 0.9 * nslum), 0.78);
            }
            bool mountainForestPair =
              ((tidx > 1.5 && tidx < 2.5) && (ntidx > 0.5 && ntidx < 1.5)) ||
              ((tidx > 0.5 && tidx < 1.5) && (ntidx > 1.5 && ntidx < 2.5));
            if (mountainForestPair) {
              edgeBlend = min(1.0, edgeBlend * 1.30);
            }
            tex = mix(tex, nTex, edgeBlend * 0.62);
          }
          // High-frequency detail tap (land only): the baked atlas blurs at
          // mid zoom; re-sampling the same cell at ~3.7× world frequency and
          // overlaying its luminance deviation restores painted grain
          // without new assets. Centered ≈1.0 so overall tone holds.
          if (tidx < 3.5 || tidx > 5.5) {
            vec2 dUv = fract(vWorldXZ / (uHexRadius * 1.27) + vec2(tidx * 0.311, tidx * 0.293));
            vec3 dTex = texture2D(uTerrainAtlas, terrainAtlasUv(tidx, dUv)).rgb;
            float dLum = dot(dTex, vec3(0.299, 0.587, 0.114));
            tex *= 0.86 + 0.28 * dLum;
          }
          // Civ V sea gradient: vivid turquoise on the shelf → deep saturated
          // blue offshore. instanceOceanDepth = BFS hops from the nearest
          // coast (0 = coastal, 1 = open sea); the old flat teal only varied
          // inside coastal tiles via the edge gradient below.
          if (tidx > 3.5 && tidx < 4.5) {
            vec3 seaTint = mix(vec3(0.30, 0.63, 0.66), vec3(0.05, 0.28, 0.60), vOceanDepth);
            tex = mix(tex, seaTint, 0.66);
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
          // Sacred's palette fill (#1e1530) is near-black: at the default 0.82
          // mix its 18% leak still muddies the gilded look, so let the atlas
          // win almost completely there.
          float texMix = (tidx > 6.5) ? 0.93 : 0.82;
          diffuseColor.rgb = mix(diffuseColor.rgb, tex, texMix);
        }
        // Radial vignette — very subtle
        if (vTopFace > 0.5) {
          diffuseColor.rgb *= mix(1.03, 0.985, radial * radial);
        }
        // Side faces: Civ V cliffs. The raw palette fill went near-black on
        // shaded flanks (forest fill is 0x2d5a27), which read as black wedges
        // around every elevated tile. Land cliffs now lean on a warm
        // earth/rock tone, scaled by the incoming vertex-color luminance so
        // fog dimming still darkens them. Water/ice keep the old gradient.
        if (vTopFace < 0.5) {
          float cliffT = clamp((-vLocalY) / max(uPrismHeight, 0.001), 0.0, 1.0);
          bool waterSide = (tidx > 3.5 && tidx < 5.5);
          if (waterSide) {
            // Water flanks: shallow-water column, not a void. Mostly replaces
            // the dark palette blue so any sliver still visible after the
            // bevel flattening reads as sea, with depth shading below.
            vec3 waterFlank = vec3(0.18, 0.44, 0.50);
            float wlum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = mix(diffuseColor.rgb, waterFlank * clamp(0.6 + 1.6 * wlum, 0.0, 1.1), 0.72);
            float cliffShade = mix(1.0, 0.80, smoothstep(0.08, 1.0, cliffT));
            diffuseColor.rgb *= cliffShade;
          } else {
            float dlum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            bool rockBiome = (tidx > 1.5 && tidx < 2.5) || (tidx > 5.5 && tidx < 6.5);
            // Civ V cliff tan — bright enough to survive ambient-only shading
            // on flanks facing away from the sun (the old 0.52/0.43/0.30 read
            // as dark grey wedges around every elevation step).
            vec3 earth = rockBiome ? vec3(0.58, 0.55, 0.50) : vec3(0.64, 0.53, 0.38);
            vec3 cliffCol = earth;
            // Strata texture on the flank: reuse the mountain atlas cell as a
            // generic rock face, projected in world space (x+z along the wall,
            // local depth down it) so adjacent prisms continue the pattern.
            if (uUseAtlas > 0) {
              vec2 cliffUv = fract(vec2(
                (vWorldXZ.x + vWorldXZ.y * 0.7) / (uHexRadius * 1.4),
                (-vLocalY) / (uHexRadius * 1.4)));
              vec3 cliffTex = texture2D(uTerrainAtlas, terrainAtlasUv(2.0, cliffUv)).rgb;
              float ctlum = dot(cliffTex, vec3(0.299, 0.587, 0.114));
              cliffCol = earth * clamp(0.25 + 1.3 * ctlum, 0.0, 1.25);
            }
            diffuseColor.rgb = mix(diffuseColor.rgb, cliffCol * clamp(0.60 + 0.9 * dlum, 0.0, 1.15), 0.85);
            float cliffShade = mix(1.0, 0.80, smoothstep(0.08, 1.0, cliffT));
            diffuseColor.rgb *= cliffShade;
          }
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
          // Civ V shallow-water gradient: ocean tiles brighten toward
          // turquoise across the half of the tile nearest the coast, so the
          // sea reads deep→shallow instead of one flat blue.
          if (selfOcean) {
            float shallow = smoothstep(0.05, 0.95, edgeT);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.66, 0.68), shallow * 0.50);
            // Sandy seabed showing through right at the waterline — the
            // Civ V coast signature is blue → teal → warm sandy green.
            float seabed = smoothstep(0.72, 0.98, edgeT);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.52, 0.72, 0.58), seabed * 0.30);
          }
          float ring = smoothstep(0.74, 0.97, edgeT);
          float foamPulse = 0.82 + 0.18 * sin(uTime * 1.7 + vWorldXZ.x * 0.045 + vWorldXZ.y * 0.038);
          float foamAmt = ring * foamPulse * (selfOcean ? 0.78 : 0.34);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.66, 0.90, 0.90), foamAmt);
          // Second, fainter foam band further out on the water — Civ V coasts
          // break twice. Offset phase so the two bands don't pulse in lockstep.
          if (selfOcean) {
            float ring2 = smoothstep(0.46, 0.58, edgeT) * (1.0 - smoothstep(0.60, 0.72, edgeT));
            float foamPulse2 = 0.78 + 0.22 * sin(uTime * 1.3 + vWorldXZ.x * 0.052 - vWorldXZ.y * 0.041 + 1.9);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.48, 0.80, 0.84), ring2 * foamPulse2 * 0.22);
          }
        }
        // ── Final Civ V grade ──────────────────────────────────────────────
        // Vibrance + a warm lift on land only. ACES tone mapping compresses
        // the pastel atlas into mud without this; the ocean keeps its cool
        // teal (a global warm shift greened it).
        {
          float glum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(vec3(glum), diffuseColor.rgb, 1.14);
          bool gradeWater = (tidx > 3.5 && tidx < 4.5) || (tidx > 4.5 && tidx < 5.5);
          if (!gradeWater) {
            diffuseColor.rgb *= vec3(1.06, 1.01, 0.94);
          }
          diffuseColor.rgb = clamp(diffuseColor.rgb, 0.0, 1.0);
        }`,
      )
      // ── Side-face emissive lift ──────────────────────────────────────────────
      // Flanks facing away from the sun only get ambient light and went
      // near-black regardless of albedo. A fraction of the cliff diffuse as
      // self-illumination keeps every flank readable (Civ V cliffs are never
      // black) while preserving directional shading on top of it. Scaled by
      // the diffuse itself, so fog-dimmed tiles keep dim flanks.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vTopFace < 0.5) {
          totalEmissiveRadiance += diffuseColor.rgb * 0.38;
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
        }
        // Wet sea: low roughness gives the directional sun a real specular
        // glint on the water (slightly glossier offshore). The baked atlas
        // roughness for the ocean cell is matte — terrain-like — and killed
        // any sun reflection.
        if (vTopFace > 0.5) {
          float _gtidx = floor(vTerrainIndex + 0.5);
          if (_gtidx > 3.5 && _gtidx < 4.5) {
            roughnessFactor = mix(0.30, 0.17, vOceanDepth);
          }
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
  mat.customProgramCacheKey = () => 'repociv-terrain-v25';
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
export const FOG_DENSITY = 0.00019;               // v22: ACES + sun boost already model depth; the old haze went milky at mid-zoom
