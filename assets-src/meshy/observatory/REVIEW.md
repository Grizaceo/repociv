# Observatory concept review

Cristóbal explicitly approved one Nano Banana Pro Image-to-Image concept at 9 credits. The successful Archive textured PNG was the actual reference; no Workshop repair or paid 3D generation was performed.

- Task read back: `01a165ed-d906-7099-bd79-6b08b87b95b8`
- SUCCEEDED, progress 100, consumed_credits 9
- Balance 1071 → 1062; delta 9 reconciled
- Image: `preview.png`, locally ignored; state/lock ignored separately
- Review page: `/scripts/meshy/family-review.html`

## Actual visual inspection

The image shows a narrow pale-stone central tower on a stepped base with a front stair/porch, broad dark-slate eaves, copper trim, and an upper barrel-roof optical housing with a large circular turquoise lens. The lens reads as a fixed instrument rather than a lantern. Two narrow rectangular framed panels on the tower and a broader lower side panel are simple, not ragged perforations. Terrace borders are substantial stone parapets, without thin metal railings. It retains the Archive palette but has a more vertical and instrument-led silhouette.

Reconstruction risks remain: terrace channels, porch posts, recessed panel borders, stair edges and the circular lens/rim may be distorted by Image-to-3D. A clean concept does NOT guarantee clean windows or a closed roof in the mesh. Review all sides before subsequent texturing. The upper lens should remain connected and thick, not a detached decorative disk.

## Approved concept and generated untextured geometry

Cristóbal approved the concept and one 5-credit Meshy T2.5 geometry-only task. Actual source `input_task_id` was the approved Observatory image task, not the Workshop.

- Geometry task read back: `01a165f2-17f0-76cc-83ab-4fc6d267e41e`, SUCCEEDED, 100%, consumed_credits 5
- Balance 1062 → 1057; delta 5 reconciled
- Local `geometry/preview.glb`: 73212 bytes, 3868 triangles, 1 mesh, 0 authored materials
- SHA-256 `c5c76901fe3ade52c1ec15ae82f01a7c8bd1df500adc09f147d1d0a455d42aa8`
- Viewer `/scripts/meshy/observatory-preview.html` uses clay, not generated materials; missing NORMAL generated only in runtime, no source mesh modification
- Browser verification: real GLB ready, exact count, finite nonzero normals, no page errors, all five review views captured, missing-GLB negative control displays failure. Browser report/screenshots under `$TMPDIR/repociv-meshy/observatory/`.

Isometric and rear screenshots retain a substantial connected lens housing, tower and rear curved roof. Visible window panels remain framed rectangular recesses, without the Workshop's conspicuous ragged openings. Lens rim has minor unevenness and dark recesses remain around the terrace/tower junction; review these interactively. Do not certify watertightness or perfect topology from screenshots. This is local asset QA, not map integration.

## Geometry approved; PBR candidate generated

Cristóbal approved the geometry and 10-credit texturing. An initial mistaken `/v2/text-to-3d` refine POST returned HTTP 400 without a task ID; subsequent balance read remained 1057. Its local submission marker was preserved. Corrected to documented `/v1/retexture`, using the approved Image-to-3D task as `input_task_id`, explicit `meshy-7`, 2K PBR, prompt 683 characters, GLB only. Source had POSITION only, no UVs: `enable_original_uv: false`. Separate exclusive retexture marker prevents duplicate paid submission.

- Texture task read back: `01a1670c-4e1a-7760-986f-ec898f301de0`, SUCCEEDED, consumed_credits 10
- Balance 1057 → 1047, delta 10 reconciled
- Local ignored `textured/preview.glb`: 7130964 bytes, 3866 triangles, 1 mesh/material
- SHA-256 `c94d0a42e69b2a7e0ab68df64b0dd6e7da026fe126f0cf06748a29c130a19317`
- Source was 3868 triangles, output 3866; output bounding height is 2m versus source approximately 0.953m. Do NOT claim byte-identical geometry, unchanged scale or exact preservation. Neither source nor returned mesh was locally repaired.
- Viewer `/scripts/meshy/observatory-textured-preview.html` preserves returned PBR materials; real browser verifies all four texture slots, normals, counts, five views, no page errors, and missing-GLB failure message. Evidence `$TMPDIR/repociv-meshy/observatory-textured/`.

Actual screenshots show warm pale masonry, dark slate eaves, reddish copper instrument framing and turquoise lens/windows. Turquoise also spills onto the curved upper roof, contrary to the prompt. Rear wall has dotted seam/diagonal texture artifacts; window bars and fine masonry details are not uniformly crisp. Candidate needs artistic review, not an automatic retry. No optimization or map integration has occurred. Workshop repair remains deferred. Distribution blocked pending license review; no publication/push/merge.

## Decision: PBR appearance approved by Cristóbal

Cristóbal explicitly approved the textured Observatory after the roof turquoise and rear texture seams were disclosed. Geometry and PBR appearance are artist-approved as delivered; retain the current candidate without regeneration or texture retries. The observations above remain documented, not blocking artistic approval. This approval does not establish runtime acceptance, optimization, license clearance, distribution or map integration, and does not authorize paid calls. Workshop repair remains deferred.

## Local runtime trial (2026-10-23)

Approved materials reused; no new paid request. A 512 px runtime copy `textured/observatory-map.glb` (394,828 bytes, geometry bytes identical to the approved GLB) is integrated into RepoCiv (`public/assets/3d/props/meshy/observatory-map.glb`) for `prometheus`/`grafana` wonder ids, enabled by default. Tested in the real map in dev and in a locally served build; see `docs/design/visual-family-materials-review.md`. Mapping and scale approved by Cristóbal.

Observation, not a change: compared with its approved geometry, the returned GLB omits 2 small visible triangles and carries 274 corners whose normal opposes its face. The approved file is kept untouched; the clay diagnostic renders show no black wedges at the five review cameras. Distribution remains blocked pending license clearance.
