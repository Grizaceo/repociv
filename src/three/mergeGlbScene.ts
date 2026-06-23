// ─── Multi-mesh GLB → single instanceable geometry ──────────────────────────
// Forge props (city-capital, forest-pine, …) ship as several indexed meshes
// per GLB — one node per part, sharing 2-3 materials. InstancedMesh needs ONE
// geometry, so this bakes every node's world transform into its geometry,
// buckets parts by material, and merges everything into a single geometry
// whose groups map 1:1 onto the returned materials array (one draw call per
// material). Taking only the first mesh — the bug this replaces — renders a
// bare cube/cylinder instead of the modeled prop.
import { BufferGeometry, Group, Material, Mesh } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type MergedGlb = { geometry: BufferGeometry; materials: Material[] };

export function mergeGlbScene(scene: Group, maxMeshes = Infinity): MergedGlb {
  scene.updateMatrixWorld(true);

  const buckets = new Map<Material, BufferGeometry[]>();
  let taken = 0;
  scene.traverse((obj) => {
    if (taken >= maxMeshes) return;
    const mesh = obj as Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    const geom = mesh.geometry.clone();
    geom.applyMatrix4(mesh.matrixWorld);
    const mat = mesh.material as Material;
    const bucket = buckets.get(mat);
    if (bucket) bucket.push(geom);
    else buckets.set(mat, [geom]);
    taken++;
  });
  if (buckets.size === 0) throw new Error('GLB without meshes');

  const materials: Material[] = [];
  const perMaterial: BufferGeometry[] = [];
  for (const [mat, geoms] of buckets) {
    const merged = geoms.length === 1 ? geoms[0]! : mergeGeometries(geoms, false);
    if (!merged) throw new Error('GLB material bucket merge failed');
    materials.push(mat);
    perMaterial.push(merged);
  }

  let geometry: BufferGeometry | null;
  if (perMaterial.length === 1) {
    geometry = perMaterial[0]!;
    const count = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
    geometry.addGroup(0, count, 0);
  } else {
    geometry = mergeGeometries(perMaterial, true);
  }
  if (!geometry) throw new Error('GLB merge failed');
  return { geometry, materials };
}
