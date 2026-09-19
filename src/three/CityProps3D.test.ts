// ─── KayKit city props: recipe invariants + asset presence ──────────────────
// The GL loading path is exercised in the browser; these tests lock the
// data contracts that would silently break the map if violated:
//   • every recipe part references a known PROP_ID
//   • every part footprint stays inside the procedural wall ring
//   • every referenced .gltf/.bin asset exists on disk (public/ is the
//     dev-server root, so presence there == served at /assets/…)
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { _testRecipes } from './CityProps3D.ts';

const { PROP_IDS, RECIPES, LEVEL_RECIPE, CAPITAL_SUBURBS } = _testRecipes();

// Inner radius of the procedural wall ring (CityCluster3D): 0.34·HEX.
// Part edge = dist(offset)·HEX + s·HEX/2 must stay inside it.
const WALL_INNER = 0.34;

function dist(ox: number, oz: number): number {
  return Math.hypot(ox, oz);
}

describe('KayKit city prop recipes', () => {
  it('every recipe part references a known PROP_ID', () => {
    for (const [name, parts] of Object.entries(RECIPES)) {
      for (const part of parts) {
        expect(PROP_IDS, `${name} → ${part.id}`).toContain(part.id);
      }
    }
  });

  it('every recipe keeps all part footprints inside the wall ring', () => {
    for (const [name, parts] of Object.entries(RECIPES)) {
      for (const part of parts) {
        const edge = dist(part.ox, part.oz) + part.s / 2;
        expect(edge, `${name} part ${part.id} edge=${edge.toFixed(3)}·HEX`).toBeLessThan(
          WALL_INNER,
        );
      }
    }
  });

  it('capital suburbs sit outside the wall towers and inside the tile', () => {
    // Vertex towers reach ~0.5·HEX from centre; the hex inradius is 0.866·HEX.
    expect(CAPITAL_SUBURBS.length).toBeGreaterThan(0);
    for (const part of CAPITAL_SUBURBS) {
      expect(PROP_IDS).toContain(part.id);
      const d = dist(part.ox, part.oz);
      expect(d - part.s / 2, `${part.id} inner edge`).toBeGreaterThan(0.5);
      expect(d + part.s / 2, `${part.id} outer edge`).toBeLessThan(Math.sqrt(3) / 2);
    }
  });

  it('every city level maps to a recipe', () => {
    expect(LEVEL_RECIPE).toHaveLength(4);
    for (const key of LEVEL_RECIPE) {
      expect(Object.keys(RECIPES)).toContain(key);
    }
  });

  it('non-capital recipes have 3+ parts (village-cluster feel)', () => {
    for (const key of LEVEL_RECIPE) {
      expect(RECIPES[key as keyof typeof RECIPES].length).toBeGreaterThanOrEqual(3);
    }
  });

  it('all referenced KayKit assets exist on disk', () => {
    for (const id of PROP_IDS) {
      const base = `public/assets/3d/props/kaykit/buildings/red/${id}`;
      expect(existsSync(`${base}.gltf`), `${id}.gltf`).toBe(true);
      expect(existsSync(`${base}.bin`), `${id}.bin`).toBe(true);
    }
    expect(existsSync('public/assets/3d/props/kaykit/buildings/red/hexagons_medieval.png')).toBe(
      true,
    );
    expect(existsSync('public/assets/3d/props/kaykit/LICENSE-KayKit.txt')).toBe(true);
  });

  it('gltf files reference their sibling .bin and the shared atlas', () => {
    for (const id of PROP_IDS) {
      const raw = readFileSync(`public/assets/3d/props/kaykit/buildings/red/${id}.gltf`, 'utf-8');
      expect(raw).toContain(`${id}.bin`);
      expect(raw).toContain('hexagons_medieval.png');
    }
  });
});
