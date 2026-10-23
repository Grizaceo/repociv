# Local geometry repairs — candidate v003

Scope: coordination-court, artifact-vault and research-laboratory only. Authorized by Cristóbal: «vamos con los arreglos finales para poder dar por aprobada la familia completa».

Status: repair-v003 geometry APPROVED by Cristóbal: «ahora doy por aprobados todos». This accepts the three repaired candidates presented in the preceding review. No new paid requests, materials, map integration, publication, commits or push. Plaza/Portal remain approved and untouched. Taller remains explicitly deferred and outside this repair batch; this does not certify the eight-member family as production-ready. Distribution remains blocked by unverified licensing.

## What changed

The v001 boundary-only repair was insufficient: adversarial comparison found the original black wedges unchanged in Patio and Bóveda. Do not promote it. v002 added crease-aware normals as an intermediate diagnostic. v003 is the current review candidate; prior candidates and paid originals remain in place.

Raycasting the original black regions in the real Three.js viewer found triangles whose three vertex normals were zero. Flat-shading diagnostics removed the black wedges even with the original shadows enabled. Summing normals at vertices shared by opposite-facing surfaces can cancel them; closing edges alone cannot fix that.

v003 splits normal discontinuities at a 42-degree crease threshold, preserving the coordinates of triangle corners and smooth curved portions. Every output normal is finite and unit-length, and every nondegenerate face has positive face/corner alignment above the crease cosine threshold. This is geometry-normal repair, not a double-sided material, texture cover-up, or a production flat-shading workaround.

| Asset | Original triangles | v003 triangles | Repair |
| --- | ---: | ---: | --- |
| Patio | 3376 | 3684 | Boundary closures and crease-aware normals; open courtyard and intentional architectural passages retained in five-view inspection. |
| Bóveda | 3879 | 4004 | Boundary closures and crease-aware normals; four folded support-closure triangles replaced by two planar bottom/back triangles. Ceremonial silhouette retained. |
| Laboratorio | 4034 | 4218 | Irregular wall/base openings closed and crease-aware normals; pavilions and instrument chamber retained. |
| Taller (`execution-workshop`) | 3735 | 3624 | Missing window-band wall patches reconstructed, 20 malformed window mullion components and 3 duplicate 2-face zero-normal wafers replaced with 8 framed recessed window panels, central rear roof/wall closed, and 42° crease-aware normals applied using only existing source vertex coordinates (candidate built 2026-10-23, pending human review). |

The Bóveda source edit is explicitly guarded by the original SHA-256 and exact source face indices 3667–3670. The replacement uses existing vertices only. The bottom plane has source quantization tolerance 0.0005, the back plane is coplanar, and source outer bounds are unchanged. This addresses an actual folded support closure rather than inferring platform quality from the straight outside edge alone. It is not a general reconstruction of the whole platform; the user must still inspect the repaired support/platform area.

## Verified evidence and limits

- 83 offline unit tests passed, including opposite-face normal cancellation, degenerate source faces, source-guarded support replacement and approved/deferred asset write rejection.
- Read-only audit passed on all three real exported GLBs: source/output hash checks, unchanged bounds, all output positions from original points, unit normals and correct original triangle coordinates except the explicitly recorded Bóveda replacement.
- Real GLTFLoader/Chromium loading and five fixed views passed for original and candidate. Missing-asset negative control also passed.
- Pixel regression: zero pixels with max(R,G,B) < 30 in the model canvas in all 15 candidate views. This measured disappearance of the previous pure-black wedges; it is not a mathematical proof of artistic quality or of every possible occlusion.
- Original and v003 contact sheets inspected side by side. The prior pure-black wedges are absent; repaired surfaces remain visible under the same clay material and lighting. Open courtyard, entrances and distinctive roof/camera forms remain recognizable.
- Source quantization includes 1/6/24 zero-area triangles respectively (Patio/Bóveda/Laboratorio, measured by the GLB audit). They remain explicitly disclosed; their lighting normals are valid. No broad manifold, self-intersection, UV, PBR or runtime certification is claimed. Indexed seams introduced by normal splitting are not physical holes, so boundary closure is recorded before that split.

## Reproduce locally

From the worktree, with its existing Python dependencies and Vite on 127.0.0.1:5283:

    python scripts/meshy/repair_family_geometry.py coordination-court
    python scripts/meshy/repair_family_geometry.py artifact-vault
    python scripts/meshy/repair_family_geometry.py research-laboratory
    python scripts/meshy/audit_family_repairs.py
    node scripts/meshy/verify-family-repairs.mjs
    python scripts/meshy/render_family_repair_comparisons.py
    python -m unittest discover -s scripts/meshy -p 'test_*.py'

Repair scripts are local-only and deterministic; do not rerun any paid generation runner for this review.

## Review surfaces

Gallery: http://127.0.0.1:5283/scripts/meshy/family-review.html

Each of the three cards opens its v003 candidate. The 3D viewer offers an explicit link back to the original. Five-view contact sheets and full original/repair screenshots are stored durably under:

    assets-src/meshy/<asset>/repair-v003/review/

These generated local images are ignored by Git; geometry-audit.json and source receipts remain traceable. Approved candidate paths, SHA-256 values and Cristóbal's exact approval quote are recorded in each asset's spec.json.

## Human decision

Cristóbal: «ahora doy por aprobados todos». Accepted geometry: coordination-court, artifact-vault and research-laboratory, each at repair-v003/preview.glb. This supersedes their prior pending geometry review, not their historical defect observations. Their approved hashes are pinned in spec.json; do not overwrite accepted candidates during later repair experiments.

The current geometry review batch is closed. Next gate: materials under separate authorization/approval, followed by runtime integration and licensing checks. This approval does not itself execute or authorize paid regeneration, publishing or deployment. Taller's previously deferred repair is not implicitly performed or certified by this decision.

## Next gate executed

Materials for the five approved geometries were textured on 2026-10-23 from these exact repair-v003 files, verified by pinned SHA-256. See [visual-family-materials-review.md](visual-family-materials-review.md). The accepted v003 GLBs were not overwritten.
