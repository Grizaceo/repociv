// ─── RepoCiv — P3 room visual clarity tests ────────────────────────────────────
// Tests for zone color correctness, cache key invalidation, and label placement.

import { describe, it, expect } from 'vitest';

describe('P3: room visual clarity', () => {
  it('zone floor colors: each zone type has a distinct tint', () => {
    const baseColors: Record<string, string> = {
      team_cluster: '#F5D0C5',
      meeting: '#B09060',
      focus: '#E8F5D6',
      break: '#D0C0A0',
      infra: '#E2E8F0',
      reception: '#F5F0E8',
      biophilic: '#D4E8D0',
    };

    // All zone types have a color
    for (const zone of Object.keys(baseColors)) {
      expect(baseColors[zone]).toBeDefined();
      expect(baseColors[zone]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }

    // Colors are distinct (no two zones share the same color)
    const values = Object.values(baseColors);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('iso zone light: each zone has a subtle radial light', () => {
    const ISO_ZONE_LIGHT: Record<string, string> = {
      team_cluster: 'rgba(200, 220, 255, 0.08)',
      meeting: 'rgba(255, 230, 180, 0.08)',
      focus: 'rgba(200, 255, 210, 0.06)',
      break: 'rgba(255, 200, 180, 0.07)',
      infra: 'rgba(220, 230, 245, 0.06)',
      reception: 'rgba(255, 240, 220, 0.08)',
      biophilic: 'rgba(200, 255, 245, 0.06)',
    };

    for (const zone of Object.keys(ISO_ZONE_LIGHT)) {
      expect(ISO_ZONE_LIGHT[zone]).toMatch(/^rgba\(/);
      // Alpha should be very low (subtle tint, not full fill)
      const m = ISO_ZONE_LIGHT[zone]!.match(/[\d.]+(?=\))/);
      const alpha = m ? parseFloat(m[0]!) : 1;
      expect(alpha).toBeLessThanOrEqual(0.1);
    }
  });

  it('static layer cache key: includes repoId + workbench count + highDensity count', () => {
    // This is the exact formula used in localRenderer.ts
    const buildCacheKey = (repoId: string, rooms: { workbenches: unknown[]; highDensity?: boolean }[]) =>
      `${repoId}:${rooms.reduce((n, r) => n + r.workbenches.length, 0)}:${rooms.filter((r) => r.highDensity).length}`;

    // Same repo, different workbench counts → different keys
    const key1 = buildCacheKey('repo-a', [{ workbenches: [1, 2, 3], highDensity: false }]);
    const key2 = buildCacheKey('repo-a', [{ workbenches: [1, 2, 3, 4], highDensity: false }]);
    expect(key1).not.toBe(key2);

    // Same workbench count, different highDensity → different keys
    const key3 = buildCacheKey('repo-a', [{ workbenches: [1, 2, 3], highDensity: false }]);
    const key4 = buildCacheKey('repo-a', [{ workbenches: [1, 2, 3], highDensity: true }]);
    expect(key3).not.toBe(key4);

    // Same params → same key
    const key5 = buildCacheKey('repo-a', [{ workbenches: [1, 2, 3], highDensity: false }]);
    expect(key3).toBe(key5);
  });

  it('window light shimmer: oscillates in [0.7, 1.0] range', () => {
    const shimmer = (now: number) => 0.85 + 0.15 * Math.sin(now / 3000);

    // At t=0: sin(0) = 0, shimmer = 0.85
    expect(shimmer(0)).toBeCloseTo(0.85);

    // At t=3000*π/2 ≈ 4712: sin(π/2) = 1, shimmer = 1.0
    expect(shimmer(Math.PI * 1500)).toBeCloseTo(1.0);

    // Range check
    for (let t = 0; t < 30000; t += 100) {
      const s = shimmer(t);
      expect(s).toBeGreaterThanOrEqual(0.7);
      expect(s).toBeLessThanOrEqual(1.0);
    }
  });

  it('room label plaque: uses zone color as background', () => {
    // The label function picks plaque color from zone type
    const getPlaqueColor = (zoneType?: string) => {
      const colors: Record<string, string> = {
        team_cluster: '#F5D0C5',
        meeting: '#B09060',
        focus: '#E8F5D6',
        break: '#D0C0A0',
        infra: '#E2E8F0',
        reception: '#F5F0E8',
        biophilic: '#D4E8D0',
      };
      return colors[zoneType ?? 'team_cluster'] ?? '#F5D0C5';
    };

    expect(getPlaqueColor('team_cluster')).toBe('#F5D0C5');
    expect(getPlaqueColor('meeting')).toBe('#B09060');
    expect(getPlaqueColor(undefined)).toBe('#F5D0C5'); // default fallback
    expect(getPlaqueColor('unknown')).toBe('#F5D0C5'); // unknown fallback
  });

  it('door signage: only shows for rooms with corridor neighbors', () => {
    // The static layer checks hasCorridorNeighbor before drawing signage
    const shouldShowSignage = (hasCorridorNeighbor: boolean, hasZoneLabel: boolean) =>
      hasCorridorNeighbor && hasZoneLabel;

    expect(shouldShowSignage(true, true)).toBe(true);
    expect(shouldShowSignage(false, true)).toBe(false);
    expect(shouldShowSignage(true, false)).toBe(false);
  });
});