# Execution Workshop review

## Approved concept

Cristóbal approved Nano Banana Pro at 9 credits explicitly through the model/cost selector. One paid image-to-image request used the existing textured Archive PNG as the real reference. Cristóbal subsequently approved the Workshop concept and proceeding to the proposed 5-credit geometry step.

- Concept task: `01a165c7-ddb4-7453-8364-c1edc5eba490`
- Concept state: SUCCEEDED, consumed_credits 9
- Concept balance: 1085 → 1076, reconciled
- Local image: `preview.png` (ignored)
- Comparison: `/scripts/meshy/family-review.html`

The image has two broad gabled roofs, a large recessed loading arch, open doors, pale masonry, slate tiles, brown/copper-colored framing and a short rear stack. The brown framing reads as timber as much as metal; the user approved this differentiation. The concept is not proof of back surfaces, topology or PBR materials.

## Untextured geometry

One Image-to-3D request, directly referencing the successful concept task with `input_task_id`; no re-upload or regeneration of the concept. Explicit Meshy T2.5 Smart Topology, 4000 target triangles, should_texture=false, enable_pbr=false, GLB only. Exclusive submission marker retained locally; no automatic POST retry.

- Geometry task: `01a165e0-7aca-741b-bf25-769ef4fa5a66`
- State read back: SUCCEEDED, 100%, consumed_credits 5
- Geometry balance: 1076 → 1071, delta 5 reconciled
- File: `geometry/preview.glb` (ignored), 71940 bytes
- SHA-256: `6ca232dbf5bccc6318532e3a8d52de56873e69e2966011ffa83b4f6bb6759426`
- Actual: 3735 triangles, 1 mesh, 0 authored materials
- Thumbnail plus four side thumbnails downloaded under `geometry/preview.*.png`
- Viewer: `/scripts/meshy/workshop-preview.html`

The original GLB has POSITION but no NORMAL vertex attribute. Replacing its default display material with a lit standard material initially produced a black silhouette. The viewer now derives missing vertex normals in memory before assigning clay material. This does not alter the saved GLB, vertices or triangle count. Derived smoothing is only a preview decision, not a topology repair.

## Visual and browser evidence

Real Chromium/WebGL import: ready, 3735 triangles, 1 mesh, no page errors. Six review views exercised (isometric, four sides, dragged orbit); missing-GLB error message verified separately. Runtime normals are checked for presence and finite, nonzero values. The local family comparison loads both concept images and links to the new viewer. This is asset-viewer QA, not map integration.

The mesh retains the low twin-wing massing, open entrance doors and rear stack. Actual isometric and rear screenshots show imperfect reconstruction: irregular window openings, and an open-looking separation/slot in the central roof area. Do not certify a closed roof, watertight mesh or faithful back reconstruction. No paid retry, texturing or automatic repair has been submitted. User geometry review remains pending.

Screenshots and browser report: `$TMPDIR/repociv-meshy/workshop/`. Seven offline geometry runner scope/anti-double-spend tests passed before POST. The initial missing-normal display was detected by inspecting real screenshots rather than accepting a successful load as visual success.

## Local repair candidate (`repair-v003`)

Authorized by Cristóbal («abordemos ahora la reparación local de la geometría de execution-workshop»). Executed deterministically via `python3 scripts/meshy/repair_family_geometry.py execution-workshop` on a copy under `repair-v003/`, leaving `geometry/preview.glb` byte-identical.

- Source SHA-256: `6ca232dbf5bccc6318532e3a8d52de56873e69e2966011ffa83b4f6bb6759426` (3735 triangles, 2200 vertices, 163 connected components)
- Output file: `repair-v003/preview.glb` (ignored), 189984 bytes
- Output SHA-256: `998993daec5408371d0564ad59c74015efdbdbdc9fd288da6b354fcb2ec72b86`
- Triangles: 3624 (364 malformed window-mullion and 3 zero-normal duplicate wafer triangles removed; 13 boundary-loop triangles added on `comp 4` and `comp 161`; 240 triangles added across 20 closed hexahedra using exclusively existing 3D coordinates from `source_vertices`)
- Open boundary edges before normal split: 0 (100% manifold edge pairs)
- Normals: 42-degree crease split (`min_face_corner_normal_alignment = 0.7615 >= cos(42°)`)
- Pixel regression across all 5 views (`iso`, `front`, `back`, `right`, `left`): 0 pixels with `max(R,G,B) < 30`
- Viewer: `/scripts/meshy/workshop-preview.html?variant=repair` and `/scripts/meshy/family-geometry-preview.html?asset=execution-workshop&variant=repair`

## Next gate

Human visual review of `repair-v003/preview.glb` (especially the reconstructed wall bands, the 8 framed recessed window panels, and the closed central rear roof/wall) before any paid PBR retexture request.

All candidates remain local/ignored and outside public/; license clearance remains pending. No push, merge or deployment.
