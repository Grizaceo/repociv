import { afterEach, describe, expect, it } from 'vitest';
import {
  noteTerrainMeshSignature,
  resetTerrainRevision,
  terrainRevision,
} from './terrainRevision.ts';

afterEach(() => resetTerrainRevision());

describe('terrainRevision', () => {
  it('does not move when the terrain mesh signature repeats', () => {
    noteTerrainMeshSignature('1:0,0=plains');
    const before = terrainRevision();

    expect(noteTerrainMeshSignature('1:0,0=plains')).toBe(false);
    expect(terrainRevision()).toBe(before);
  });

  it('moves when the terrain mesh signature changes', () => {
    const before = terrainRevision();

    expect(noteTerrainMeshSignature('1:0,0=plains')).toBe(true);
    expect(terrainRevision()).toBe(before + 1);
    expect(noteTerrainMeshSignature('1:0,0=mountain')).toBe(true);
    expect(terrainRevision()).toBe(before + 2);
  });

  it('goes back to 0 on reset, and the forgotten signature counts as new', () => {
    noteTerrainMeshSignature('1:0,0=plains');
    expect(terrainRevision()).toBe(1);

    resetTerrainRevision();
    expect(terrainRevision()).toBe(0);
    expect(noteTerrainMeshSignature('1:0,0=plains')).toBe(true);
  });
});
