// ─── RepoCiv — Office sprite atlas loader ──────────────────────────────────────
// The manifest and image are fetched only when local view first opens. If either
// asset fails, the renderer keeps its procedural sprites.

import { logger } from './logger.ts';

const OFFICE_ATLAS_MANIFEST_URL = '/assets/office-atlas.json';

export interface OfficeAtlasManifest {
  atlas: string;
  cellWidth: number;
  cellHeight: number;
  spriteRects: Record<string, [number, number, number, number]>;
}

export type OfficeSpriteName =
  | 'desk_l'
  | 'desk_r'
  | 'chair'
  | 'partition_h'
  | 'partition_v'
  | 'reception_desk'
  | 'watercooler'
  | 'plant'
  | 'whiteboard'
  | 'ceiling_light'
  | 'carpet_tile';

let _sprites: Record<string, HTMLCanvasElement> = {};
let _loaded = false;
let _loadPromise: Promise<boolean> | null = null;

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.src = url;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
  });

export function parseOfficeAtlasManifest(value: unknown): OfficeAtlasManifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<OfficeAtlasManifest>;
  if (
    typeof candidate.atlas !== 'string' ||
    !candidate.atlas.startsWith('/') ||
    !Number.isFinite(candidate.cellWidth) ||
    !Number.isFinite(candidate.cellHeight) ||
    typeof candidate.spriteRects !== 'object' ||
    candidate.spriteRects === null
  ) {
    return null;
  }
  return candidate as OfficeAtlasManifest;
}

async function loadManifest(): Promise<OfficeAtlasManifest> {
  const response = await fetch(OFFICE_ATLAS_MANIFEST_URL);
  if (!response.ok)
    throw new Error(`Failed to load ${OFFICE_ATLAS_MANIFEST_URL}: ${response.status}`);
  const manifest = parseOfficeAtlasManifest(await response.json());
  if (!manifest) throw new Error('Invalid office atlas manifest');
  return manifest;
}

function extractToCanvas(
  src: HTMLImageElement,
  rect: [number, number, number, number],
  targetW: number,
  targetH: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const cctx = canvas.getContext('2d')!;
  cctx.clearRect(0, 0, targetW, targetH);
  cctx.drawImage(
    src,
    rect[0],
    rect[1],
    rect[2] - rect[0],
    rect[3] - rect[1],
    0,
    0,
    targetW,
    targetH,
  );
  return canvas;
}

/** Lazy-load office atlas (idempotent). Returns true when sprites are ready. */
export async function loadOfficeAtlas(): Promise<boolean> {
  if (_loaded) return true;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const manifest = await loadManifest();
      const atlasImg = await loadImage(manifest.atlas);
      const sprites: Record<string, HTMLCanvasElement> = {};
      for (const [name, rect] of Object.entries(manifest.spriteRects)) {
        sprites[name] = extractToCanvas(
          atlasImg,
          rect as [number, number, number, number],
          manifest.cellWidth,
          manifest.cellHeight,
        );
      }
      _sprites = sprites;
      _loaded = true;
      return true;
    } catch (err) {
      logger.warn('Failed to load office atlas image:', err);
      _loaded = false;
      return false;
    }
  })();

  return _loadPromise;
}

export function isOfficeAtlasLoaded(): boolean {
  return _loaded;
}

export function getOfficeSprite(name: OfficeSpriteName): HTMLCanvasElement | null {
  return _sprites[name] ?? null;
}
