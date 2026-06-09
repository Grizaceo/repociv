// ─── Terrain texture atlas loader (lazy, with vertex-color fallback) ────
import {
  LinearMipmapLinearFilter,
  LinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from 'three';
import { type Terrain } from '../types.ts';

export interface TerrainAtlasMeta {
  version: number;
  kind: 'repociv-3d-terrain-atlas';
  texture: string;
  normalTexture: string | null;
  cellSize: number;
  columns: number;
  terrains: Record<
    string,
    {
      index: number;
      rect: [number, number, number, number];
      uvRect: [number, number, number, number];
    }
  >;
}

export interface LoadedTerrainAtlas {
  meta: TerrainAtlasMeta;
  texture: Texture;
  normalTexture: Texture | null;
}

let cached: Promise<LoadedTerrainAtlas | null> | null = null;

export function loadTerrainAtlas(): Promise<LoadedTerrainAtlas | null> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const res = await fetch('/assets/3d/terrain-atlas-3d.json');
      if (!res.ok) return null;
      const meta = (await res.json()) as TerrainAtlasMeta;
      const loader = new TextureLoader();
      const texture = await loader.loadAsync(meta.texture);
      texture.colorSpace = SRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.needsUpdate = true;

      let normalTexture: Texture | null = null;
      if (meta.normalTexture) {
        try {
          normalTexture = await loader.loadAsync(meta.normalTexture);
          normalTexture.wrapS = RepeatWrapping;
          normalTexture.wrapT = RepeatWrapping;
          normalTexture.minFilter = LinearMipmapLinearFilter;
          normalTexture.magFilter = LinearFilter;
          normalTexture.needsUpdate = true;
        } catch {
          normalTexture = null;
        }
      }
      return { meta, texture, normalTexture };
    } catch {
      return null;
    }
  })();
  return cached;
}

export function terrainAtlasIndex(
  meta: TerrainAtlasMeta | null,
  terrain: Terrain,
): number {
  return meta?.terrains[terrain]?.index ?? 0;
}
