// ─── RepoCiv — Terrain revision ─────────────────────────────────────────────
//
// Layers that sit on the terrain (territory borders, city walls and props,
// labels, units, yields, paths…) cache their geometry behind a signature that
// describes world entities, not the terrain height. Painting a hex changes that
// height — and the height of anything standing on it — without changing any of
// those inputs, so those layers would keep the old Y until something else moved.
//
// Instead of adding the terrain to every signature, HexWorldScene bumps this
// counter whenever the terrain mesh signature changes, and each layer mixes
// `terrainRevision()` into its own signature. The counter only moves when the
// mesh signature changes (a brush stroke, a reload), never per frame.
//
// It lives in its own module so the layers can import it without a cycle
// through HexWorldScene.ts.

let revision = 0;
let lastSignature: string | null = null;

/** Current terrain revision. Stable until the terrain mesh signature changes. */
export function terrainRevision(): number {
  return revision;
}

/**
 * Record the terrain mesh signature. Returns true when it differs from the last
 * one, i.e. the terrain changed and the revision moved. Rebuilding the mesh with
 * the same signature (the atlas-finished path) does not bump it.
 */
export function noteTerrainMeshSignature(signature: string): boolean {
  if (signature === lastSignature) return false;
  lastSignature = signature;
  revision++;
  return true;
}

/** Forget the last signature and go back to 0 (scene disposal, tests). */
export function resetTerrainRevision(): void {
  revision = 0;
  lastSignature = null;
}
