# Family materials and local runtime trial — texture-v001

Scope: Patio (coordination-court), Portal (connection-gateway), Bóveda (artifact-vault), Laboratorio (research-laboratory), Plaza (civic-plaza) and Taller (execution-workshop), using their approved geometry exactly. Archivo and Observatorio are preserved and reused, with no new paid request.

Authorization, Cristóbal: «Apruebo las geometrías presentadas y autorizo continuar con la texturización de los cinco edificios nuevos y su integración local en RepoCiv. Priorizo belleza, coherencia y acabado; no impongas el antiguo tope de créditos, pero registra el gasto y evita solicitudes duplicadas.» Followed by Taller geometry approval («apruebo los modelos»), 10-credit retexture authorization, and material approval («sip los apruebo»).

**Status: PBR materials, service mapping and map scale APPROVED by Cristóbal across all eight members («apruebo la totalidad materiales, el mapeo de servicios y la escala trabajemos en integrarlo en repociv» + «sip los apruebo» for Taller).** Seven mapped members integrated by default into RepoCiv runtime (`public/assets/3d/props/meshy/<id>-map.glb`).

## Route: the exact accepted GLB, never the old task

- The Image-to-3D tasks of Patio, Bóveda and Laboratorio hold the rejected original geometry, so `input_task_id` would have textured the wrong mesh. Every member therefore sent its accepted file as a `model_url` data URI (`POST /openapi/v1/retexture`), after checking the pinned SHA-256 from `spec.json`.
- Local UVs (xatlas-python 0.0.11, 2048 px atlas, 6 px padding, charts on welded positions) were attached without moving a corner. Positions and triangle order were compared per corner with the accepted GLB (`uv-audit.json`). Blender Smart UV Project was tried first and discarded: 22–32 % coverage against xatlas 48–59 % (Meshy's own layout covers about 50 %).
- Normals: Patio, Bóveda and Laboratorio keep their accepted repair-v003 normals. Portal and Plaza had none; they get the same 42-degree crease rule (`repair_family_geometry.crease_normals`), without moving corners.
- Meshy's returned normals are never used. In all five outputs Meshy welded the shading splits and returned corners whose normal opposes its face (110–484 per asset). The approved Observatory has the same defect (274 corners) plus 2 small dropped triangles. That is the black-wedge signature the v003 repair removed.
- Meshy honoured `enable_original_uv: true` only for Plaza; it re-unwrapped the other four. The assembler handles both cases: `textured.glb` = accepted corners + prepared normals + Meshy's per-corner UVs and PBR material (`geometry-check.json`).

Request, identical apart from the prompt: `ai_model: meshy-7`, `enable_pbr: true`, `texture_resolution: 2k`, `target_formats: [glb]`, `alpha_thumbnail: true`, `enable_original_uv: true`. Prompts (723–786 characters) carry the shared language: warm limestone, dark slate, aged copper, amber activity, restrained turquoise, broad hand-crafted regions, no text, logos, grime or baked lighting. 2K matches the approved Observatory; at the time of the request 4K had the same price (10).

## Receipts

Pricing read on 2026-10-23 from https://docs.meshy.ai/en/api/pricing: Retexture 2K/4K 10 credits, 8K 15.

| Asset | Task | Status | Credits | Balance |
| --- | --- | --- | ---: | --- |
| coordination-court | 01a167cc-e715-7681-b24c-6fee669f77b0 | SUCCEEDED | 10 | 552 → 542 |
| connection-gateway | 01a167ce-3f4e-7660-a5b9-a0e05a3ed50e | SUCCEEDED | 10 | 542 → 532 |
| artifact-vault | 01a167cf-0468-70be-924c-b04b5efac581 | SUCCEEDED | 10 | 532 → 522 |
| research-laboratory | 01a167cf-ca24-74a6-81fc-da458df81196 | SUCCEEDED | 10 | 522 → 512 |
| civic-plaza | 01a167d0-8b39-74df-b163-bb9eac09c010 | SUCCEEDED | 10 | 512 → 502 |
| execution-workshop | 01a16b22-3f76-72a3-a4d4-536529268d8e | SUCCEEDED | 10 | 502 → 492 |

Aggregated from the five `generation.json` receipts: 5 tasks, 50 credits, every balance delta equals the task's `consumed_credits`. The live balance read before the batch was 570. The 18-credit difference to the first receipt (552) is other account activity, not this batch. The account lists exactly six retexture tasks: the Observatory's and these five. No duplicates, retries or variants were submitted. One exclusive submission lock per asset was kept, and resumption is GET-only.

## Geometry preservation

| Asset | Accepted tris | Meshy tris | Visible missing | Meshy opposing-normal corners | Candidate |
| --- | ---: | ---: | ---: | ---: | --- |
| Patio | 3684 | 3676 | 0 | 484 | exact, 0 opposing |
| Portal | 3115 | 3112 | 0 | 118 | exact, 0 opposing |
| Bóveda | 4004 | 4002 | 0 | 184 | exact, 0 opposing |
| Laboratorio | 4218 | 4211 | 0 | 356 | exact, 0 opposing |
| Plaza | 3926 | 3924 | 0 | 110 | exact, 0 opposing |

Meshy rescaled uniformly (×2.097–2.109 about the bounds centre). Every returned corner snaps to an accepted position within 5e-8. The triangles it dropped are zero-area or coincident twins. "Exact" means that every corner position and triangle of the accepted GLB is identical in the candidate. It is not a manifold or self-intersection certification. The source zero-area quantization triangles recorded in the repairs review are still present.

## Visual verification

`node scripts/meshy/verify-family-textured.mjs` uses the real GLTFLoader in Chromium with map lights and ACES 1.22 tone mapping, and the renderer's footprint rule (diagonal ≤ 0.5 hex, height ≤ 0.62 hex). It ran on all seven members, Archivo and Observatorio included. Every member passed:

- Triangle counts equal `geometry-check.json`; 1 mesh, 1 material.
- Base colour, metallic/roughness and normal maps present; base colour in sRGB; models grounded at y = 0.
- Six lit views, five single-sided views (holes would show through), five clay views with their own normals, and unlit albedo.
- Clay black-wedge regression: 0 pixels with max(R,G,B) < 30 in all 35 clay views. This measures the old artifact signature, not artistic quality.
- An aborted candidate surfaces as a visible failure, never as ready. No unexpected page errors.

Contact sheets and renders: `assets-src/meshy/family-texture-review-v001/` (local, ignored). Interactive viewer: `/scripts/meshy/family-textured-preview.html?asset=lineup` with PBR, single-sided, albedo and clay modes. Gallery: `/scripts/meshy/family-review.html`.

Observations for the review. These are not vetoes and no retry was bought:

- Patio: limestone, slate and copper eave edges as briefed; the courtyard stays pale. Window panels read as dark recesses and the arched door is brown; the tiny amber light is barely visible.
- Portal: turquoise lintel strip present, but turquoise also spills onto the roof ridge and the pylon panels.
- Bóveda: ceremonial silhouette kept and no turquoise. Very dark copper doors; the amber accent is not distinguishable.
- Laboratorio: copper chamber with legible amber. The pavilion windows are turquoise, more than the requested tiny insets.
- Plaza: pale paving and a copper/amber lantern. The table centre and the inner faces of the benches are dark slate.
- Family: one palette and craft across all seven. The Archivo's walls read whiter and cooler than the new members. All Meshy materials are `doubleSided` as delivered; holes were checked single-sided.

## Local runtime trial

Consumers inspected: `WonderProps3D.ts`, which assigns Kenney models by wonder-id keyword bucket, and the former `MemoryArchive3D.ts`. `CityProps3D.ts` and `UnitProps3D.ts` were not touched. No global tint exists on wonder materials; only the sun colour breathes.

- `MemoryArchive3D.ts` was generalized as `FamilyBuildings3D.ts`, and `familyBuildingAssets.ts` is the allowlist. Normalization, grounding, disposable clones and shared textures are unchanged. One load per building, each with an independent fallback to the ordinary wonder.
- Mapping proposal, derived only from buckets that already exist in `wonderModelForType`:
  - memory/archive/knowledge/bibliotheca/wiki → Archivo.
  - prometheus/grafana → Observatorio.
  - lab → Laboratorio.
  - mine bucket (db, storage, ledger…) → Bóveda.
  - watermill bucket (pipeline, workflow, queue…) → Patio.
  - default/port bucket (any other connected service, e.g. GhostDesk) → Portal.
  - Execution (smelter / docker / ci / gpu-worker) → Taller. AI (wizard tower: ollama, claude, …) keeps Kenney.
  - Plaza maps to the well overlay in `CityProps3D` (`building_well_red`), not to a wonder service.

  **Mapping and scale approved by Cristóbal.** Taller materials were approved later («sip los apruebo») and the building is in the default runtime.
- Runtime integration: the six optimized runtime copies live in `public/assets/3d/props/meshy/<id>-map.glb` and are enabled by default (`VITE_MESHY_PREVIEW=0` forces Kenney fallback). `vite-plugins/meshyLocalAssets.ts` attaches a content-hash ETag with `Cache-Control: no-cache` on dev/preview servers so a regenerated GLB is never served stale.
- Runtime copies: 512 px JPEG maps through `optimize_glb.py`, geometry bytes identical to the candidates, 94–95 % smaller. Sizes: 308–484 KB each, 2.34 MB for all six. Estimated GPU texture memory is about 4 MB per building on screen (3 × 512² RGBA with mipmaps). Each building is 1 mesh, 1 material and 1 draw call, plus its shadow pass. Triangles per wonder are 3115–4218, against 183–554 for Kenney.
- Real map (`scripts/meshy/verify-family-map.mjs`, fixture repos and wonders by page routing, no bridge):
  - Dev and locally served flagged build: 6 family buildings for 8 wonders. ollama and docker keep Kenney. No tint (material colour ffffff), 1 draw call each, base at the terrain probe plus the existing 0.78 clearance (no burial), cache headers present, no page errors.
  - Aborting the Bóveda GLB falls back to the Kenney mine while the other five stay.
  - Default distributable build: 0 family GLB requests, every wonder on its previous model, and 0 `assets-src` strings in the bundle.
  - Captures: `family-texture-review-v001/map-dev`, `map-build`, `map-default`.
- Legibility: each silhouette reads at the default zoom. With the 0.5-hex footprint rule the family buildings are smaller than the Kenney wonders (heights 7–26 against 12–29 map units). Any scale change is a separate decision; none was made.
- Debug probe `__repocivDebug.getWonderProps()` (read-only) reports what each wonder tile actually renders.

## Licensing

The code is MIT (`LICENSE`); that does not cover the Meshy assets. Kenney and KayKit ship their own license files. Meshy Terms of Service, last updated 2026-09-19 (read 2026-10-23):

- Paid-plan customers own their Customer Output "to the extent possible under applicable law". Free-plan output is Meshy's, under CC BY 4.0.
- Meshy keeps a license to User Content and may train on non-Enterprise inputs and outputs.
- AI-generated identifiers must not be removed (§2.4). Meshy does not guarantee uniqueness.
- API outputs are deleted on Meshy's side after 3 days.

The returned GLBs carry no structural AI identifier: `asset.generator` is pygltflib, and the JPEGs have no XMP, C2PA or EXIF. `textured.glb` keeps Meshy's image bytes verbatim; the runtime copies resample them, as the approved Archive copy already did.

Still unverified: the plan tier at generation time, whether AI output is copyrightable or redistributable under a public repository's license, and the terms of the upstream concept-image models. **Distribution stays blocked**. This is a local trial, not a distributable integration.

## Reproduce

    uv run --python 3.12 --with xatlas --with numpy --with pillow python scripts/meshy/family_texture.py <asset> prepare
    python3 scripts/meshy/family_texture.py <asset> run          # GET-only resume; --generate permits ONE POST
    python3 scripts/meshy/family_texture.py <asset> assemble
    python3 scripts/meshy/optimize_glb.py --input …/texture-v001/textured.glb --output …/texture-v001/<asset>-map.glb --report …-map.report.json --max-size 512
    node scripts/meshy/verify-family-textured.mjs assets-src/meshy/family-texture-review-v001
    python3 scripts/meshy/family_contact_sheets.py assets-src/meshy/family-texture-review-v001
    npx vite --port 5284 --host 127.0.0.1   # VITE_MESHY_PREVIEW=0 forces Kenney

Do not rerun `run --generate`: each asset holds its submission lock and saved task.

## Reversion

Default builds load the family from `public/assets/3d/props/meshy/`. `VITE_MESHY_PREVIEW=0` restores Kenney/KayKit. To drop a single member, remove it from `src/three/familyBuildingAssets.ts`. Every source stays immutable beside its derived copies: concepts, geometry, repair-v003, `source-uv.glb`, `meshy.glb`, `textured.glb` and the runtime copies.

## Pending decisions

1. License clearance before any public redistribution of the Meshy GLBs.
2. Whether to adjust family scale on the map (mapping itself is approved).
3. Ciudadela: local 0-credit follow-up applied (`repair-v004` / `texture-v004`). Awaiting a human look at the left elevation. No Meshy credits spent.
