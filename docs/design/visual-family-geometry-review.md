# RepoCiv — family geometry review

Current local repair candidates and verification: [v003 repair review](visual-family-local-repairs-review.md). Original findings and prior human decisions are retained below as historical evidence.

## Gate and scope

Cristóbal approved all five concepts and then authorized the proposed untextured geometry stage and technical correction of Plaza ("vamos con ello"). This is NOT approval of the resulting meshes. No textures, runtime integration, publication or Workshop repair were performed in this stage. Licensing remains unverified; distribution blocked.

## Delivered local candidates

All five Image-to-3D tasks succeeded. Each has preserved generation state, exclusive creation lock, local GLB and audit under `assets-src/meshy/<asset>/geometry/`.

| Asset | Triangles | Review recommendation |
| --- | ---: | --- |
| coordination-court | 3376 | Hold: multiple dark discontinuities beneath eaves, visible from sides and rear. Do not conceal with texture. |
| connection-gateway | 3115 | Geometry APPROVED by Cristóbal as production-ready; materials and runtime verification remain separate. |
| artifact-vault | 3879 | Hold: platform wedge/deformation AND black triangular defect at entrance, confirmed in Cristóbal's screenshot. |
| research-laboratory | 4034 | Hold: irregular openings and wall/roof junctions at projecting wing; narrow roof strip and pavilion transitions need close review. |
| civic-plaza | 3926 | Geometry APPROVED by Cristóbal as ready; corrected paving, stairs, curved benches, table and beacon preserved. |

Visual holds above describe the original generated meshes, before the local repair stage recorded below. Dark triangles and seams can include normal/shading defects; inspection alone cannot establish their cause. No local repair or paid regeneration had been attempted at this original checkpoint.

## Plaza source provenance

The defective original remains at `assets-src/meshy/civic-plaza/preview.png`. It was NOT the 3D input. Technical correction is preserved separately at `image-correction/preview.png`; its Image-to-Image task is `01a16734-64bb-75ab-9c44-0dd077f2e2cc`. Plaza geometry uses this corrected task via `scripts/meshy/plaza_geometry.py`.

## Real browser verification

`scripts/meshy/verify-family-geometry.mjs` loads each local GLB with Three.js GLTFLoader, compares mesh/triangle counts to the geometry audit, asserts no textures and valid normals, and captures isometric, front, rear, left and right views. All five passed; browser page-error list was empty. The deliberately aborted Plaza GLB correctly displayed the failure message rather than reporting readiness.

The source GLBs lack normals; the preview computes them on load and checks finite nonzero results. This does not modify original assets or certify runtime integration.

Gallery: `http://127.0.0.1:5283/scripts/meshy/family-review.html`.
Interactive viewer: `http://127.0.0.1:5283/scripts/meshy/family-geometry-preview.html` (asset selector, orbit, wireframe and five camera presets).
Screenshots and browser report: `/home/gris96/.hermes/cache/scratch/repociv-meshy/family-geometry/` (scratch is temporary, regenerable with the verifier).

## Billing provenance

Five meshes cost 5 credits each; the technical image correction cost 9. This stage totals 34 credits. Its receipts start at 712 and end at 678. The earlier concept-stage receipt ended at 1002; intervening account activity is not attributed to this batch. These are historical receipt balances, not a live account balance.

## Next gate

Cristóbal reviewed the candidates and explicitly approved Plaza ("la plaza la apruebo esta ready") and Portal ("portal se aprueba tambien production ready"). Their existing geometry is accepted; do not regenerate or repair those approved meshes. This does not certify unseen materials, licensing, performance or runtime installation.

Laboratorio, Bóveda and Patio remain unapproved, with local repair needed. User screenshots corroborate the laboratory's open/warped wall-base junction; Bóveda's black entrance triangle as a second issue beyond its platform deformation; and Patio's black wedges under eaves and on the courtyard-facing wall. Diagnose shading/normals versus missing or malformed faces before choosing a repair. Work on separate candidates, preserve originals, and do not use textures or double-sided rendering alone to claim geometry repair. No new paid generation is authorized by this review record.
