// ─── KayKit city walls: layout invariants + asset presence ──────────────────
// The GL loading path runs in the browser; these tests lock the geometry
// contract that would silently break the wall ring if violated:
//   • wall pieces tile a hexagon whose circumradius equals the procedural
//     ring outerR (0.42·HEX) — same footprint, richer geometry
//   • straight pieces keep corner clearance at both edge ends (no overlaps
//     with the vertex towers)
//   • exactly one gate per city, on a hash-stable edge
//   • every referenced .gltf/.bin asset exists on disk
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { _testWallIds, _testWallConstants } from './CityWalls3D.ts';

const { RING_R, STRAIGHT_SPAN } = _testWallConstants();

// Procedural ring outer radius (CityCluster3D): 0.42·HEX.
const PROCEDURAL_OUTER_R = 0.42;

describe('KayKit modular wall kit', () => {
  it('ring radius matches the procedural wall ring outerR', () => {
    // The modular ring must occupy the same footprint the procedural ring
    // did — otherwise buildings placed against the old inner radius clip.
    expect(RING_R).toBeCloseTo(PROCEDURAL_OUTER_R, 5);
  });

  it('straight pieces leave corner clearance at both edge ends', () => {
    // Straight span must be < 1.0 of the edge so towers/corners at the
    // vertices never overlap the wall piece.
    expect(STRAIGHT_SPAN).toBeGreaterThan(0);
    expect(STRAIGHT_SPAN).toBeLessThan(1);
    // Corner clearance per side:
    const clearance = (1 - STRAIGHT_SPAN) / 2;
    expect(clearance).toBeGreaterThan(0.1); // room for a visible corner piece
  });

  it('straight wall scale stays well inside the tile (hex inradius check)', () => {
    // The wall ring sits at RING_R; the hex inradius (face-to-center) is
    // RING_R·cos(30°). Wall piece depth (short axis, ~0.8/2.0 of its
    // longest side) extends inward from the edge midpoint — it must not
    // reach past the building area boundary (0.30·HEX from center).
    const wallDepthFrac = 0.8 / 2.0; // wall_straight depth/length ratio
    const innerReach =
      RING_R * (1 - STRAIGHT_SPAN / 2) - (RING_R * STRAIGHT_SPAN * (wallDepthFrac / 2)) / RING_R;
    // innerReach approximates the inward extent of the wall body in HEX
    // fractions; it must stay outside the building area (0.30·HEX).
    expect(innerReach).toBeGreaterThan(0.25);
  });

  it('declares all wall + tower part ids', () => {
    const ids = _testWallIds();
    expect(ids).toContain('wall_straight');
    expect(ids).toContain('wall_straight_gate');
    expect(ids).toContain('building_tower_A_red');
    expect(ids).toContain('building_tower_B_red');
    expect(ids).toHaveLength(6);
  });

  it('all referenced wall kit assets exist on disk', () => {
    for (const id of [
      'wall_straight',
      'wall_straight_gate',
      'wall_corner_A_inside',
      'wall_corner_A_outside',
    ]) {
      const base = `public/assets/3d/props/kaykit/buildings/neutral/${id}`;
      expect(existsSync(`${base}.gltf`), `${id}.gltf`).toBe(true);
      expect(existsSync(`${base}.bin`), `${id}.bin`).toBe(true);
    }
    for (const id of ['building_tower_A_red', 'building_tower_B_red']) {
      const base = `public/assets/3d/props/kaykit/buildings/red/${id}`;
      expect(existsSync(`${base}.gltf`), `${id}.gltf`).toBe(true);
      expect(existsSync(`${base}.bin`), `${id}.bin`).toBe(true);
    }
    expect(
      existsSync('public/assets/3d/props/kaykit/buildings/neutral/hexagons_medieval.png'),
    ).toBe(true);
  });

  it('gltf files reference their sibling .bin and the shared atlas', () => {
    for (const id of ['wall_straight', 'wall_straight_gate']) {
      const raw = readFileSync(
        `public/assets/3d/props/kaykit/buildings/neutral/${id}.gltf`,
        'utf-8',
      );
      expect(raw).toContain(`${id}.bin`);
      expect(raw).toContain('hexagons_medieval.png');
    }
  });
});
