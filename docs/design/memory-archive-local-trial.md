# Memory archive: local renderer trial

The geometry and textured appearance were accepted by Cristóbal. Production distribution/license approval remains separate and unresolved. No additional Meshy requests are required for this stage.

## Local optimization

Run `python3 scripts/meshy/optimize_glb.py` with Pillow installed. The default input is `assets-src/meshy/memory-archive/textured/archive-textured.glb`; output is `textured/archive-map.glb` plus its report. Both remain Git-ignored, outside `public/`. The optimizer refuses overwrites unless `--force` is explicit.

Verified candidate: 6,942,508 → 382,456 bytes, 94.49% smaller. Three embedded maps go from 2048² to 512². All 3730 triangles and geometry bytes are unchanged; base color, metallic/roughness and normal map slots are preserved. Resampling/reencoding is lossy; the original remains available.

## Activation and fallback

Start Vite from this worktree with `VITE_MESHY_PREVIEW=1 npm run dev -- --port 5283`. Default is disabled; production builds never request the local binary. On memory/archive/knowledge/bibliotheca/wiki wonder types only, the new model replaces the ordinary monument. Other services retain their models. Missing/invalid local GLB keeps the existing fallback.

Open `http://127.0.0.1:5283/scripts/meshy/archive-preview.html` for the isolated prop scene. This uses the actual WonderProps module and equivalent map light colors/intensities, but is not the full dashboard. `node scripts/meshy/verify-preview.mjs` checks a real WebGL load, orbit screenshot and forced-404 fallback on this port.

Renderer normalization centers the building, grounds its bounds and constrains its XZ footprint to the terrain probe. Per-instance geometry/materials are disposable; textures share the cached template. Both internal wonder signatures and the outer map renderer signature track async archive state, so the map can swap fallback after load.

## Verification performed

- 44 offline Python Meshy tests passed, including 34 optimizer tests; Ruff on `scripts/meshy` passed.
- 19 directed TypeScript tests passed; complete Vitest coverage rerun with `--maxWorkers=2` exited zero.
- TypeScript, targeted ESLint, the 19 directed tests and production build passed after the outer-signature fix.
- Actual browser harness: archive `ready`, 3754 rendered triangles including ground, 2 main render calls, 4 textures including shadow map, no page errors. Forced missing-GLB fallback also passed.
- Screenshot inspection: full stepped building, clear pale walls versus dark slate roofs, no obvious missing faces; copper/amber accents remain restrained. No full-dashboard visual verification claimed.
- The aggregate `scripts/check.sh` did NOT pass: default Vitest fork terminated unexpectedly (bounded rerun passes), and the worktree's default Python environment lacked Ruff/pytest; an early concurrent optimizer-test run also failed. Separate fresh offline tests and dedicated lint passed. Do not report this as a green complete repository gate.

No binary publication, push, merge, deployment, or additional paid generation was performed.

## Generalized to the family (2026-10-23)

`MemoryArchive3D.ts` was generalized into `src/three/FamilyBuildings3D.ts`, with the allowlist in `familyBuildingAssets.ts`. The archive keeps the same runtime copy, matching tokens, normalization and fallback. The opt-in remains `VITE_MESHY_PREVIEW=1`. It now also works in a locally built bundle served by `vite preview`, through `vite-plugins/meshyLocalAssets.ts`; no binary enters `dist/`. A default build makes no request. See [visual-family-materials-review.md](visual-family-materials-review.md).
