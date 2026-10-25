// Knowledge-city family: optimized runtime copies in public/assets/3d/props/meshy/.
//
// Enabled by default; VITE_MESHY_PREVIEW=0 forces Kenney/KayKit fallbacks.
// Source meshes stay under gitignored assets-src/. Meshy license is still
// unverified — treat shipped GLBs as local-alpha, not redistributable.
// Kept free of three.js imports so the Vite config can share the allowlist.
//
// `materials` records the human review state; it is documentation, not a gate.
// All eight approved service buildings are listed, including Workshop and Plaza.

export const FAMILY_BUILDING_ASSETS = {
  'memory-archive': {
    path: 'assets/3d/props/meshy/memory-archive-map.glb',
    materials: 'approved',
  },
  observatory: {
    path: 'assets/3d/props/meshy/observatory-map.glb',
    materials: 'approved',
  },
  'coordination-court': {
    path: 'assets/3d/props/meshy/coordination-court-map.glb',
    materials: 'approved',
  },
  'connection-gateway': {
    path: 'assets/3d/props/meshy/connection-gateway-map.glb',
    materials: 'approved',
  },
  'artifact-vault': {
    path: 'assets/3d/props/meshy/artifact-vault-map.glb',
    materials: 'approved',
  },
  'research-laboratory': {
    path: 'assets/3d/props/meshy/research-laboratory-map.glb',
    materials: 'approved',
  },
  'execution-workshop': {
    path: 'assets/3d/props/meshy/execution-workshop-map.glb',
    materials: 'approved',
  },
  'civic-plaza': {
    path: 'assets/3d/props/meshy/civic-plaza-map.glb',
    materials: 'approved',
  },
} as const;

export type FamilyBuildingId = keyof typeof FAMILY_BUILDING_ASSETS;

// Literal list (not Object.keys) so a build without the opt-in flag tree-shakes
// the path table away entirely; the test suite asserts both stay in sync.
export const FAMILY_BUILDING_IDS: readonly FamilyBuildingId[] = [
  'memory-archive',
  'observatory',
  'coordination-court',
  'connection-gateway',
  'artifact-vault',
  'research-laboratory',
  'execution-workshop',
  'civic-plaza',
];

export function familyBuildingUrl(id: FamilyBuildingId): string {
  return `/${FAMILY_BUILDING_ASSETS[id].path}`;
}
