# Golden hashes for the 3D visual regression script.

Each file in this directory stores a SHA-256 hash of the PNG
captured by `scripts/screenshot-3d-audit.mjs` at the matching
camera position. The script compares the live hash to the golden
and fails the gate on mismatch.

**This is not a perceptual diff.** It catches layout, composition,
and shader-output regressions that change more than a couple of
pixels. It does NOT catch small tone shifts (e.g. a 1% intensity
change in the directional light). For that, the Phase 5 work
should add a perceptual comparator (e.g. pixelmatch) on top.

## Updating goldens

After an intentional visual change:

    node scripts/screenshot-3d-audit.mjs --update

This rewrites the `.sha256` files. **Always commit the goldens
in the same commit as the change** so reviewers can see the
diff in the PR.

## Cameras

The fixed camera positions live in the script itself
(`CAMERAS` array). If you need to add or move a camera, update
both the script and this README in the same commit.
