#!/usr/bin/env python3
"""Per-city alignment diagnosis — round 2.

Strategy: anchor on PLAZA centroids (which are much more reliably detected
because plazas are large flat discs at a known y=1.5), then look for
wall ring pixels in a narrow annulus around each plaza.

This avoids the problem of the wall mask catching the entire terrain
(because the wall colour and the terrain colour both end up warm-beige
after ACES tone mapping).
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage
from PIL import Image

# Re-use capture + masks from previous run if available
from playwright.sync_api import sync_playwright

OUT = Path("/home/gris/.hermes/workspace/repos/repociv/.hermes/artifacts/3d-audit")
OUT.mkdir(parents=True, exist_ok=True)


def capture():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
        ctx.add_init_script("""
        const SEED = {
          version: 1,
          selectedRepoPaths: [
            '/tmp/repociv-fixtures/repo-alpha',
            '/tmp/repociv-fixtures/repo-beta',
            '/tmp/repociv-fixtures/repo-gamma',
            '/tmp/repociv-fixtures/repo-delta',
            '/tmp/repociv-fixtures/repo-epsilon',
            '/tmp/repociv-fixtures/repo-zeta',
          ],
          filters: { owners: [], topics: [], languages: [] },
        };
        localStorage.setItem('repociv:renderer', 'webgl');
        localStorage.setItem('repociv:selected-repos:v1', JSON.stringify(SEED));
        """)
        page = ctx.new_page()
        page.goto("http://localhost:5273/?cam=auto,2.4&freeze=2&reveal=all",
                  wait_until="domcontentloaded", timeout=30_000)
        page.locator("#loading-screen").wait_for(state="hidden", timeout=20_000)
        if page.locator("#repo-onboarding").is_visible(timeout=2000):
            page.locator("#repo-onboarding-next").click()
            page.locator("#repo-onboarding").wait_for(state="hidden", timeout=20_000)
        page.wait_for_timeout(5000)
        path = OUT / "plaza-vs-ring-fresh.png"
        page.locator("#main-canvas").screenshot(path=str(path), animations="disabled", timeout=60_000)
        browser.close()
    return path


def plaza_mask_strict(arr):
    """Plaza: stepped stone dais at world y=1.5, base 0xc9bfa6.

    Disc takes ~0.46*HEX_SIZE = 24 world units. The dais renders as a fairly
    bright, warm, SATURATED beige that the tone-mapped terrain can't
    match. Tighten on saturation.
    """
    r, g, b = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)
    # Plaza lit: (201, 191, 166) → after ACES warm shift ~(195, 180, 145)
    # Plaza shaded: ~(160, 145, 110)
    # Tighter band: r in [155, 215], g in [135, 195], b in [95, 165]
    # AND must be R > G > B (warm-beige, not terrain-greenish)
    return (
        (r >= 155) & (r <= 215) &
        (g >= 135) & (g <= 195) &
        (b >=  95) & (b <= 165) &
        (r > g) & (g > b) & ((r - b) >= 15)
    )


def wall_pixels_in_annulus(arr, pcx, pcy, r_inner, r_outer):
    """Find wall-coloured pixels in an annulus around (pcx, pcy).

    Wall lit/shaded: same warm-beige family as plaza, but a bit darker
    (because the wall is at y=5.5, not y=1.5, so a bit more shadow). Wider
    tolerance and at a known offset from the plaza is what lets us isolate
    walls from the rest of the warm-beige terrain.
    """
    H, W = arr.shape[:2]
    yy, xx = np.indices((H, W))
    d = np.sqrt((xx - pcx) ** 2 + (yy - pcy) ** 2)
    in_annulus = (d >= r_inner) & (d <= r_outer)
    r, g, b = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)
    wall_like = (
        in_annulus &
        (r >= 130) & (r <= 210) &
        (g >= 115) & (g <= 185) &
        (b >=  80) & (b <= 155) &
        (r > g) & (g > b) & ((r - b) >= 15)
    )
    return wall_like, d


def find_inner_hole(wall_mask):
    """For a wall ring (closed), find the largest interior empty region
    fully enclosed by the wall.
    """
    H, W = wall_mask.shape
    interior = ~wall_mask
    # Bbox of the wall cluster
    ys, xs = np.where(wall_mask)
    if len(xs) == 0:
        return None
    bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max(), ys.max()
    labeled, n = ndimage.label(interior, structure=np.ones((3, 3)))
    if n == 0:
        return None
    sizes = ndimage.sum(interior, labeled, range(1, n + 1))
    best = None
    best_size = 0
    for i in range(1, n + 1):
        if sizes[i - 1] < 30:
            continue
        mask = (labeled == i)
        iys, ixs = np.where(mask)
        # Must be enclosed (not touching bbox edge)
        if (ixs.min() <= bx0 + 2 or ixs.max() >= bx1 - 2 or
            iys.min() <= by0 + 2 or iys.max() >= by1 - 2):
            continue
        if sizes[i - 1] > best_size:
            best_size = sizes[i - 1]
            best = mask
    return best


def sample_ring_radii(wall_mask, hole_centroid, n=12, max_r=200):
    """Ray march from hole centroid in n directions, return first wall hit."""
    cx, cy = hole_centroid
    H, W = wall_mask.shape
    radii = []
    for i in range(n):
        angle = 2 * np.pi * i / n
        dx, dy = np.cos(angle), np.sin(angle)
        for r in range(1, max_r):
            x = int(cx + dx * r)
            y = int(cy + dy * r)
            if x < 0 or y < 0 or x >= W or y >= H:
                break
            if wall_mask[y, x]:
                radii.append((i, int(np.degrees(angle)), r))
                break
    return radii


def main():
    shot = capture()
    img = np.array(Image.open(shot).convert("RGB"))
    H, W = img.shape[:2]
    print(f"Capture: {W}x{H}")

    # 1. Find PLAZAS (much more reliable — flat disc at known y, larger
    # pixel footprint, less anti-aliased).
    pm = plaza_mask_strict(img)
    print(f"Plaza pixels (strict mask): {pm.sum()}")
    labeled, n = ndimage.label(pm, structure=np.ones((3, 3)))
    sizes = ndimage.sum(pm, labeled, range(1, n + 1))
    plazas = []
    for i in range(1, n + 1):
        if sizes[i - 1] < 100:
            continue
        cluster = (labeled == i)
        ys, xs = np.where(cluster)
        bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w < 20 or h < 20:
            continue
        if max(w, h) / max(min(w, h), 1) > 3.0:
            continue  # too elongated
        cx, cy = float(xs.mean()), float(ys.mean())
        plazas.append({"id": len(plazas) + 1, "size": int(sizes[i - 1]), "bbox": bbox, "wh": (w, h), "centroid": (cx, cy)})

    plazas.sort(key=lambda p: -p["size"])
    print(f"Plaza candidates: {len(plazas)}")
    for p in plazas:
        print(f"  #{p['id']}: size={p['size']}  bbox={p['bbox']}  wh={p['wh']}  center=({p['centroid'][0]:.0f},{p['centroid'][1]:.0f})")

    # PREDICTED offset between plaza (y=1.5) and wall (y=5.5)
    # Δy = 4 world units. Camera tilt 0.62 rad. zoom 1.4 → ~14 px screen.
    PREDICTED_OFFSET_PX = 14

    # 2. For each plaza, look for walls in an annulus around it.
    # Wall outer radius in world = 0.40*HEX_SIZE = 20.8 units.
    # Plaza radius in world = 0.46*HEX_SIZE = 23.9 units (extends past wall).
    # So in screen space, the wall should be slightly INSIDE the plaza bbox.
    # Use a thin annulus: r=10-50 px around plaza centroid.
    print(f"\n=== Wall ring search (predicted projection offset ≈ {PREDICTED_OFFSET_PX}px) ===")
    reports = []
    for p in plazas:
        pcx, pcy = p["centroid"]
        # Look for wall pixels in a ring around the plaza
        # Plaza occupies r=0 to ~50 px (the disc).
        # Wall should be at r=~30-50 px (slightly inside the plaza bbox edge
        # because the wall is the inner edge of the ring, plaza is wider).
        # Try a wider annulus and find the wall.
        wm, dist = wall_pixels_in_annulus(img, pcx, pcy, r_inner=8, r_outer=70)
        if wm.sum() < 20:
            print(f"  Plaza #{p['id']}: no wall pixels in annulus (size={p['size']}, center=({pcx:.0f},{pcy:.0f})) — skipping")
            continue
        # The wall pixels in the annulus are the wall ring (or part of it).
        # Try to find the inner hole of the wall ring.
        # If the wall pixels are mostly contiguous, the hole is the empty
        # space inside the ring.
        # But the wall ring is broken by the plaza in the center, so the
        # "wall cluster" in the annulus might be split into arcs.
        # Let's just take the centroid of the wall pixels in the annulus.
        wcx, wcy, wsz = (
            float(np.where(wm)[1].mean()),
            float(np.where(wm)[0].mean()),
            int(wm.sum()),
        )
        # Plaza vs wall centroid offset
        dx = pcx - wcx
        dy = pcy - wcy
        offset_dist = (dx ** 2 + dy ** 2) ** 0.5
        # Verdict
        if offset_dist <= PREDICTED_OFFSET_PX + 10:
            verdict = f"ARTIFACT (within {PREDICTED_OFFSET_PX+10}px of predicted {PREDICTED_OFFSET_PX}px)"
        elif offset_dist <= PREDICTED_OFFSET_PX * 2:
            verdict = f"~{int(offset_dist - PREDICTED_OFFSET_PX)}px extra above projection"
        else:
            verdict = f"REAL MISALIGNMENT ({offset_dist:.0f}px ≫ {PREDICTED_OFFSET_PX}px predicted)"

        # Sample ring radii from the WALL centroid
        # (using wall centroid as center, not plaza centroid, because the
        # hole is the center of the WALL ring, which is the same as the wall
        # centroid for a symmetric ring)
        # For ring sampling, we need the actual wall mask. Build one: just
        # the wall pixels in the annulus, thresholded.
        # Need a wall cluster for ring_radii. Use the in-annulus wall mask
        # (it's a broken arc, but we can still measure where the arc is).
        ys, xs = np.where(wm)
        if len(xs) == 0:
            continue
        radii = []
        for i in range(12):
            angle = 2 * np.pi * i / 12
            dxr, dyr = np.cos(angle), np.sin(angle)
            for r in range(1, 100):
                x = int(wcx + dxr * r)
                y = int(wcy + dyr * r)
                if x < 0 or y < 0 or x >= W or y >= H:
                    break
                if wm[y, x]:
                    radii.append((i, int(np.degrees(angle)), r))
                    break
        rs = [r for _, _, r in radii]
        if len(rs) >= 4:
            rmin, rmax, rmean, rstd = min(rs), max(rs), np.mean(rs), np.std(rs)
        else:
            rmin = rmax = rmean = rstd = 0
        # Opposite-side deltas
        opp_deltas = []
        for i, ang, r in radii:
            opp_ang = (ang + 180) % 360
            m = next((r2 for _, a2, r2 in radii if a2 == opp_ang), None)
            if m is not None:
                opp_deltas.append(abs(r - m))
        max_opp = max(opp_deltas) if opp_deltas else 0

        if rstd <= 4 and rmax - rmin <= 8:
            verdict_ring = f"REGULAR (σ={rstd:.1f}px)"
        else:
            verdict_ring = f"ASYMMETRIC (σ={rstd:.1f}px, span={rmax-rmin}px)"

        rep = {
            "plaza_id": p["id"],
            "plaza_size": p["size"],
            "plaza_centroid": (round(pcx, 1), round(pcy, 1)),
            "wall_in_annulus_size": wsz,
            "wall_centroid": (round(wcx, 1), round(wcy, 1)),
            "plaza_to_wall_offset_px": (round(dx, 1), round(dy, 1)),
            "offset_magnitude": round(offset_dist, 1),
            "verdict_offset": verdict,
            "ring_radii_count": len(rs),
            "ring_min": rmin, "ring_max": rmax, "ring_mean": round(rmean, 1), "ring_std": round(rstd, 1),
            "max_opp_delta": max_opp,
            "verdict_ring": verdict_ring,
        }
        reports.append(rep)
        print(f"\n  Plaza #{p['id']} (size={p['size']}, center=({pcx:.0f},{pcy:.0f})):")
        print(f"    wall pixels in annulus: {wsz}  centroid: ({wcx:.0f},{wcy:.0f})")
        print(f"    plaza-to-wall offset: dx={dx:+.0f} dy={dy:+.0f}  magnitude={offset_dist:.0f}px")
        print(f"    → verdict: {verdict}")
        print(f"    ring radii ({len(rs)}/12 dirs hit): r ∈ [{rmin},{rmax}]  mean={rmean:.1f}  σ={rstd:.1f}px")
        print(f"    max opposite-side delta: {max_opp}px")
        print(f"    → verdict: {verdict_ring}")

    out_json = OUT / "alignment-report-r2.json"
    with open(out_json, "w") as f:
        json.dump({
            "predicted_offset_px": PREDICTED_OFFSET_PX,
            "plaza_anchored": True,
            "reports": reports,
        }, f, indent=2)
    print(f"\nFull report: {out_json}")

    print("\n=== VERDICT ===")
    if not reports:
        print("  No plaza centroids with enough wall pixels in annulus to measure.")
        sys.exit(2)
    n_artifact = sum(1 for r in reports if "ARTIFACT" in r["verdict_offset"])
    n_real = sum(1 for r in reports if "REAL" in r["verdict_offset"])
    n_regular = sum(1 for r in reports if "REGULAR" in r["verdict_ring"])
    n_asym = sum(1 for r in reports if "ASYMMETRIC" in r["verdict_ring"])
    print(f"  Plaza offset: {n_artifact}/{len(reports)} within ±10px of predicted (artifact); {n_real}/{len(reports)} real misalignment")
    print(f"  Ring symmetry: {n_regular}/{len(reports)} regular hex; {n_asym}/{len(reports)} asymmetric")
    if n_real == 0 and n_asym == 0:
        print("  → Both misalignments are PROJECTION / SAMPLING artifacts. No real bug.")
    elif n_real > 0 and n_asym == 0:
        print("  → PLAZA OFFSET is REAL. RING is fine.")
    elif n_real == 0 and n_asym > 0:
        print("  → RING ASYMMETRY is REAL. PLAZA is fine.")
    else:
        print("  → BOTH are real. Investigate.")


if __name__ == "__main__":
    main()
