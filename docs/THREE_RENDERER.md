# Three.js WebGL Map Renderer

Experimental **global map** renderer on branch `feat/3d-renderer`. The default trunk view remains **iso25d** unless you opt in.

Local office view (`localRenderer`) stays **Canvas 2D** — unchanged.

## Activation

1. Check out the branch:
   ```bash
   git checkout feat/3d-renderer
   npm install
   npm run dev
   ```

2. Enable WebGL using **any** of:
   - URL query: `http://localhost:5173/?renderer=webgl`
   - `localStorage`: `repociv:renderer=webgl` (DevTools → Application → Local Storage)
   - Hotkey **`3`**: cycles `webgl` → `iso25d` → `flat` → `webgl`
   - HUD button **box icon** (top bar)

3. Return to the default iso view:
   - Hotkey **`3`** until mode is `iso25d`, or
   - `localStorage.setItem('repociv:renderer', 'iso25d')` and reload

Hotkey **`2`** still toggles **iso25d ↔ flat** only (trunk behavior).

## Architecture

| Layer | Role |
|-------|------|
| `#three-container` | WebGL terrain, decor, cities, units |
| `#main-canvas` | Transparent overlay: selection, gestures, fog highlights |
| Minimap | Still 2D (`minimapRenderer.ts`) |

Lazy-loaded modules live under `src/three/`. Three.js is **not** bundled until WebGL mode is first activated.

## Parity checklist (branch)

- Pan / zoom (cursor-anchored) — shared `Camera` struct
- Hex picking — `HexPicker` raycast
- Fog / revealed — instance color dimming (`FogOfWar3D.ts`)
- Layers — structure / ops toggles hide decor & territory
- LOD — decor & city detail by zoom
- Units — `UnitMesh3D` instanced capsules
- Spatial gestures — canvas overlay ghosts (unchanged)
- Local view — `#three-container` hidden

## Tests

```bash
npm test -- src/three
npm run build
```

## 3D texture assets

Generated assets live in `public/assets/3d/`. Regenerate with:

```bash
npm run assets:3d
npm test -- src/three
```

The WebGL terrain shader uses:
- vertex colors as fallback/fog tint
- `terrain-atlas-3d.png` as top-face texture atlas when available (lazy loaded)
- side faces remain shader-darkened to preserve hex-prism readability
- `instanceTerrain` instanced attribute selects the atlas tile per hex
- UVs are local hex XZ coordinates mapped to [0,1]

### Generating the atlas

**Two generators exist:**

1. **Procedural fallback** (numpy — always functional):

   ```bash
   npm run assets:3d
   # Runs scripts/generate-3d-texture-atlas.py (pure numpy+PIL)
   ```

2. **Blender-baked atlas** (Civ V-style — active in `feat/3d-renderer`):

   ```bash
   python3 scripts/blender/bake_atlas.py --group a --resolution 1024 --out-resolution 512
   python3 scripts/blender/bake_atlas.py --group b --resolution 1024 --out-resolution 512
   python3 scripts/blender/bake_atlas.py --group c --resolution 1024 --out-resolution 512
   python3 scripts/blender/bake_atlas.py --group d --resolution 1024 --out-resolution 512
   ```

   Or all at once:

   ```bash
   for g in a b c d; do python3 scripts/blender/bake_atlas.py --group $g; done
   ```

   ⚠️ **`npm run assets:3d` reverts the atlas to the numpy fallback.** If you
   run it after a Blender bake, the painted plains/forest/desert/… will be
   lost. Solution: re-run the bake loops above, or `git checkout` the
   committed PNGs.

   3. **Plains post-process**: the Blender-baked `biome_plains()` renders a
      softer, painted look vs the numpy fallback. No additional blur step is
      needed — the blender bake IS the blur. If `npm run assets:3d` was
      triggered accidentally, run `bake_atlas.py --group a` to restore.

### Preview atlas (optional)

```bash
/home/gris/tools/blender/blender-5.1.2-linux-x64/blender \
  --background --factory-startup \
  --python scripts/preview-3d-texture-atlas.py
```

Renders a contact sheet to `.hermes/artifacts/terrain-atlas-preview.png`.
