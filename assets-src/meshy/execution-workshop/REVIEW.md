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

## Decision: repair deferred by Cristóbal

Cristóbal rejected the malformed windows and agreed with local repair of a copy: reconstruct affected wall patches, replace windows with simple framed recessed panels suitable for map scale, and close the central roof following the approved concept. He explicitly requested recording this and moving on rather than executing the repair now. Status: DEFERRED, NOT REPAIRED; original GLB preserved. No further Workshop generation or texturing until this defect review is resolved. Next family member: Observatory concept, with its own paid-call confirmation.

## Next gate

Review geometry, especially the central roof and windows, before paying for texturing. Concept approval is not geometry approval. Any repair/remesh/regeneration or texture call is a separate paid action requiring its cost to be confirmed. No Observatory generation is authorized by this step.

All candidates remain local/ignored and outside public/; license clearance remains pending. No push, merge or deployment.
